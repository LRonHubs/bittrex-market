const EventEmitter = require('events')
const queue = require('emitter-queue')
const _ = require('lodash')
const moment = require('moment')
const assert = require('assert')

const ASKS = 0
const BIDS = 1

class Market extends EventEmitter {
    constructor(currencyPair, manager, replayHistory) {
        super()
        queue(this)

        this.currencyPair = currencyPair
        this.ready = false
        this._initialized = false
        this._orderBook = [{}, {}]
        this._orderList = [[], []]
        this._deltaQueue = []
        this._replayHistory = replayHistory

        if(replayHistory) {
            this._lastFillTime = new Date(0)
        }
        else {
            this._lastFillTime = null
        }
    }

    get bids() {
        return this._orderList[BIDS]
    }

    get asks() {
        return this._orderList[ASKS]
    }

    _initialize(marketState) {
        //set initial state
        this._updateOrderbook(marketState)

        //enable updates to be processed directly
        this._initialized = true

        //apply queued updates on top
        _.each(this._deltaQueue, (deltaMessage) => {
            if(deltaMessage.Nounce >= marketState.Nounce) {
                this._processDeltaMessage(deltaMessage)
            }
        })

        //clear delta queue
        this._deltaQueue = []

        //check if we've already received fill messages
        //this indicates a reconnect. In this case we want to replay all missed fills after this timestamp
        if(this._lastFillTime != null) {
            const missedFills = []
            _.each(marketState.Fills, (fill) => {
                const fillTime = moment.utc(fill.TimeStamp)
                if(fillTime > this._lastFillTime) {
                    //transfrom message to conform to the same format
                    fill.Rate = fill.Price

                    missedFills.push(fill)
                }
            })

            if(missedFills.length > 0) {
                this._publishFills(missedFills)
            }
        }

        if(!this.ready) {
            this.ready = true
            this.emit('ready')
        }
    }

    _publishFills(fills) {
        if(fills.length > 0) {
            this._lastFillTime = moment.utc(fills[fills.length - 1].TimeStamp)
            const formattedFills =  _.map(fills, (fill) => {
                return {
                    'orderType': fill.OrderType,
                    'quantity': fill.Quantity,
                    'rate': fill.Rate,
                    'dateTime': moment.utc(fill.TimeStamp)
                }
            })

            if(this._replayHistory) {
                this.queue('fills', formattedFills)
            }
            else {
                this.emit('fills', formattedFills)
            }
        }
    }

    _getIndex(side, rate) {
        return _.sortedIndexBy(this._orderList[side], [rate], (order) => {
            if(side === ASKS) {
                return order[0]
            }
            else {
                return -order[0]
            }
        })
    }

    _updateOrderbook(message) {
	if(!message.Buys || !message.Sells) return

        this._updateOrderbookSide(BIDS, message.Buys)
        this._updateOrderbookSide(ASKS, message.Sells)

        if(message.Sells.length > 0 || message.Buys.length > 0) {
            this.emit('orderbookUpdated')
        }
    }

    _insertOrUpdate(side, entry) {
        const index = this._getIndex(side, entry.Rate)
        const updateOrInsert = entry.Rate in this._orderBook[side] ? 1 : 0
        this._orderList[side].splice(index, updateOrInsert, [entry.Rate, entry.Quantity])
        this._orderBook[side][entry.Rate] = entry.Quantity
    }

    _remove(side, entry) {
        const index = this._getIndex(side, entry.Rate)
        this._orderList[side].splice(index, 1)
        delete this._orderBook[side][entry.Rate]
    }

    _updateOrderbookSide(side, entries) {
        _.each(entries, (entry) => {
            entry.Type === 1
                ? this._remove(side, entry)
                : this._insertOrUpdate(side, entry)
        })
    }

    _processDeltaMessage(deltaMessage) {
        if(!this._initialized) {
            this._deltaQueue.push(deltaMessage)
        }
        else {
            this._updateOrderbook(deltaMessage)
            this._publishFills(deltaMessage.Fills)
        }
    }
}

module.exports = Market
