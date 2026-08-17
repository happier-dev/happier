import type {
  AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';

import { normalizeString } from '../../../runtime/server/openCodeParsing.js';
import type { OpenCodeNativeFetch } from '../../../runtime/server/transport.js';

/**
 * The synthetic origin a managed-endpoint request is expressed against. The
 * plugin never learns the server's real address — the host holds it — so a
 * request carries only a path and query, and this placeholder exists to make
 * that expressible as a URL.
 */
export const MANAGED_ENDPOINT_TRANSPORT_BASE_URL = 'http://opencode-managed.invalid';

/**
 * Issues a managed-endpoint read while honoring the caller's signal.
 *
 * `AgentExternalSessionsManagedEndpointRead` takes no signal of its own: the
 * host binds the read to its operation and applies its own read timeout. A
 * caller that aborts a narrower unit of work therefore has to be released
 * here, or it stays parked on the host's timeout instead of on its own
 * cancellation. An already-cancelled caller never reaches the endpoint at all.
 */
async function awaitManagedEndpointRead<T>(
  start: () => Promise<T>,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  if (!signal) return await start();
  signal.throwIfAborted();
  const read = start();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([read, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The one adapter from a host-stamped managed-endpoint read to a native fetch.
 *
 * The JSON read client and the global-event stream reach an OpenCode server
 * the same way — a read-only request against the endpoint the host owns — so
 * they share this adapter instead of each restating the origin guard and the
 * cancellation contract. The `ManagedServiceHandle` transport in
 * `runtime/server/transport.ts` is deliberately not merged in: it adapts a
 * handle held by the process that owns the service, carries methods, bodies
 * and per-request timeouts, and passes a real `AbortSignal` into the host
 * request. This seam has none of those — a plugin leaf holds a read function,
 * not a service.
 */
export function createManagedEndpointFetch(
  managedEndpointRead: AgentExternalSessionsManagedEndpointRead,
): OpenCodeNativeFetch {
  const expectedOrigin = new URL(MANAGED_ENDPOINT_TRANSPORT_BASE_URL).origin;
  return async (input, init = {}) => {
    const method = normalizeString(init.method || 'GET').toUpperCase();
    if (method !== 'GET' || (init.body !== undefined && init.body !== null)) {
      throw new Error('OpenCode managed observation supports read-only requests');
    }
    const target = new URL(input.toString(), `${MANAGED_ENDPOINT_TRANSPORT_BASE_URL}/`);
    if (
      target.origin !== expectedOrigin
      || target.username
      || target.password
      || target.hash
    ) {
      throw new Error('OpenCode managed observation request is outside its contextual endpoint');
    }
    const response = await awaitManagedEndpointRead(
      async () => await managedEndpointRead({
        pathAndQuery: `${target.pathname}${target.search}`,
      }),
      init.signal,
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
