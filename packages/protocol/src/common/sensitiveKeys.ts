const UNSAFE_TELEMETRY_KEY_EXACT = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'request-body',
  'response-body',
  'body',
  'payload',
  'payload-base64',
  'websocket-payload',
  'frame-payload',
  'local-storage',
  'session-storage',
  'indexed-db',
  'token',
  'api-key',
  'password',
  'preview-token',
  'public-token',
  'grant-token',
  'inline-bytes',
  'inline-bytes-base64',
  'base64',
]);

const UNSAFE_TELEMETRY_KEY_COMPACT = new Set(
  [...UNSAFE_TELEMETRY_KEY_EXACT].map((key) => key.replaceAll('-', '')),
);

const BASE_CREDENTIAL_SINGLE_SEGMENTS = new Set([
  'authorization',
  'password',
  'cookie',
  'jwt',
  'passphrase',
  'x-user-id',
  'chatgpt-account-id',
]);

const BASE_CREDENTIAL_SEGMENT_SEQUENCES: readonly (readonly string[])[] = [
  ['access', 'token'],
  ['refresh', 'token'],
  ['api', 'key'],
  ['client', 'secret'],
  ['private', 'key'],
];

const BASE_CREDENTIAL_COMPACT_KEYS = new Set(
  BASE_CREDENTIAL_SEGMENT_SEQUENCES.map((sequence) => sequence.join('')),
);

/**
 * Separates a diagnostic key into words without treating a credential-looking
 * substring as evidence. This recognizes the casing and delimiters callers
 * actually use (`accessToken`, `access_token`, and `ACCESS-TOKEN`) while
 * keeping unrelated names such as `tokenCount` and `secretary` distinct.
 */
export function splitSensitiveDiagnosticKeySegments(input: string): readonly string[] {
  const normalized = input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
  return normalized.split(/[^a-z0-9]+/u).filter(Boolean);
}

function containsSegmentSequence(
  segments: readonly string[],
  sequence: readonly string[],
): boolean {
  for (let index = 0; index <= segments.length - sequence.length; index += 1) {
    if (sequence.every((segment, offset) => segments[index + offset] === segment)) return true;
  }
  return false;
}

/**
 * The shared, deliberately small credential-key vocabulary. Callers retain
 * their own boundary vocabulary (HTTP headers, process flags, SCM headers,
 * and runtime-only IDs) rather than widening this base through substrings.
 */
export function isBaseCredentialDiagnosticKey(input: string): boolean {
  const normalized = normalizeTelemetryDataKey(input);
  if (BASE_CREDENTIAL_SINGLE_SEGMENTS.has(normalized)) return true;
  const segments = splitSensitiveDiagnosticKeySegments(input);
  return segments.some((segment) => BASE_CREDENTIAL_SINGLE_SEGMENTS.has(segment))
    || BASE_CREDENTIAL_SEGMENT_SEQUENCES.some((sequence) => (
      containsSegmentSequence(segments, sequence)
    ))
    || BASE_CREDENTIAL_COMPACT_KEYS.has(segments.join(''));
}

export function normalizeTelemetryDataKey(input: string): string {
  return input.trim().replaceAll('_', '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

export function isUnsafeTelemetryDataKey(input: string): boolean {
  const normalized = normalizeTelemetryDataKey(input);
  const compact = normalized.replaceAll('-', '');

  if (UNSAFE_TELEMETRY_KEY_EXACT.has(normalized) || UNSAFE_TELEMETRY_KEY_COMPACT.has(compact)) {
    return true;
  }

  return (
    normalized.endsWith('-authorization')
    || compact.endsWith('authorization')
    || normalized.endsWith('-api-key')
    || compact.endsWith('apikey')
    || normalized.endsWith('-token')
    || compact.endsWith('token')
    || normalized.endsWith('-payload')
    || compact.endsWith('payload')
    || normalized.endsWith('-body')
    || compact.endsWith('body')
  );
}
