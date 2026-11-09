import type { DaemonState, DaemonTransferListenerState } from '@/api/types';
import type { MachinePublicationOutcome } from '@/api/apiMachine';
import type { DirectTransferServerLifecycleState } from '@/machines/transfer/directTransferServerLifecycle';
import { StoredMachinePublishedDaemonStateV1Schema, MachinePublishedTransferRuntimeV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';

const SUPPRESSED_MACHINE_PUBLICATION_OUTCOME = 'suppressed' satisfies MachinePublicationOutcome;

type DirectPeerRuntimeConfig = Readonly<{
  featureEnabled: boolean;
  serverEnabled: boolean;
  bindHost: string;
  bindPort: number;
  advertisedHosts: readonly string[];
}>;

function createListenerState(params: DaemonTransferListenerState): DaemonTransferListenerState {
  return {
    enabled: params.enabled,
    configured: params.configured,
    active: params.active,
    ...(typeof params.available === 'boolean' ? { available: params.available } : {}),
    ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
  };
}

export function createDaemonTransferRuntimeState(params: Readonly<{
  directPeer: DirectPeerRuntimeConfig;
  tailscaleServe?: DaemonTransferListenerState;
}>): NonNullable<DaemonState['transfer']> {
  const loopbackConfigured = params.directPeer.featureEnabled && params.directPeer.serverEnabled;

  return {
    // Bootstrap installs the prepared Home owner independently of direct listener publication.
    supported: {
      import: true,
      export: true,
    },
    listenerClasses: {
      loopback_http: createListenerState({
        enabled: loopbackConfigured,
        configured: loopbackConfigured,
        active: false,
      }),
      tailscale_serve_https: createListenerState({
        enabled: params.tailscaleServe?.enabled ?? false,
        configured: params.tailscaleServe?.configured ?? false,
        active: params.tailscaleServe?.active ?? false,
        ...(typeof params.tailscaleServe?.available === 'boolean'
          ? { available: params.tailscaleServe.available }
          : { available: false }),
        ...(params.tailscaleServe?.diagnostic ? { diagnostic: params.tailscaleServe.diagnostic } : {}),
      }),
    },
    lifecycle: {
      mode: 'lazy_idle_shutdown',
      version: 1,
    },
  };
}

type DaemonTransferRuntimeStatePublisherApiMachine = Readonly<{
  updateDaemonState: (updater: (state: DaemonState | null) => DaemonState) => Promise<unknown>;
}>;

function resolveListenerActive(
  lifecycleState: DirectTransferServerLifecycleState,
  listenerClass: keyof NonNullable<DaemonState['transfer']>['listenerClasses'],
): boolean {
  return lifecycleState.status === 'running' && lifecycleState.listenerClasses.includes(listenerClass);
}

function applyDirectTransferServerLifecycleState(
  initialTransferState: NonNullable<DaemonState['transfer']>,
  lifecycleState: DirectTransferServerLifecycleState,
): NonNullable<DaemonState['transfer']> {
  return {
    ...initialTransferState,
    listenerClasses: {
      ...initialTransferState.listenerClasses,
      loopback_http: {
        ...initialTransferState.listenerClasses.loopback_http,
        active: initialTransferState.listenerClasses.loopback_http.enabled
          ? resolveListenerActive(lifecycleState, 'loopback_http')
          : false,
      },
      tailscale_serve_https: {
        ...initialTransferState.listenerClasses.tailscale_serve_https,
      },
    },
  };
}

function applyTailscaleTransferListenerState(
  transferState: NonNullable<DaemonState['transfer']>,
  tailscaleServe: DaemonTransferListenerState,
): NonNullable<DaemonState['transfer']> {
  return {
    ...transferState,
    listenerClasses: {
      ...transferState.listenerClasses,
      tailscale_serve_https: createListenerState(tailscaleServe),
    },
  };
}

export function createDaemonTransferRuntimeStatePublisher(params: Readonly<{
  initialTransferState: NonNullable<DaemonState['transfer']>;
  isDaemonQuiescing?: () => boolean;
  warn?: (message: string, error?: unknown) => void;
}>): Readonly<{
  attachApiMachine: (apiMachine: DaemonTransferRuntimeStatePublisherApiMachine | null) => Promise<void>;
  publishDirectTransferServerLifecycleState: (state: DirectTransferServerLifecycleState) => Promise<void>;
  publishTailscaleTransferListenerState: (state: DaemonTransferListenerState) => Promise<void>;
  resume: () => Promise<void>;
}> {
  const initialTransferState = MachinePublishedTransferRuntimeV1Schema.parse(params.initialTransferState);
  let apiMachine: DaemonTransferRuntimeStatePublisherApiMachine | null = null;
  let latestDirectLifecycleState: DirectTransferServerLifecycleState | null = null;
  let latestTailscaleTransferListenerState: DaemonTransferListenerState | null = null;
  let hasPendingState = false;
  let flushInFlight: Promise<void> | null = null;

  const flushPendingState = async (): Promise<boolean> => {
    if (!apiMachine || !hasPendingState || params.isDaemonQuiescing?.() === true) {
      return false;
    }
    hasPendingState = false;
    try {
      const publicationOutcome = await apiMachine.updateDaemonState((state) => {
        const baseState: DaemonState = state === null ? {
          status: 'running',
          transfer: initialTransferState,
        } : StoredMachinePublishedDaemonStateV1Schema.parse(state);
        // The live bootstrap and listener owners, not an incumbent daemon's
        // persisted projection, define the current transfer application.
        let transferState = initialTransferState;
        if (latestDirectLifecycleState) {
          transferState = applyDirectTransferServerLifecycleState(
            transferState,
            latestDirectLifecycleState,
          );
        }
        if (latestTailscaleTransferListenerState) {
          transferState = applyTailscaleTransferListenerState(
            transferState,
            latestTailscaleTransferListenerState,
          );
        }
        return {
          ...baseState,
          transfer: transferState,
        };
      });
      if (publicationOutcome === SUPPRESSED_MACHINE_PUBLICATION_OUTCOME) {
        hasPendingState = true;
        return false;
      }
      return true;
    } catch (error) {
      hasPendingState = true;
      params.warn?.('[DAEMON RUN] Failed to publish direct transfer daemon state', error);
      return false;
    }
  };

  const scheduleFlush = async (): Promise<void> => {
    if (flushInFlight) {
      await flushInFlight;
      if (apiMachine && hasPendingState && params.isDaemonQuiescing?.() !== true) {
        await scheduleFlush();
      }
      return;
    }
    flushInFlight = (async () => {
      while (apiMachine && hasPendingState) {
        const didFlush = await flushPendingState();
        if (!didFlush) {
          break;
        }
      }
    })().finally(() => {
      flushInFlight = null;
    });
    return await flushInFlight;
  };

  return {
    async attachApiMachine(nextApiMachine) {
      apiMachine = nextApiMachine;
      if (nextApiMachine) hasPendingState = true;
      await scheduleFlush();
    },

    async publishDirectTransferServerLifecycleState(state) {
      latestDirectLifecycleState = state;
      hasPendingState = true;
      await scheduleFlush();
    },

    async publishTailscaleTransferListenerState(state) {
      latestTailscaleTransferListenerState = state;
      hasPendingState = true;
      await scheduleFlush();
    },

    async resume() {
      await scheduleFlush();
    },
  };
}
