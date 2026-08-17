/**
 * One rule for "which URL may a managed service be reached at", shared by the
 * settings layer that accepts the value and the daemon that dials it. Two
 * surfaces disagreeing here is exactly how a URL becomes saveable but not
 * attachable, so both read this module.
 *
 * Two policies, because two different things are being described:
 *
 * - `ownedLoopback` — an endpoint Happier itself allocated for a process it
 *   spawned. The port is host-allocated and the listener is on this machine, so
 *   a non-loopback or non-`http:` value is a defect, not a preference.
 * - `userDeclaredAttach` — a server the user runs and points Happier at.
 *   `https:` may use any valid hostname, while plain `http:` stays limited to
 *   the same loopback names as an owned local service. This is a pure URL
 *   policy: it does not resolve DNS or classify private networks.
 *
 * Both policies reject a URL carrying `username`/`password`. A secret travels
 * in the `authorization` header, never in a URL that gets normalized,
 * snapshotted, logged and projected to disk.
 */

export type ManagedServiceEndpointHostPolicy =
  | 'ownedLoopback'
  | 'userDeclaredAttach';

export type ManagedServiceEndpointUrlFacts = Readonly<{
  /** The URL with any trailing slash removed, suitable for path joining. */
  baseUrl: string;
  /** Hostname with IPv6 brackets stripped. */
  host: string;
  /** Explicit port, or the scheme default (`http:` 80, `https:` 443). */
  port: number;
}>;

/**
 * Why a URL was refused. Callers map these to their own user-facing wording;
 * the rule itself has one owner.
 */
export type ManagedServiceEndpointUrlRejection =
  | 'malformed'
  | 'scheme'
  | 'embeddedCredentials'
  | 'host'
  | 'queryOrFragment'
  | 'port';

export type ManagedServiceEndpointUrlResult =
  | Readonly<{ ok: true; endpoint: ManagedServiceEndpointUrlFacts }>
  | Readonly<{ ok: false; rejection: ManagedServiceEndpointUrlRejection }>;

const DEFAULT_PORT_BY_PROTOCOL = Object.freeze<Record<string, number>>({
  'http:': 80,
  'https:': 443,
});

const MAX_ENDPOINT_URL_LENGTH = 10_000;

function rejected(
  rejection: ManagedServiceEndpointUrlRejection,
): ManagedServiceEndpointUrlResult {
  return Object.freeze({ ok: false, rejection });
}

export function isManagedServiceLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

export function managedServiceEndpointHostPolicyForMode(
  mode: 'spawn' | 'attach' | 'managedSpawn' | 'externalAttach',
): ManagedServiceEndpointHostPolicy {
  return mode === 'attach' || mode === 'externalAttach'
    ? 'userDeclaredAttach'
    : 'ownedLoopback';
}

export function readManagedServiceEndpointUrl(
  value: unknown,
  options: Readonly<{
    hostPolicy: ManagedServiceEndpointHostPolicy;
    allowSearch?: boolean;
    allowHash?: boolean;
  }>,
): ManagedServiceEndpointUrlResult {
  if (typeof value !== 'string') return rejected('malformed');
  const raw = value.trim();
  if (!raw || raw.length > MAX_ENDPOINT_URL_LENGTH) return rejected('malformed');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return rejected('malformed');
  }
  const schemeAllowed = options.hostPolicy === 'userDeclaredAttach'
    ? (url.protocol === 'http:' || url.protocol === 'https:')
    : url.protocol === 'http:';
  if (!schemeAllowed) return rejected('scheme');
  if (url.username !== '' || url.password !== '') {
    return rejected('embeddedCredentials');
  }
  if (
    (options.allowSearch !== true && url.search !== '')
    || (options.allowHash !== true && url.hash !== '')
  ) return rejected('queryOrFragment');
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (host === '') return rejected('host');
  if (
    (options.hostPolicy === 'ownedLoopback' || url.protocol === 'http:')
    && !isManagedServiceLoopbackHostname(host)
  ) return rejected('host');
  const port = url.port === ''
    ? DEFAULT_PORT_BY_PROTOCOL[url.protocol]
    : Number(url.port);
  if (
    port === undefined
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
  ) return rejected('port');
  return Object.freeze({
    ok: true,
    endpoint: Object.freeze({
      baseUrl: url.toString().replace(/\/$/u, ''),
      host,
      port,
    }),
  });
}
