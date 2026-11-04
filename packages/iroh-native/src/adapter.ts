import { IrohError, normalizeIrohNativeError } from './errors.js';
import { getOptionalHappierIrohNativeModule } from './HappierIrohNative.js';
import type {
  IrohHomeTunnelLease,
  IrohHomeTunnelRequest,
  IrohNativeAdapter,
  IrohNativeTunnelEvent,
  IrohObservedPath,
} from './types.js';
import type { NativeIrohModule } from './HappierIrohNative.types.js';

type NativeLifecycleModule = {
  ensureHomeTunnel(input: IrohHomeTunnelRequest): Promise<Omit<IrohHomeTunnelLease, 'release'>>;
  releaseHomeTunnel(leaseId: string): Promise<void>;
  getTunnelStatus?(tunnelId: string): Promise<Record<string, unknown> | null>;
};

type AdapterOptions = Readonly<{ statusPollIntervalMs?: number }>;

type NativeStatus = Readonly<{
  active: boolean;
  observedPath: IrohObservedPath;
}>;

export type IrohApplicationEndpointConfiguration = Readonly<{
  policy?: 'automatic' | 'disabled';
  relayUrls?: readonly string[];
  keyPath?: string;
}>;

type ApplicationEndpoint = Awaited<ReturnType<NativeIrohModule['createEndpoint']>>;
type ApplicationEndpointOwner = {
  endpoint: ApplicationEndpoint | null;
  tail: Promise<void>;
};

const applicationEndpointOwners = new WeakMap<NativeIrohModule, ApplicationEndpointOwner>();

/**
 * One native-module/application endpoint owner shared by Home and machine
 * consumers. Every acquire is presented to the native core so compatible
 * relay sets can accumulate; the persistent platform identity must always
 * resolve back to the same endpoint handle and EndpointId.
 */
export async function ensureIrohApplicationEndpoint(
  native: NativeIrohModule,
  configuration: IrohApplicationEndpointConfiguration,
): Promise<ApplicationEndpoint> {
  let owner = applicationEndpointOwners.get(native);
  if (!owner) {
    owner = { endpoint: null, tail: Promise.resolve() };
    applicationEndpointOwners.set(native, owner);
  }
  const operation = owner.tail.then(async () => {
    const endpoint = await native.createEndpoint({
      ...(configuration.keyPath ? { keyPath: configuration.keyPath } : {}),
      relayPolicy: configuration.policy ?? owner.endpoint?.relayPolicy ?? 'automatic',
      ...(configuration.relayUrls ? { relayUrls: configuration.relayUrls } : {}),
    });
    if (owner.endpoint && (
      owner.endpoint.endpointHandle !== endpoint.endpointHandle
      || owner.endpoint.endpointId !== endpoint.endpointId
    )) {
      throw new IrohError('unknown', 'Native Iroh application endpoint identity changed within one process.');
    }
    owner.endpoint = endpoint;
    return endpoint;
  });
  owner.tail = operation.then(() => undefined, () => undefined);
  return await operation;
}

function readObservedPath(value: unknown): IrohObservedPath {
  return value === 'direct' || value === 'relay' || value === 'unknown' ? value : 'unknown';
}

function readNativeStatus(value: Record<string, unknown>): NativeStatus {
  const connectionActive = value.connectionActive;
  const active = typeof connectionActive === 'boolean'
    ? connectionActive
    : value.active === true;
  return { active, observedPath: readObservedPath(value.observedPath) };
}

