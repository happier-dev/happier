import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';
import { areNetworkAddressesPublic } from '@/plugins/distribution/npm/networkPolicy';
import { awaitPluginAcquisition, createPluginAcquisitionLifetime } from '@/plugins/distribution/acquisitionLifetime';

/**
 * The one destination-assessed acquisition path for remote plugin material.
 *
 * Every caller that reaches an author-named or catalog-named HTTP destination
 * shares it: redirects are processed here rather than by the transport, each
 * hop is resolved and classified before a socket opens, and the connection is
 * pinned to the addresses this owner assessed so a name cannot resolve public
 * for the check and private for the connection.
 *
 * The npm registry client keeps its own transport because it streams through
 * `node:https` with registry auth headers and signature material;
 * it consumes the same address classifier this owner does.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type RemoteAcquisitionDestinationPolicy = Readonly<{
  /** `https` refuses plain HTTP outright; `httpOrHttps` admits both schemes. */
  scheme: 'https' | 'httpOrHttps';
  /**
   * `sameOrigin` keeps every hop on the origin the caller named.
   * `anyAssessedOrigin` admits a cross-origin redirect — a published archive
   * routinely lands on a separate object host — but only to a hop this owner
   * has itself resolved and classified.
   */
  redirects: 'sameOrigin' | 'anyAssessedOrigin';
  /**
   * `refuse` requires every hop, including the first, to resolve public.
   * `followCallerDestination` treats the destination the caller named as the
   * current user's own network intent: when that first hop resolves inside a
   * private, loopback or reserved range the rest of the chain may stay there,
   * and when it resolves public no later hop may move into one.
   */
  privateNetwork: 'refuse' | 'followCallerDestination';
}>;

export type RemoteAcquisitionAddressResolver = (
  hostname: string,
) => Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]>;

export type OpenedRemoteAcquisition = Readonly<{
  response: Response;
  signal?: AbortSignal;
  /** Releases the pinned connection pool; call it once the body is consumed. */
  dispose(): Promise<void>;
}>;

async function defaultResolveAddresses(
  hostname: string,
): Promise<readonly Readonly<{ address: string; family: 4 | 6 }>[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.filter((answer): answer is { address: string; family: 4 | 6 } => (
    answer.family === 4 || answer.family === 6
  ));
}

/**
 * A pinned lookup refuses any hostname other than the one whose addresses were
 * assessed, so a connection can never be re-pointed after the classification.
 */
