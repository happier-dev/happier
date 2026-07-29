import type { DaemonState, DaemonTransferListenerState } from '@/api/types';
import type { MachinePublicationOutcome } from '@/api/apiMachine';
import type { DirectTransferServerLifecycleState } from '@/machines/transfer/directTransferServerLifecycle';

const SUPPRESSED_MACHINE_PUBLICATION_OUTCOME = 'suppressed' satisfies MachinePublicationOutcome;

type DirectPeerRuntimeConfig = Readonly<{
  featureEnabled: boolean;
  serverEnabled: boolean;
  bindHost: string;
  bindPort: number;
  advertisedHosts: readonly string[];
}>;

function createListenerState(params: Readonly<{
  enabled: boolean;
  configured: boolean;
  active: boolean;
  available?: boolean;
}>): Readonly<{
  enabled: boolean;
  configured: boolean;
  active: boolean;
  available?: boolean;
}> {
  return {
    enabled: params.enabled,
    configured: params.configured,
    active: params.active,
    ...(typeof params.available === 'boolean' ? { available: params.available } : {}),
  };
}

export function createDaemonTransferRuntimeState(params: Readonly<{
  directPeer: DirectPeerRuntimeConfig;
  tailscaleServe?: DaemonTransferListenerState;
}>): NonNullable<DaemonState['transfer']> {
  const directPeerSupported = params.directPeer.featureEnabled && params.directPeer.serverEnabled;
  const loopbackConfigured = directPeerSupported;

  return {
    supported: {
      import: directPeerSupported,
      export: directPeerSupported,
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
      tailscale_serve_https: {
        enabled: tailscaleServe.enabled,
        configured: tailscaleServe.configured,
        active: tailscaleServe.active,
        ...(typeof tailscaleServe.available === 'boolean'
          ? { available: tailscaleServe.available }
          : {}),
      },
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
        const baseState: DaemonState = state ?? {
          status: 'running',
          transfer: params.initialTransferState,
        };
        let transferState = baseState.transfer ?? params.initialTransferState;
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
