export {
  classifyBrowserDiagnosticField,
  classifyBrowserDiagnosticFieldForDestination,
  resolveRedactionLevel,
  INJECTED_EVENT_ALLOWED_FIELDS,
  INJECTED_OWNER_ONLY_FIELDS,
  INJECTED_CONSOLE_TEXT_MAX_LENGTH,
  INJECTED_OWNER_VALUE_MAX_LENGTH,
  ALWAYS_STRIP_FIELD_NAMES,
  type BrowserDiagnosticFieldDisposition,
  type BrowserDiagnosticEgressDestination,
} from './classifier.js';
export {
  isForbiddenBrowserEgressKey,
  rejectUnsafeBrowserEgressKeys,
  type RejectUnsafeBrowserEgressKeysOptions,
} from './keyRejection.js';
export {
  isSensitiveUrlPathSegment,
  redactSensitiveUrlPathSegments,
  stripBrowserDiagnosticUrlValues,
  stripUrlValuesInString,
  SANITIZE_URL_PARITY_VECTORS,
} from './url.js';
export {
  SAFE_TELEMETRY_HEADER_NAMES,
  isSafeTelemetryHeaderName,
  normalizeTelemetryHeaderName,
  redactDiagnosticsHeaders,
  redactDiagnosticsUrl,
  type TelemetryHeaders,
  type RedactedDiagnosticsUrl,
} from './headers.js';
