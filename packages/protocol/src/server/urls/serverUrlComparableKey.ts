const SERVER_URL_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export const SERVER_URL_COMPARABLE_KEY_ERROR_CODE = 'invalid_server_url' as const;

export class ServerUrlComparableKeyError extends Error {
  readonly code = SERVER_URL_COMPARABLE_KEY_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'ServerUrlComparableKeyError';
  }
}

function normalizeLoopbackHost(rawHost: string): string {
  const host = String(rawHost ?? '').trim().toLowerCase().replace(/\.$/, '');

  if (
    host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.localhost')
  ) {
    return 'localhost';
  }

  return host;
}

function resolveComparablePort(protocol: string, explicitPort: string): string {
  if (!explicitPort) {
    return '';
  }

  if (protocol === 'https:' && explicitPort === '443') {
    return '';
  }

  if (protocol === 'http:' && explicitPort === '80') {
    return '';
  }

  return `:${explicitPort}`;
}

function parseServerUrlForIdentity(rawUrl: string): URL {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    throw new ServerUrlComparableKeyError('Invalid server URL: empty input');
  }

  const candidate = SERVER_URL_PROTOCOL_PATTERN.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ServerUrlComparableKeyError(`Invalid server URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServerUrlComparableKeyError(`Invalid server URL protocol: ${parsed.protocol}`);
  }

  return parsed;
}

export function canonicalizeServerUrlForIdentity(url: string): string {
  const parsed = parseServerUrlForIdentity(url);
  const protocol = parsed.protocol.toLowerCase();
  const host = normalizeLoopbackHost(parsed.hostname);
  const port = resolveComparablePort(protocol, parsed.port);

  return `${protocol}//${host}${port}`;
}

export function createServerUrlComparableKey(url: string): string {
  return canonicalizeServerUrlForIdentity(url);
}
