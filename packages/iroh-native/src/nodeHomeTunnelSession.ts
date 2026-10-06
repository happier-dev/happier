import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

import { IrohError } from './errors.js';
import { loadIrohNodeNative } from './nodeNative.js';
import type { NodeIrohNativeModule } from './nodeNative.types.js';

function retryableRelease(release: () => Promise<void>, onReleased: () => void): () => Promise<void> {
  let released = false;
  let inFlight: Promise<void> | null = null;
  return () => {
    if (released) return Promise.resolve();
    inFlight ??= release().then(
      () => {
        released = true;
        inFlight = null;
        onReleased();
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };
}

function abortError(): Error {
  const error = new Error('Iroh Home tunnel acquisition was cancelled');
  error.name = 'AbortError';
  return error;
}

export type NodeIrohHomeTunnelLease = Readonly<{
  homeServerIdentityId: string;
  endpointId: string;
  runtimeOrigin: string;
  observedPath: 'direct' | 'relay' | 'unknown';
  status: 'ready';
  release(): Promise<void>;
}>;

export type NodeIrohHomeTunnelSession = Readonly<{
  ensureHomeTunnel(input: Readonly<{
    descriptor: HomeConnectionDescriptorV1;
    signal?: AbortSignal;
  }>): Promise<NodeIrohHomeTunnelLease>;
  shutdown(): Promise<void>;
}>;

export async function createNodeIrohHomeTunnelSession(input: Readonly<{
  packageRoot?: string;
  native?: NodeIrohNativeModule;
  endpointKeyPath?: string;
  /** Account-client helpers have no stable service identity; each gets a fresh endpoint. */
  keylessEndpoint?: 'account_client' | 'fixture' | 'probe';
  relayPolicy?: 'automatic' | 'disabled';
  relayUrls?: readonly string[];
}>): Promise<NodeIrohHomeTunnelSession> {
  const endpointKeyPath = input.endpointKeyPath?.trim();
  if (Boolean(endpointKeyPath) === Boolean(input.keylessEndpoint)) {
    throw new IrohError(
      'invalid_descriptor',
      'Node Iroh sessions require either a persistent endpoint key path or an explicit keyless endpoint role',
    );
  }
  const loaded = input.native ? null : loadIrohNodeNative(input.packageRoot);
  const native = input.native ?? (loaded?.available ? loaded.native : null);
  if (!native) {
    throw new IrohError(
      'unavailable',
      loaded && !loaded.available ? loaded.message : 'Iroh Node lifecycle addon is unavailable',
    );
  }
  const endpoint = await native.createEndpoint({
    ...(endpointKeyPath ? { keyPath: endpointKeyPath } : {}),
    relayPolicy: input.relayPolicy ?? 'automatic',
    ...(input.relayUrls?.length ? { relayUrls: input.relayUrls } : {}),
    capProfile: 'homeInteractive',
  });
  const activeReleases = new Set<() => Promise<void>>();
  let shutdownComplete = false;
  let shutdownRequested = false;
  let shutdownInFlight: Promise<void> | null = null;
  const shutdownEndpoint = retryableRelease(
    async () => await native.shutdownEndpoint({ endpointHandle: endpoint.endpointHandle }),
    () => undefined,
  );

  return {
    async ensureHomeTunnel({ descriptor, signal }) {
      if (shutdownRequested) throw new IrohError('transport_closed', 'Iroh Home tunnel session is shut down');
      if (signal?.aborted) throw abortError();
      const parsed = HomeConnectionDescriptorV1Schema.parse(descriptor);
      const target = parsed.endpoints.find((candidate) => candidate.kind === 'iroh');
      if (!target) throw new IrohError('invalid_descriptor', 'Home descriptor declares no Iroh endpoint');
      const started = await native.ensureHomeTunnel({
        endpointHandle: endpoint.endpointHandle,
        homeServerIdentityId: parsed.homeServerIdentityId,
        endpointId: target.endpointId,
        ...(target.directAddresses ? { directAddresses: target.directAddresses } : {}),
        ...(target.relayUrls ? { relayUrls: target.relayUrls } : {}),
      });
      let release!: () => Promise<void>;
      release = retryableRelease(
        async () => await native.releaseHomeTunnel(started.tunnelId),
        () => activeReleases.delete(release),
      );
      activeReleases.add(release);
      if (
        started.endpointHandle !== endpoint.endpointHandle
        || started.homeServerIdentityId !== parsed.homeServerIdentityId
        || started.homeEndpointId !== target.endpointId
      ) {
        await release().catch(() => undefined);
        throw new IrohError('identity_mismatch', 'Native Iroh tunnel does not match the requested Home identity');
      }
      if (shutdownRequested || signal?.aborted) {
        await release().catch(() => undefined);
        throw abortError();
      }
      return {
        homeServerIdentityId: started.homeServerIdentityId,
        endpointId: started.homeEndpointId,
        runtimeOrigin: started.runtimeOrigin,
        observedPath: started.observedPath,
        status: 'ready',
        release,
      };
    },
    async shutdown() {
      if (shutdownComplete) return;
      shutdownRequested = true;
      shutdownInFlight ??= (async () => {
        const first = await Promise.allSettled([...activeReleases].map(async (release) => await release()));
        const retry = await Promise.allSettled([...activeReleases].map(async (release) => await release()));
        const failed = [...first, ...retry].find((outcome) => outcome.status === 'rejected');
        if (activeReleases.size > 0) {
          if (failed?.status === 'rejected') throw failed.reason;
          throw new Error('Iroh Home tunnel release did not complete');
        }
        await shutdownEndpoint();
        shutdownComplete = true;
      })();
      const activeShutdown = shutdownInFlight;
      try {
        await activeShutdown;
      } catch (error) {
        if (shutdownInFlight === activeShutdown) shutdownInFlight = null;
        throw error;
      }
    },
  };
}
