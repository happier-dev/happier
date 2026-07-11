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
