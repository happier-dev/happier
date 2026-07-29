export const INJECTED_NETWORK_HELPERS = `
	  function ownerValueCaptureEnabled() {
	    return config.ownerDiagnosticsValueCapture === true;
	  }

	  function capOwnerValue(value) {
	    if (typeof value !== 'string' || !value) return undefined;
	    var cap = typeof config.ownerValueMaxLength === 'number' ? config.ownerValueMaxLength : 4096;
	    return {
	      text: value.length > cap ? value.slice(0, cap) : value,
	      truncated: value.length > cap
	    };
	  }

		  function safeOwnerHeaders(headers) {
		    var out = {};
		    if (!headers || typeof headers !== 'object') return out;
		    var safeNames = Array.isArray(config.safeTelemetryHeaderNames) ? config.safeTelemetryHeaderNames : [];
		    function isSafeName(name) {
		      return safeNames.indexOf(String(name || '').trim().toLowerCase()) >= 0;
		    }
		    Object.keys(headers).forEach(function (name) {
		      var normalized = String(name || '').trim().toLowerCase();
	      if (!normalized || !isSafeName(normalized)) return;
	      var value = headers[name];
	      if (typeof value !== 'string' || !value) return;
	      out[normalized] = capOwnerValue(value).text;
		    });
		    return out;
		  }

		  function ownerHeadersFromHeaderLike(headers) {
		    var out = {};
		    if (!headers) return out;
		    try {
		      if (typeof headers.forEach === 'function') {
		        headers.forEach(function (value, name) {
		          out[String(name || '')] = String(value || '');
		        });
		        return safeOwnerHeaders(out);
		      }
		      if (Array.isArray(headers)) {
		        headers.forEach(function (entry) {
		          if (!entry || entry.length < 2) return;
		          out[String(entry[0] || '')] = String(entry[1] || '');
		        });
		        return safeOwnerHeaders(out);
		      }
		      return safeOwnerHeaders(headers);
		    } catch (_error) {
		      return {};
		    }
		  }

	  function responseHeadersFromXhr(xhr) {
	    var raw = {};
	    if (!xhr || typeof xhr.getAllResponseHeaders !== 'function') return {};
	    try {
	      String(xhr.getAllResponseHeaders() || '').split(/\\r?\\n/).forEach(function (line) {
	        var index = line.indexOf(':');
	        if (index <= 0) return;
	        var name = line.slice(0, index).trim();
	        var value = line.slice(index + 1).trim();
	        if (name && value) raw[name] = value;
	      });
	    } catch (_error) {
	      return {};
	    }
	    return safeOwnerHeaders(raw);
	  }

	  function ownerNetworkResponseData(base, extras) {
	    var data = Object.assign({}, base);
	    if (extras.requestHeaders && Object.keys(extras.requestHeaders).length > 0) data.requestHeaders = extras.requestHeaders;
	    if (extras.responseHeaders && Object.keys(extras.responseHeaders).length > 0) data.responseHeaders = extras.responseHeaders;
	    if (extras.requestBody) {
	      data.requestBodyText = extras.requestBody.text;
	      data.requestBodyTruncated = extras.requestBody.truncated;
	    }
	    if (extras.responseBody) {
	      data.responseBodyText = extras.responseBody.text;
	      data.responseBodyTruncated = extras.responseBody.truncated;
	    }
	    return data;
	  }

	  function readOwnerResponseBodyPreview(response) {
	    if (!ownerValueCaptureEnabled() || !response || typeof response.clone !== 'function') {
	      return Promise.resolve(undefined);
	    }
	    try {
	      var clone = response.clone();
	      var body = clone && clone.body;
	      if (!body || typeof body.getReader !== 'function' || typeof TextDecoder !== 'function') {
	        return Promise.resolve(undefined);
	      }
	      var cap = typeof config.ownerValueMaxLength === 'number' ? config.ownerValueMaxLength : 4096;
	      var reader = body.getReader();
	      var decoder = new TextDecoder();
	      var text = '';
	      var truncated = false;
	      function append(chunk) {
	        if (typeof chunk !== 'string' || !chunk) return;
	        var remaining = cap - text.length;
	        if (remaining <= 0) {
	          truncated = true;
	          return;
	        }
	        if (chunk.length > remaining) {
	          text += chunk.slice(0, remaining);
	          truncated = true;
	          return;
	        }
	        text += chunk;
	      }
	      function cancelReader() {
	        try {
	          if (typeof reader.cancel === 'function') {
	            reader.cancel();
	          }
	        } catch (_error) {
	          // Best effort; diagnostics must never disturb the page response.
	        }
	      }
	      function readNext() {
	        if (truncated || text.length >= cap) {
	          truncated = true;
	          cancelReader();
	          return Promise.resolve({ text: text, truncated: true });
	        }
	        return reader.read().then(function (result) {
	          if (result && result.done) {
	            try {
	              append(decoder.decode());
	            } catch (_error) {
	              // Ignore decoder flush failures for diagnostics preview.
	            }
	            return { text: text, truncated: truncated };
	          }
	          try {
	            append(decoder.decode(result && result.value, { stream: true }));
	          } catch (_error) {
	            return undefined;
	          }
	          return readNext();
	        }, function () {
	          return undefined;
	        });
	      }
	      return readNext();
	    } catch (_error) {
	      return Promise.resolve(undefined);
	    }
	  }

`;

