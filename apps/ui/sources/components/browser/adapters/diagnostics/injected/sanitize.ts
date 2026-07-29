export const INJECTED_SANITIZE_RUNTIME = `
  var redactedPathSegment = ':redacted';
  var uuidPathSegmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var percentEscapePattern = /%[0-9a-f]{2}/i;
  var schemeOnlyValuePattern = /^(?:data|javascript|vbscript|blob|filesystem|file|ftp|mailto|tel|sms|intent|chrome|chrome-extension|about):/i;

  function isTokenShapedPathChunk(chunk) {
    if (chunk.length >= 20 && /^[0-9a-f]+$/i.test(chunk)) return true;
    if (chunk.length >= 16 && /^[0-9]+$/.test(chunk)) return true;
    return chunk.length >= 12
      && /^[A-Za-z0-9_~+=%]+$/.test(chunk)
      && /[0-9]/.test(chunk)
      && /[A-Za-z]/.test(chunk);
  }

  function isSensitivePathSegment(segment) {
    var decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch (_error) {
      decoded = segment;
    }
    if (uuidPathSegmentPattern.test(decoded)) return true;
    return decoded.split(/[-._]/).some(isTokenShapedPathChunk);
  }

  function redactSensitivePathSegments(pathname) {
    if (!pathname) return pathname;
    return pathname.split('/').map(function (segment) {
      return segment && isSensitivePathSegment(segment) ? redactedPathSegment : segment;
    }).join('/');
  }

  function decodePercentEncodedValue(value) {
    if (!percentEscapePattern.test(value)) return null;
    try {
      var decoded = decodeURIComponent(value);
      return decoded === value ? null : decoded;
    } catch (_error) {
      return null;
    }
  }

  function decodedValueLooksUrlShaped(decoded) {
    return /^(?:https?|wss?):\\/\\//i.test(decoded)
      || schemeOnlyValuePattern.test(decoded)
      || decoded.charAt(0) === '/'
      || decoded.indexOf('/') !== -1;
  }

  function decodeWholeUrlShapedValue(value) {
    var decoded = decodePercentEncodedValue(value);
    return decoded && decodedValueLooksUrlShaped(decoded) ? decoded : null;
  }

  function sanitizeUrl(value) {
    try {
      var url = String(value || '');
      if (!url) return '';
      var decoded = decodeWholeUrlShapedValue(url);
      if (decoded) return sanitizeUrl(decoded);
      if (/^[a-zA-Z][a-zA-Z\\d+.-]*:/.test(url)) {
        var parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
          return parsed.protocol;
        }
        return parsed.origin + redactSensitivePathSegments(parsed.pathname);
      }
      if (url.charAt(0) === '/') {
        return redactSensitivePathSegments(new URL(url, 'https://happier.invalid').pathname);
      }
      return redactSensitivePathSegments(url.split(/[?#]/)[0] || url);
    } catch (_error) {
      var schemeMatch = String(value || '').match(/^([a-zA-Z][a-zA-Z\\d+.-]*:)/);
      if (schemeMatch) return schemeMatch[1];
      return redactSensitivePathSegments(String(value || '').split(/[?#]/)[0] || '');
    }
  }

`;
