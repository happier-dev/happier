import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import type { NodeIrohHomeTunnelLease } from '@happier-dev/iroh-native/node';

import { configuration } from '@/configuration';

import { resolveLoopbackHttpUrl } from './loopbackUrl';

type PublishedHomeTunnelOwner = Readonly<{
  descriptor: HomeConnectionDescriptorV1;
  acquire(): Promise<NodeIrohHomeTunnelLease>;
}>;

type ServerHttpRuntimePublication = Readonly<{
  origin: string;
  serverId: string;
  carrier: 'iroh' | 'https';
  homeTunnelOwner?: PublishedHomeTunnelOwner;
}>;

let runtimePublication: ServerHttpRuntimePublication | null = null;
const invocationServerHttpBaseUrl = new AsyncLocalStorage<string>();

export function normalizeServerHttpBaseUrl(serverUrl: string): string {
  return resolveLoopbackHttpUrl(serverUrl).replace(/\/+$/, '');
}

export function resolveServerHttpBaseUrl(): string {
  return invocationServerHttpBaseUrl.getStore()
    ?? runtimePublication?.origin
    ?? normalizeServerHttpBaseUrl(configuration.apiServerUrl);
}

/** A live daemon consumer follows carrier replacement within its original Home. */
export function captureServerHttpBaseUrl(): () => string {
  const origin = resolveServerHttpBaseUrl();
  const invocationOrigin = invocationServerHttpBaseUrl.getStore();
  if (invocationOrigin) return () => origin;
  const serverId = runtimePublication?.serverId ?? configuration.activeServerId;
  return () => runtimePublication?.serverId === serverId ? runtimePublication.origin : origin;
}

/**
 * Runs one finite request/invocation against an immutable resolved Home endpoint.
 * This does not change process configuration or publish a runtime carrier.
 */
export function runWithServerHttpBaseUrl<T>(serverUrl: string, run: () => T): T {
  return invocationServerHttpBaseUrl.run(normalizeServerHttpBaseUrl(serverUrl), run);
}

/**
 * Publishes this process's verified destination without changing the canonical
 * Home URL used for identity, credentials, and auth audiences. Each daemon or
 * primary runner has one active Home, so the returned owner-bound release is
 * the complete lifecycle rather than a second profile or tunnel registry.
 */
export function publishServerHttpRuntimeOrigin(
  runtimeOrigin: string,
  carrier: 'iroh' | 'https',
  homeTunnelOwner?: PublishedHomeTunnelOwner,
  serverId: string = configuration.activeServerId,
): () => void {
  const publication = {
    origin: normalizeServerHttpBaseUrl(runtimeOrigin),
    serverId,
    carrier,
    ...(homeTunnelOwner ? {
      homeTunnelOwner: {
        descriptor: structuredClone(homeTunnelOwner.descriptor),
        acquire: homeTunnelOwner.acquire,
      },
    } : {}),
  } satisfies ServerHttpRuntimePublication;
  runtimePublication = publication;
  return () => {
    if (runtimePublication === publication) runtimePublication = null;
  };
}

/** Borrows only a lease from the daemon's exact verified Home publication. */
export async function borrowServerHttpRuntimeHomeTunnel(
  descriptor: HomeConnectionDescriptorV1,
  signal?: AbortSignal,
): Promise<NodeIrohHomeTunnelLease | null> {
  const publication = runtimePublication;
  if (
    publication?.carrier !== 'iroh'
    || !publication.homeTunnelOwner
    || !isDeepStrictEqual(publication.homeTunnelOwner.descriptor, descriptor)
  ) return null;
  const cancellationError = () => new DOMException('Iroh Home tunnel acquisition was cancelled', 'AbortError');
  if (signal?.aborted) throw cancellationError();
  let lease: NodeIrohHomeTunnelLease;
  let onAbort: (() => void) | undefined;
  try {
    const acquisition = publication.homeTunnelOwner.acquire();
    lease = signal ? await new Promise<NodeIrohHomeTunnelLease>((resolve, reject) => {
      onAbort = () => reject(cancellationError());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      acquisition.then(acquired => {
        if (signal.aborted) {
          // Only this borrowed lease is abandoned. Failed disposal stays in
          // the daemon's existing retryable custody; its endpoint stays alive.
          void acquired.release().catch(() => undefined);
          reject(cancellationError());
          return;
        }
        resolve(acquired);
      }, reject);
    }) : await acquisition;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) {
    // Cancellation can win after resolution but before this continuation.
    // Cleanup must not hold the cancelled caller on another native wait.
    void lease.release().catch(() => undefined);
    throw cancellationError();
  }
  return lease;
}

export function resolveServerSocketIoTransports(): string[] | undefined {
  return runtimePublication?.carrier === 'iroh'
    ? ['websocket']
    : configuration.socketIoTransports;
}
