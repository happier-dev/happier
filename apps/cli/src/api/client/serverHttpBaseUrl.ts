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

/**
 * The daemon's verified process-local origin when it differs from the configured
 * route, else null. Child processes cannot see the publication, so the spawn
 * owner hands them this value in place of the configured API URL.
 */
export function resolvePublishedServerHttpOrigin(): string | null {
  return runtimePublication?.origin ?? null;
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
 * Publishes the daemon's verified process-local destination without changing
 * the canonical Home URL used for identity, credentials, and auth audiences.
 * The daemon has one active Home, so the returned owner-bound release is the
 * complete lifecycle rather than a second profile or tunnel registry.
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
  if (signal?.aborted) throw new DOMException('Iroh Home tunnel acquisition was cancelled', 'AbortError');
  const lease = await publication.homeTunnelOwner.acquire();
  if (signal?.aborted) {
    // Failed cleanup remains in the daemon's existing retryable lease custody.
    await lease.release().catch(() => undefined);
    throw new DOMException('Iroh Home tunnel acquisition was cancelled', 'AbortError');
  }
  return lease;
}

export function resolveServerSocketIoTransports(): string[] | undefined {
  return runtimePublication?.carrier === 'iroh'
    ? ['websocket']
    : configuration.socketIoTransports;
}