export const INJECTED_NETWORK_INTERCEPTORS = `
  var originalFetch = typeof window.fetch === 'function' ? window.fetch : null;
  var originalXMLHttpRequest = typeof window.XMLHttpRequest === 'function' ? window.XMLHttpRequest : null;
  if (originalXMLHttpRequest) {
    var InstrumentedXMLHttpRequest = function () {
      var xhr = new originalXMLHttpRequest();
      var method = 'GET';
      var url = '';
      var requestEventId = '';
      var requestStarted = false;
	      var settled = false;
	      var originalOpen = xhr.open;
	      var originalSend = xhr.send;
	      var originalSetRequestHeader = xhr.setRequestHeader;
	      var requestHeaders = {};
	      var requestBody;

      function postRequestStarted() {
        if (requestStarted) return;
        requestStarted = true;
        requestEventId = eventId('network.requestStarted');
        postEvents([Object.assign(baseEvent('network', 'network.requestStarted', {
          requestId: requestEventId,
          url: sanitizeUrl(url),
          method: method
        }), { eventId: requestEventId })]);
      }

	      function postFinished() {
	        if (settled) return;
	        settled = true;
	        if (ownerValueCaptureEnabled()) {
	          var responseBody;
	          try {
	            responseBody = capOwnerValue(typeof xhr.responseText === 'string' ? xhr.responseText : '');
	          } catch (_error) {
	            responseBody = undefined;
	          }
	          var responseEvent = baseEvent('network', 'network.response', ownerNetworkResponseData({
	            requestId: requestEventId,
	            method: method,
	            url: sanitizeUrl(url),
	            statusCode: Number(xhr.status || 0),
	            requestBytes: requestBody ? byteLengthOf(requestBody.text) : 0,
	            responseBytes: responseBody ? byteLengthOf(responseBody.text) : 0
	          }, {
	            requestHeaders: safeOwnerHeaders(requestHeaders),
	            responseHeaders: responseHeadersFromXhr(xhr),
	            requestBody: requestBody,
	            responseBody: responseBody
	          }));
	          responseEvent.redaction.level = 'none';
	          postEvents([responseEvent]);
	        }
	        postEvents([baseEvent('network', 'network.finished', {
	          requestId: requestEventId,
	          statusCode: Number(xhr.status || 0)
	        })]);
	      }

      function postFailed() {
        if (settled) return;
        settled = true;
        var failedEvent = baseEvent('network', 'network.failed', {
          requestAvailable: requestStarted,
          errorAvailable: true
        });
        failedEvent.redaction.level = 'valuesRedacted';
        postEvents([failedEvent]);
      }

      if (typeof originalOpen === 'function') {
        xhr.open = function (methodArg, urlArg) {
          method = String(methodArg || 'GET');
          url = typeof urlArg === 'string' ? urlArg : String(urlArg || '');
	          return originalOpen.apply(xhr, arguments);
	        };
	      }
	      if (typeof originalSetRequestHeader === 'function') {
	        xhr.setRequestHeader = function (name, value) {
	          try {
	            requestHeaders[String(name || '')] = String(value || '');
	          } catch (_error) {
	            // Ignore page-owned header coercion failures.
	          }
	          return originalSetRequestHeader.apply(xhr, arguments);
	        };
	      }
	      if (typeof originalSend === 'function') {
	        xhr.send = function (body) {
	          postRequestStarted();
	          requestBody = ownerValueCaptureEnabled() ? capOwnerValue(typeof body === 'string' ? body : '') : undefined;
	          try {
	            return originalSend.apply(xhr, arguments);
          } catch (error) {
            postFailed();
            throw error;
          }
        };
      }
      if (typeof xhr.addEventListener === 'function') {
        xhr.addEventListener('loadend', postFinished);
        xhr.addEventListener('error', postFailed);
        xhr.addEventListener('abort', postFailed);
        xhr.addEventListener('timeout', postFailed);
      }

      return xhr;
    };
    try {
      InstrumentedXMLHttpRequest.prototype = originalXMLHttpRequest.prototype;
    } catch (_error) {
      // Leave constructor compatibility best-effort for page-owned globals.
    }
    try {
      if (typeof Object.setPrototypeOf === 'function') {
        Object.setPrototypeOf(InstrumentedXMLHttpRequest, originalXMLHttpRequest);
      }
    } catch (_error) {
      // Static XHR constants are diagnostic compatibility only.
    }
    try {
      ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (name) {
        if (name in originalXMLHttpRequest) {
          InstrumentedXMLHttpRequest[name] = originalXMLHttpRequest[name];
        }
      });
    } catch (_error) {
      // Static XHR constants are diagnostic compatibility only.
    }
    window.XMLHttpRequest = InstrumentedXMLHttpRequest;
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : String(input && input.url || '');
      var method = String(init && init.method || input && input.method || 'GET');
      var requestEventId = eventId('network.requestStarted');
      var requestHeaders = ownerValueCaptureEnabled()
        ? ownerHeadersFromHeaderLike(init && init.headers || input && input.headers)
        : {};
      var requestBody = ownerValueCaptureEnabled() && init && typeof init.body === 'string'
        ? capOwnerValue(init.body)
        : undefined;
      postEvents([Object.assign(baseEvent('network', 'network.requestStarted', {
        requestId: requestEventId,
        url: sanitizeUrl(url),
        method: method
      }), { eventId: requestEventId })]);
      return originalFetch.apply(this, arguments).then(function (response) {
        function postFinished(responseBody) {
          if (ownerValueCaptureEnabled()) {
            var responseEvent = baseEvent('network', 'network.response', ownerNetworkResponseData({
              requestId: requestEventId,
              method: method,
              url: sanitizeUrl(url),
              statusCode: response && response.status,
              requestBytes: byteLengthOf(init && init.body),
              responseBytes: responseBody ? responseBody.text.length : undefined
            }, {
              requestHeaders: requestHeaders,
              responseHeaders: ownerHeadersFromHeaderLike(response && response.headers),
              requestBody: requestBody,
              responseBody: responseBody
            }));
            responseEvent.redaction.level = 'none';
            postEvents([responseEvent]);
          }
          postEvents([baseEvent('network', 'network.finished', {
            requestId: requestEventId,
            statusCode: response && response.status
          })]);
        }
        if (ownerValueCaptureEnabled() && response && typeof response.clone === 'function') {
          return readOwnerResponseBodyPreview(response).then(function (bodyPreview) {
            postFinished(bodyPreview);
            return response;
          }, function () {
            postFinished(undefined);
            return response;
          });
        }
        postFinished(undefined);
        return response;
      }, function (error) {
        var failedEvent = baseEvent('network', 'network.failed', {
          requestAvailable: true,
          errorAvailable: Boolean(error)
        });
        failedEvent.redaction.level = 'valuesRedacted';
        postEvents([failedEvent]);
        throw error;
      });
    };
  }

  var socketSeq = 0;
  var sourceSeq = 0;

  function byteLengthOf(value) {
    try {
      if (typeof value === 'string') return value.length;
      if (value && typeof value.byteLength === 'number') return value.byteLength;
      if (value && typeof value.size === 'number') return value.size;
    } catch (_error) {
      // Best-effort byte accounting only; never read payload contents.
    }
    return 0;
  }

  var originalWebSocket = typeof window.WebSocket === 'function' ? window.WebSocket : null;
  if (originalWebSocket) {
    var InstrumentedWebSocket = function (url, protocols) {
      var socket = arguments.length > 1
        ? new originalWebSocket(url, protocols)
        : new originalWebSocket(url);
      socketSeq += 1;
      var socketId = config.viewId + ':' + config.navigationGeneration + ':ws:' + socketSeq;
      var framesSent = 0;
      var framesReceived = 0;
      var bytesSent = 0;
      var bytesReceived = 0;
      var messageCount = 0;
      var summaryPosted = false;

      // The raw WS subprotocol value is a credential-egress vector (clients smuggle bearer tokens
      // through it). Report presence and count only, never the value (the egress classifier marks
      // the protocol field as always-strip).
      var protocolCount = typeof protocols === 'string'
        ? (protocols ? 1 : 0)
        : (Array.isArray(protocols) ? protocols.length : 0);
      postEvents([baseEvent('network', 'network.websocketOpened', {
        socketId: socketId,
        url: sanitizeUrl(typeof url === 'string' ? url : String(url || '')),
        ...(protocolCount > 0 ? { hasProtocol: true, protocolCount: protocolCount } : {})
      })]);

      function postSummary(state) {
        postEvents([baseEvent('network', 'network.websocketSummary', {
          socketId: socketId,
          state: state,
          framesSent: framesSent,
          framesReceived: framesReceived,
          bytesSent: bytesSent,
          bytesReceived: bytesReceived,
          messageCount: messageCount
        })]);
      }

      try {
        socket.addEventListener('open', function () {
          summaryPosted = true;
          postSummary('open');
        });
        socket.addEventListener('message', function (messageEvent) {
          framesReceived += 1;
          messageCount += 1;
          bytesReceived += byteLengthOf(messageEvent && messageEvent.data);
          if (!summaryPosted) {
            summaryPosted = true;
          }
          postSummary('open');
        });
        socket.addEventListener('close', function (closeEvent) {
          postEvents([baseEvent('network', 'network.websocketClosed', {
            socketId: socketId,
            code: Number(closeEvent && closeEvent.code || 0),
            wasClean: Boolean(closeEvent && closeEvent.wasClean)
          })]);
        });
        socket.addEventListener('error', function () {
          postSummary('closed');
        });
      } catch (_error) {
        // Page-owned WebSocket implementations may not support listeners.
      }

      var originalSend = socket.send;
      if (typeof originalSend === 'function') {
        socket.send = function (data) {
          framesSent += 1;
          bytesSent += byteLengthOf(data);
          return originalSend.apply(socket, arguments);
        };
      }

      return socket;
    };
    try {
      InstrumentedWebSocket.prototype = originalWebSocket.prototype;
    } catch (_error) {
      // Leave prototype wiring best-effort for page-owned globals.
    }
    try {
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (name) {
        if (name in originalWebSocket) {
          InstrumentedWebSocket[name] = originalWebSocket[name];
        }
      });
    } catch (_error) {
      // Static socket constants are diagnostic compatibility only.
    }
    window.WebSocket = InstrumentedWebSocket;
  }

  var originalEventSource = typeof window.EventSource === 'function' ? window.EventSource : null;
  if (originalEventSource) {
    var InstrumentedEventSource = function (url, eventSourceInit) {
      var source = arguments.length > 1
        ? new originalEventSource(url, eventSourceInit)
        : new originalEventSource(url);
      sourceSeq += 1;
      var sourceId = config.viewId + ':' + config.navigationGeneration + ':es:' + sourceSeq;
      var messageCount = 0;
      var bytesReceived = 0;

      postEvents([baseEvent('network', 'network.eventSourceOpened', {
        sourceId: sourceId,
        url: sanitizeUrl(typeof url === 'string' ? url : String(url || ''))
      })]);

      try {
        source.addEventListener('open', function () {
          postEvents([baseEvent('network', 'network.eventSourceSummary', {
            sourceId: sourceId,
            state: 'open',
            messageCount: messageCount,
            bytesReceived: bytesReceived
          })]);
        });
        source.addEventListener('message', function (messageEvent) {
          messageCount += 1;
          bytesReceived += byteLengthOf(messageEvent && messageEvent.data);
          postEvents([baseEvent('network', 'network.eventSourceSummary', {
            sourceId: sourceId,
            state: 'open',
            messageCount: messageCount,
            bytesReceived: bytesReceived
          })]);
        });
        source.addEventListener('error', function () {
          var readyState = Number(source && source.readyState);
          postEvents([baseEvent('network', 'network.eventSourceClosed', {
            sourceId: sourceId,
            state: readyState === 2 ? 'closed' : 'connecting'
          })]);
        });
      } catch (_error) {
        // Page-owned EventSource implementations may not support listeners.
      }

      return source;
    };
    try {
      InstrumentedEventSource.prototype = originalEventSource.prototype;
    } catch (_error) {
      // Leave prototype wiring best-effort for page-owned globals.
    }
    try {
      ['CONNECTING', 'OPEN', 'CLOSED'].forEach(function (name) {
        if (name in originalEventSource) {
          InstrumentedEventSource[name] = originalEventSource[name];
        }
      });
    } catch (_error) {
      // Static source constants are diagnostic compatibility only.
    }
    window.EventSource = InstrumentedEventSource;
  }

  var beaconNavigator = (function () {
    try {
      return window.navigator || null;
    } catch (_error) {
      return null;
    }
  })();
  var originalSendBeacon = beaconNavigator && typeof beaconNavigator.sendBeacon === 'function'
    ? beaconNavigator.sendBeacon
    : null;
  var beaconSeq = 0;
  if (originalSendBeacon) {
    beaconNavigator.sendBeacon = function (beaconUrl, data) {
      beaconSeq += 1;
      var requestId = config.viewId + ':' + config.navigationGeneration + ':beacon:' + beaconSeq;
      var accepted = true;
      try {
        accepted = Boolean(originalSendBeacon.apply(beaconNavigator, arguments));
        return accepted;
      } catch (error) {
        accepted = false;
        throw error;
      } finally {
        // Metadata only: the sanitized destination URL and a queued-byte count.
        // The beacon payload body is NEVER read into diagnostics.
        postEvents([baseEvent('network', 'network.sendBeacon', {
          requestId: requestId,
          url: sanitizeUrl(typeof beaconUrl === 'string' ? beaconUrl : String(beaconUrl || '')),
          bytesQueued: byteLengthOf(data),
          accepted: accepted
        })]);
      }
    };
  }

`;