function createPinnedLookup(
  hostname: string,
  addresses: readonly Readonly<{ address: string; family: 4 | 6 }>[],
  errorLabel: string,
): LookupFunction {
  const expectedHostname = hostname.toLowerCase().replace(/\.$/u, '');
  return (requestedHostname, options, callback) => {
    if (requestedHostname.toLowerCase().replace(/\.$/u, '') !== expectedHostname) {
      callback(Object.assign(
        new Error(`${errorLabel} host changed after DNS assessment`),
        { code: 'EHOSTUNREACH' },
      ), '', 0);
      return;
    }
    const family = typeof options === 'number' ? options : options.family ?? 0;
    const candidates = family === 4 || family === 6
      ? addresses.filter((entry) => entry.family === family)
      : addresses;
    if (candidates.length === 0) {
      callback(Object.assign(
        new Error(`${errorLabel} has no assessed address for the requested family`),
        { code: 'EHOSTUNREACH' },
      ), '', 0);
      return;
    }
    if (typeof options !== 'number' && options.all) {
      callback(null, [...candidates]);
      return;
    }
    callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

export function assertRemoteAcquisitionUrl(
  rawUrl: string,
  policy: RemoteAcquisitionDestinationPolicy,
  errorLabel: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${errorLabel} requires an absolute URL`);
  }
  const httpsOnly = policy.scheme === 'https';
  const schemeAdmitted = parsed.protocol === 'https:'
    || (!httpsOnly && parsed.protocol === 'http:');
  if (!schemeAdmitted || parsed.username || parsed.password || parsed.hash || !parsed.hostname) {
    throw new Error(httpsOnly
      ? `${errorLabel} requires a credential-free HTTPS URL`
      : `${errorLabel} requires a credential-free HTTP(S) URL`);
  }
  if (policy.privateNetwork === 'refuse') {
    // Refuse a syntactically private destination before the network boundary
    // is touched at all; a hostname is still decided by its resolved answers.
    const { hostname } = resolveUrlConnectionIdentity(parsed.hostname);
    const literal = isIP(hostname) !== 0;
    if (hostname.toLowerCase() === 'localhost' || (literal && !areNetworkAddressesPublic([hostname]))) {
      throw new Error(`${errorLabel} host must be public`);
    }
  }
  return parsed;
}

export async function openRemoteAcquisition(params: Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  policy: RemoteAcquisitionDestinationPolicy;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  errorLabel: string;
  /**
   * Caller-supplied HTTP transport. It replaces the connection this owner would
   * open — and therefore its address pinning — but never the destination
   * decision, which is taken for every hop either way.
   */
  fetchImpl?: typeof fetch;
  resolveAddresses?: RemoteAcquisitionAddressResolver;
}>): Promise<OpenedRemoteAcquisition> {
  const { policy, errorLabel } = params;
  const resolveAddresses = params.resolveAddresses ?? defaultResolveAddresses;
  const lifetime = createPluginAcquisitionLifetime(params);
  const signal = lifetime.signal;
  try {
    let current = assertRemoteAcquisitionUrl(params.url, policy, errorLabel);
    const callerOrigin = current.origin;
    // `null` until the caller's own destination has been classified; from then on
    // it records whether the chain must stay public.
    let requirePublicHops: boolean | null = policy.privateNetwork === 'refuse' ? true : null;
    const visitedUrls = new Set<string>();

    for (;;) {
      signal?.throwIfAborted();
      const currentUrl = current.toString();
      if (visitedUrls.has(currentUrl)) throw new Error(`${errorLabel} redirect loop`);
      visitedUrls.add(currentUrl);
      // Every hop is resolved and classified before a socket opens, whoever owns
      // the transport. A caller-supplied transport replaces the connection, never
      // the destination decision.
      const { hostname } = resolveUrlConnectionIdentity(current.hostname);
      const addresses = await awaitPluginAcquisition(resolveAddresses(hostname), signal);
      if (addresses.length === 0) throw new Error(`${errorLabel} DNS lookup returned no addresses`);
      const allPublic = areNetworkAddressesPublic(addresses.map((answer) => answer.address));
      if (requirePublicHops === true && !allPublic) {
        throw new Error(`${errorLabel} resolved to a private, local, reserved, or invalid address`);
      }
      if (requirePublicHops === null) requirePublicHops = allPublic;

      let response: Response;
      let dispose = async (): Promise<void> => undefined;
      if (params.fetchImpl) {
        response = await awaitPluginAcquisition(params.fetchImpl(current.toString(), {
          headers: params.headers,
          signal,
          redirect: 'manual',
        }), signal);
      } else {
        const dispatcher = new Agent({
          connect: { lookup: createPinnedLookup(hostname, addresses, errorLabel), timeout: 0 },
          headersTimeout: 0,
          bodyTimeout: 0,
        });
        dispose = async () => await dispatcher.close();
        try {
          response = await undiciFetch(current.toString(), {
            headers: params.headers,
            signal,
            redirect: 'manual',
            dispatcher,
          }) as unknown as Response;
        } catch (error) {
          await dispose().catch(() => undefined);
          throw error;
        }
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        if (policy.redirects === 'sameOrigin' && response.url) {
          const observed = assertRemoteAcquisitionUrl(response.url, policy, errorLabel);
          if (observed.origin !== callerOrigin) {
            await response.body?.cancel().catch(() => undefined);
            await dispose().catch(() => undefined);
            throw new Error(`${errorLabel} redirect changed origin`);
          }
        }
        return { response, signal, dispose: async () => {
          lifetime.dispose();
          await dispose();
        } };
      }

      await response.body?.cancel().catch(() => undefined);
      await dispose().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) throw new Error(`${errorLabel} redirect omitted location`);
      const next = assertRemoteAcquisitionUrl(new URL(location, current).toString(), policy, errorLabel);
      if (policy.redirects === 'sameOrigin' && next.origin !== callerOrigin) {
        throw new Error(`${errorLabel} redirect changed origin`);
      }
      current = next;
    }
  } catch (error) {
    lifetime.dispose();
    throw error;
  }
}