/** Lifecycle-only adapter boundary. Native implementations supply the byte carrier. */
export function createIrohNativeAdapter(native?: NativeLifecycleModule, options: AdapterOptions = {}): IrohNativeAdapter {
  const leases = new Map<string, IrohHomeTunnelLease>();
  /**
   * Native leases this adapter must still release but must never publish: a
   * result rejected for identity mismatch whose immediate release failed. The
   * native lease stays owned here and is retried only at this adapter's
   * explicit release and dispose boundaries — never on a timer.
   */
  const retainedNativeLeases = new Set<string>();
  const pollers = new Map<string, {
    listeners: Set<(event: IrohNativeTunnelEvent) => void>;
    timer: ReturnType<typeof setInterval>;
    lastStatus: NativeStatus | null;
    polling: boolean;
  }>();
  const statusPollIntervalMs = options.statusPollIntervalMs ?? 2_000;

  function stopPolling(leaseId: string): void {
    const poller = pollers.get(leaseId);
    if (!poller) return;
    clearInterval(poller.timer);
    pollers.delete(leaseId);
  }

  /**
   * Retries every retained native release once. A release that succeeds drops
   * its custody; a release that fails keeps it, so the retry stays idempotent
   * across repeated boundaries.
   */
  function retryRetainedReleases(): readonly Promise<void>[] {
    if (!native) return [];
    return [...retainedNativeLeases].map(async (leaseId) => {
      await native.releaseHomeTunnel(leaseId);
      retainedNativeLeases.delete(leaseId);
    });
  }

  function emit(leaseId: string, event: IrohNativeTunnelEvent): void {
    const poller = pollers.get(leaseId);
    if (!poller) return;
    for (const listener of poller.listeners) listener(event);
  }

  async function pollStatus(leaseId: string): Promise<void> {
    const poller = pollers.get(leaseId);
    const lease = leases.get(leaseId);
    if (!poller || !lease || !native?.getTunnelStatus || poller.polling) return;
    poller.polling = true;
    try {
      const value = await native.getTunnelStatus(leaseId);
      if (!pollers.has(leaseId)) return;
      if (value === null) {
        emit(leaseId, {
          type: 'closed', tunnelHandle: leaseId, status: 'closed',
          errorCode: 'transport_closed', atMs: Date.now(),
        });
        stopPolling(leaseId);
        return;
      }
      const current = readNativeStatus(value);
      const previous = poller.lastStatus;
      if (value.connectionActive === false) {
        // The core sets this only after Connection::closed resolves. The
        // retained native handle still needs release, but cannot recover.
        emit(leaseId, {
          type: 'closed', tunnelHandle: leaseId, status: 'closed',
          observedPath: current.observedPath, errorCode: 'transport_closed', atMs: Date.now(),
        });
        stopPolling(leaseId);
        return;
      } else if (!current.active) {
        if (previous?.active !== false) {
          emit(leaseId, {
            type: 'degraded', tunnelHandle: leaseId, status: 'degraded',
            observedPath: current.observedPath, errorCode: 'transport_closed', atMs: Date.now(),
          });
        }
      } else if (previous === null || !previous.active) {
        emit(leaseId, {
          type: 'ready', tunnelHandle: leaseId, status: 'ready',
          observedPath: current.observedPath, atMs: Date.now(),
        });
      } else if (previous.observedPath !== current.observedPath) {
        emit(leaseId, {
          type: 'path_changed', tunnelHandle: leaseId, status: 'ready',
          observedPath: current.observedPath, atMs: Date.now(),
        });
      }
      poller.lastStatus = current;
    } catch (error) {
      const normalized = normalizeIrohNativeError(error, 'unknown');
      emit(leaseId, {
        type: 'error', tunnelHandle: leaseId, status: 'error',
        errorCode: normalized.code, atMs: Date.now(),
      });
      // Observation is lease-scoped and non-authoritative. A transient status
      // read failure must not discard that ownership; the next poll may
      // observe native recovery while the supervisor remains the retry owner.
    } finally {
      const current = pollers.get(leaseId);
      if (current) current.polling = false;
    }
  }

  return {
    async ensureHomeTunnel(input) {
      if (!native) throw new IrohError('unavailable', 'Native Iroh transport is unavailable.');
      let result: Omit<IrohHomeTunnelLease, 'release'>;
      try {
        result = await native.ensureHomeTunnel(input);
      } catch (error) {
        throw normalizeIrohNativeError(error, 'unknown');
      }
      // Fail closed on a stale or misrouted native result: a lease belongs to
      // exactly the Home identity and endpoint it was requested for, and must
      // never be adopted for (or published onto) a different Home.
      if (result.homeServerIdentityId !== input.homeServerIdentityId || result.homeEndpointId !== input.endpointId) {
        try {
          await native.releaseHomeTunnel(result.leaseId);
        } catch {
          // Cleanup failed, so this adapter keeps custody of the exact native
          // lease and retries it at its next explicit release/dispose
          // boundary. The lease is still never adopted or published.
          retainedNativeLeases.add(result.leaseId);
        }
        throw new IrohError('identity_mismatch', 'Native Iroh lease does not match the requested Home identity.');
      }
      const lease: IrohHomeTunnelLease = {
        ...result,
        release: async () => {
          stopPolling(result.leaseId);
          await native.releaseHomeTunnel(result.leaseId);
          leases.delete(result.leaseId);
        },
      };
      leases.set(lease.leaseId, lease);
      return lease;
    },
    async releaseHomeTunnel(leaseId) {
      try {
        if (retainedNativeLeases.has(leaseId)) return;
        const lease = leases.get(leaseId);
        if (lease) await lease.release();
        else if (native) await native.releaseHomeTunnel(leaseId);
      } finally {
        // Retained custody is swept here best-effort: the caller only learns
        // the outcome of the release it asked for, and a still-failing
        // retained release stays owned for the next boundary.
        await Promise.allSettled(retryRetainedReleases());
      }
    },
    subscribeEvents(leaseId, listener) {
      const lease = leases.get(leaseId);
      if (!lease || !native?.getTunnelStatus) return () => undefined;
      const existing = pollers.get(leaseId);
      if (existing) {
        existing.listeners.add(listener);
      } else {
        const listeners = new Set([listener]);
        const timer = setInterval(() => { void pollStatus(leaseId); }, statusPollIntervalMs);
        pollers.set(leaseId, { listeners, timer, lastStatus: null, polling: false });
        // Foreground re-subscription refreshes once before the visible cadence.
        void pollStatus(leaseId);
      }
      return () => {
        const poller = pollers.get(leaseId);
        if (!poller) return;
        poller.listeners.delete(listener);
        if (poller.listeners.size === 0) stopPolling(leaseId);
      };
    },
    async dispose() {
      for (const leaseId of [...pollers.keys()]) stopPolling(leaseId);
      // One terminal sweep past every owned handle. Successful releases leave
      // this adapter; failed ones stay owned and are retried by the next
      // dispose, so native custody is never silently dropped.
      const outcomes = await Promise.allSettled([
        ...[...leases.values()].map((lease) => lease.release()),
        ...retryRetainedReleases(),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
    },
  };
}

/** Creates the optional mobile/desktop adapter without making native presence mandatory. */
export function createOptionalIrohNativeAdapter(): IrohNativeAdapter {
  const native = getOptionalHappierIrohNativeModule();

  async function applicationEndpoint(input: IrohHomeTunnelRequest): Promise<{ endpointHandle: string }> {
    return await ensureIrohApplicationEndpoint(native!, {
      ...(input.endpointKeyPath ? { keyPath: input.endpointKeyPath } : {}),
      policy: input.policy,
      ...(input.relayUrls ? { relayUrls: input.relayUrls } : {}),
    });
  }

  return createIrohNativeAdapter(native ? {
    ensureHomeTunnel: async ({ homeServerIdentityId, endpointId, directAddresses, relayUrls, ...input }) => {
      const { endpointHandle } = await applicationEndpoint({
        homeServerIdentityId,
        endpointId,
        directAddresses,
        relayUrls,
        ...input,
      });
      const started = await native.ensureHomeTunnel({
        endpointHandle,
        homeServerIdentityId,
        endpointId,
        ...(directAddresses ? { directAddresses } : {}),
        ...(relayUrls ? { relayUrls } : {}),
      });
      return { ...started, leaseId: started.tunnelId };
    },
    releaseHomeTunnel: (leaseId) => native.releaseHomeTunnel(leaseId),
    getTunnelStatus: (tunnelId) => native.getTunnelStatus(tunnelId),
  } : undefined);
}
