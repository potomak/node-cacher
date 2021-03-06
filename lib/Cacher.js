var MIN = 60
var HOUR = MIN * 60
var DAY = HOUR * 24
var STALE_CREATED = 1
var STALE_REFRESH = 2

var HEADER_KEY = 'Cache-Control'
var NO_CACHE_KEY = 'no-cache'
var MAX_AGE_KEY = 'max-age'
var MUST_REVALIDATE_KEY = 'must-revalidate'

var EventEmitter = require('events').EventEmitter

function Cacher(opts) {
  if (!opts.memcached) throw new Error("Missing memcached client!")
  this.memcached = opts.memcached
  this.avoidCaching = opts.avoidCaching || false;
}

Cacher.prototype.__proto__ = EventEmitter.prototype

Cacher.prototype.cacheDays = function(days, opts) {
  return this.cache(DAY * days, opts)
}

Cacher.prototype.cacheDaily = function(opts) {
  return this.cache(DAY, opts)
}

Cacher.prototype.cacheHours = function(hours, opts) {
  return this.cache(HOUR * hours, opts)
}

Cacher.prototype.cacheHourly = function(opts) {
  return this.cache(HOUR, opts)
}

Cacher.prototype.cacheMinutes = function(minutes, opts) {
  return this.cache(MIN * minutes, opts)
}

Cacher.prototype.cacheOneMinute = function(opts) {
  return this.cache(MIN, opts)
}

Cacher.prototype.cache = function(ttl, opts) {
  var self = this
  opts = opts || {}
  return function(req, res, next) {
    if (self.avoidCaching) {
      return next()
    }

    var key = req.url
    var staleKey = req.url + ".stale"
    var genTime = opts.genTime || 30
    var realTtl = ttl + genTime * 2

    self.memcached.get(key, function(err, cacheObject) {
      if (err) {
        self.emit("error", err)
        return next()
      }
      // if the stale key expires, we let one request through to refresh the cache
      // this helps us avoid dog piles and herds
      self.memcached.get(staleKey, function(err, stale) {
        if (err) {
          self.emit("error", err)
          return next()
        }

        self.setHeaders(res, ttl)

        if (!stale) {
          self.memcached.set(staleKey, STALE_REFRESH, function() {}, genTime)
          cacheObject = null
        }

        if (cacheObject) {
          cacheObject = JSON.parse(cacheObject)
          self.emit("hit", key, cacheObject)
          return self.sendCached(res, cacheObject, opts)
        }

        res._responseBody = ""

        self.buildEnd(res, key, staleKey, realTtl, ttl)
        self.buildWrite(res)

        next()
        self.emit("miss", key)
      })
    })
  }
}

Cacher.prototype.setHeaders = function(res, ttl) {
  res.header(HEADER_KEY, MAX_AGE_KEY + "=" + ttl + ", " + MUST_REVALIDATE_KEY)
}

Cacher.prototype.buildEnd = function(res, key, staleKey, realTtl, ttl) {
  var origEnd = res.end
  var self = this

  res.end = function (data) {
    res._responseBody += data
    var cacheObject = {statusCode: res.statusCode, content: res._responseBody, headers: res._headers}
    self.memcached.set(key, JSON.stringify(cacheObject), function(err) {
      if (err) {
        self.emit("error", err)
      }
      self.memcached.set(staleKey, STALE_CREATED, function(err) {
        if (err) {
          self.emit("error", err)
        }
        self.emit("cache", cacheObject)
      }, ttl)
    }, realTtl)
    return origEnd.apply(null, arguments)
  }
}

Cacher.prototype.buildWrite = function(res) {
  var origWrite = res.write
  res.write = function (data) {
    res._responseBody += data
    return origWrite.apply(null, arguments)
  }
}

Cacher.prototype.sendCached = function(res, cacheObject, opts) {
  res.statusCode = cacheObject.statusCode
  for (var header in cacheObject.headers) {
    res.setHeader(header, cacheObject.headers[header])
  }

  res.end(cacheObject.content)
}

module.exports = Cacher
