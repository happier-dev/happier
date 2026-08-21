/**
 * Are these two URLs the same server?
 *
 * **The question this answers: identity.** Its correctness criterion is being
 * stable and conservative, not being accurate about networking — the key is
 * persisted and it gates access. `apps/cli/src/persistence.ts` turns it into
 * `allowedServerIds`, which decides *which stored credentials this machine may
 * use*, and `apps/cli/src/configuration.ts` uses it to normalize daemon env.
 * Two hosts collapse to one key only when treating them as one server is safe
 * for everything downstream of that.
 *
 * It is NOT the answer to "can another device reach this URL?". That is
 * `isLoopbackHostname` in `./loopbackHostname.ts`, which is broader on purpose:
 * it covers all of `127.0.0.0/8`, while `normalizeLoopbackHost` below collapses
 * only `127.0.0.1`. So `127.0.0.2` is unreachable-from-elsewhere *and* a
 * distinct server — someone running two local relays keeps two credential
 * scopes. That divergence is deliberate and pinned by
 * `./loopbackReachabilityVsIdentity.test.ts`; widening this one to match the
 * reachability predicate silently merges those scopes.
 */

const SERVER_URL_PROTOCOL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export const SERVER_URL_COMPARABLE_KEY_ERROR_CODE = 'invalid_server_url' as const;

export class ServerUrlComparableKeyError extends Error {
  readonly code = SERVER_URL_COMPARABLE_KEY_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'ServerUrlComparableKeyError';
  }
}

/**
 * The loopback spellings that name one and the same local server.
 *
 * Intentionally narrower than reachability: only `127.0.0.1` collapses, not the
 * rest of `127.0.0.0/8`. See this module's header before widening it.
 */
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
