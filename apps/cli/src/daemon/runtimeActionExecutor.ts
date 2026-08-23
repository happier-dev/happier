import {
  createUnavailableRuntimeActionExecutor,
  type RuntimeActionExecute,
} from '@happier-dev/protocol';

import { createBrowserDaemonRuntimeActionExecutor } from './browser/actions/runtimeActionExecutor';
import type { BrowserAutomationRoutes } from './browser/automation/routes';
import { createBrowserDaemonFeatureGate } from './browser/featureGate';
import type { BrowserDaemonControlRoutes } from './browser/control/routes';
import type { BrowserContextRoutes } from './browser/context/routes';
import type { BrowserDiagnosticsActionRoutes } from './browser/diagnostics/actionRoutes';
import { createBrowserRecordingActionRoutes } from './browser/recording/actionRoutes';
import {
  createBrowserRecordingAttachToComposer,
  type BrowserRecordingComposerAttachInput,
  type BrowserRecordingComposerAttachResult,
} from './browser/recording/attachToComposer';
import type { BrowserRecordingRoutes } from './browser/recording/routes';
import { createSimulatorDaemonRuntimeActionExecutor } from './devices/simulator/actions/runtimeActionExecutor';
import { createSimulatorDaemonFeatureGate } from './devices/simulator/featureGate';
import type { SimulatorPreviewRoutes } from './devices/simulator/previewRoutes.types';
import { createLocalServicesDaemonRuntimeActionExecutor, type LocalServicesRuntimeActionRoutes } from './local/services/actions/runtimeActionExecutor';
import { createLocalServicesDaemonFeatureGate } from './local/services/featureGate';
import {
  createPeerMediationObservabilityDaemonRuntimeActionExecutor,
  type DaemonPeerMediationObservabilityRuntimeActionContext,
} from './peer/mediation/observability/runtimeActionExecutor';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

/**
 * Daemon-owned routes for runtime Action families. Consumers provide their current daemon route
 * owners; this module alone composes family fallbacks and refreshes their feature gates.
 */
export type DaemonRuntimeActionRouteOwners = Readonly<{
  browserControl?: BrowserDaemonControlRoutes | null;
  browserContext?: BrowserContextRoutes | null;
  browserAutomation?: BrowserAutomationRoutes | null;
  browserDiagnostics?: BrowserDiagnosticsActionRoutes | null;
  browserRecording?: BrowserRecordingRoutes | null;
  attachBrowserRecordingToComposer?: (
    input: BrowserRecordingComposerAttachInput,
  ) => Promise<BrowserRecordingComposerAttachResult>;
  localServices?: LocalServicesRuntimeActionRoutes | null;
  simulatorPreview?: SimulatorPreviewRoutes | null;
  peerMediationObservability?: DaemonPeerMediationObservabilityRuntimeActionContext | null;
}>;

export type CreateDaemonRuntimeActionExecutorInput = Readonly<{
  env: NodeJS.ProcessEnv;
  /** Resolve at dispatch time so route replacement cannot leave plugin actions stale. */
  resolveRouteOwners: () => DaemonRuntimeActionRouteOwners;
  /** The daemon's cached, synchronous server feature snapshot accessor. */
  resolveServerFeaturesSnapshot: () => CliServerFeaturesSnapshot | undefined;
}>;

/**
 * The canonical daemon runtime-Action composition. It deliberately accepts only daemon-owned
 * route owners: browser actions never reach a UI-rendered view owner through this path.
 */
export function createDaemonRuntimeActionExecutor(
  input: CreateDaemonRuntimeActionExecutorInput,
): RuntimeActionExecute {
  const unavailableRuntimeActionExecutor = createUnavailableRuntimeActionExecutor();
  const browserDaemonFeatureGate = createBrowserDaemonFeatureGate({
    env: input.env,
    resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot,
  });
  const localServicesDaemonFeatureGate = createLocalServicesDaemonFeatureGate({
    env: input.env,
    resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot,
  });
  const simulatorDaemonFeatureGate = createSimulatorDaemonFeatureGate({
    env: input.env,
    resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot,
  });

  return async (args) => {
    args.context.signal?.throwIfAborted();
    // The browser executor falls back to local services, simulator, and peer mediation. Refresh all
    // of their caches before selecting a leaf so every family remains fail-closed on server-disable.
    await Promise.all([
      browserDaemonFeatureGate.refresh(),
      localServicesDaemonFeatureGate.refresh(),
      simulatorDaemonFeatureGate.refresh(),
    ]);
    args.context.signal?.throwIfAborted();

    const routes = input.resolveRouteOwners();
    const peerMediationObservabilityRuntimeActionExecutor = routes.peerMediationObservability
      ? createPeerMediationObservabilityDaemonRuntimeActionExecutor({
          store: routes.peerMediationObservability.store,
          accountId: routes.peerMediationObservability.accountId,
          machineId: routes.peerMediationObservability.machineId,
          featurePayload: () => {
            const snapshot = input.resolveServerFeaturesSnapshot();
            return snapshot?.status === 'ready' ? snapshot.features : {};
          },
          fallback: unavailableRuntimeActionExecutor,
        })
      : unavailableRuntimeActionExecutor;
    const simulatorRuntimeActionExecutor = routes.simulatorPreview
      ? createSimulatorDaemonRuntimeActionExecutor({
          routes: routes.simulatorPreview,
          fallback: peerMediationObservabilityRuntimeActionExecutor,
          featureGate: simulatorDaemonFeatureGate,
        })
      : peerMediationObservabilityRuntimeActionExecutor;
    const localServicesRuntimeActionExecutor = routes.localServices
      ? createLocalServicesDaemonRuntimeActionExecutor({
          routes: routes.localServices,
          fallback: simulatorRuntimeActionExecutor,
          featureGate: localServicesDaemonFeatureGate,
        })
      : simulatorRuntimeActionExecutor;
    const browserRecordingAttachToComposer = (
      routes.browserRecording && routes.attachBrowserRecordingToComposer
    )
      ? createBrowserRecordingAttachToComposer({
          routes: routes.browserRecording,
          attachToComposer: routes.attachBrowserRecordingToComposer,
        })
      : undefined;
    const browserRecordingActionRoutes = routes.browserRecording
      ? createBrowserRecordingActionRoutes({ routes: routes.browserRecording })
      : undefined;
    const browserRuntimeActionExecutor = createBrowserDaemonRuntimeActionExecutor({
      ...(routes.browserControl ? { control: routes.browserControl } : {}),
      ...(routes.browserContext ? { context: routes.browserContext } : {}),
      ...(routes.browserAutomation ? { automation: routes.browserAutomation } : {}),
      ...(routes.browserDiagnostics ? { diagnostics: routes.browserDiagnostics } : {}),
      ...(browserRecordingActionRoutes ? { recording: browserRecordingActionRoutes } : {}),
      ...(browserRecordingAttachToComposer ? { recordingAttach: browserRecordingAttachToComposer } : {}),
      featureGate: browserDaemonFeatureGate,
      fallback: localServicesRuntimeActionExecutor,
    });
    const result = await browserRuntimeActionExecutor(args);
    args.context.signal?.throwIfAborted();
    return result;
  };
}
