import { isIP, type LookupFunction } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

import type { AssessedProviderEndpoint } from '@happier-dev/protocol';

export function createPinnedProviderLookup(params: Readonly<{
  hostname: string;
  resolvedAddresses: readonly string[];
}>): LookupFunction {
  const expectedHostname = params.hostname.toLowerCase().replace(/\.$/u, '');
  const addresses = params.resolvedAddresses.map((address) => ({
    address,
    family: isIP(address),
  })).filter((entry): entry is Readonly<{ address: string; family: 4 | 6 }> => entry.family === 4 || entry.family === 6);
  return (hostname, options, callback) => {
    const requestedHostname = hostname.toLowerCase().replace(/\.$/u, '');
    if (requestedHostname !== expectedHostname) {
      callback(Object.assign(new Error('Provider connection host changed after safety assessment.'), { code: 'EHOSTUNREACH' }), '', 0);
      return;
    }
    const family = typeof options === 'number' ? options : options.family ?? 0;
    const candidates = family === 4 || family === 6
      ? addresses.filter((entry) => entry.family === family)
      : addresses;
    if (candidates.length === 0) {
      callback(Object.assign(new Error('Provider connection has no assessed address for the requested family.'), { code: 'EHOSTUNREACH' }), '', 0);
      return;
    }
    if (typeof options !== 'number' && options.all) {
      callback(null, candidates);
      return;
    }
    callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

export async function fetchPinnedProviderEndpoint(params: Readonly<{
  endpoint: AssessedProviderEndpoint;
  url: string;
  init: RequestInit;
}>): Promise<Readonly<{ response: Response; dispose: () => Promise<void> }>> {
  const dispatcher = new Agent({
    connect: {
      lookup: createPinnedProviderLookup({
        hostname: params.endpoint.hostname,
        resolvedAddresses: params.endpoint.resolvedAddresses,
      }),
    },
  });
  try {
    const response = await undiciFetch(params.url, {
      method: params.init.method,
      headers: Object.fromEntries(new Headers(params.init.headers).entries()),
      // Boundary conversion: both types are WHATWG BodyInit implementations, but DOM and undici declarations are nominally distinct.
      body: params.init.body as never,
      signal: params.init.signal,
      redirect: params.init.redirect,
      dispatcher,
    });
    return {
      response: response as unknown as Response,
      dispose: async () => await dispatcher.close(),
    };
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
}
