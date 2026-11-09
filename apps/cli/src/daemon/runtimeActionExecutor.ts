import { createUnavailableRuntimeActionExecutor, resolveRuntimeActionExecutionFamily, isRuntimeActionExecutorReal } from '@happier-dev/protocol/actions/executor/dispatch';
import type { RuntimeActionExecute } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { HostActionOperationRuntime } from './actionOperations/createHostActionOperationRuntime';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";

import {
  createBrowserDaemonRuntimeActionExecutor,
  type ProvisionBrowserAutomationRuntime,
} from './browser/actions/runtimeActionExecutor';
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
} from './recording/attachToComposer';
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
import type { ComputerRoutes } from './computer/routes';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';

export type BrowserUiAutomationRouteOwner = Readonly<{
  ownsAutomationView: (view: Readonly<{ browserSessionId: string; viewId: string }>) => boolean;
  uiAutomation: RuntimeActionExecute;
}>;

/**
 * Daemon-owned routes for runtime Action families. Consumers provide their current daemon route
 * owners; this module alone composes family fallbacks and refreshes their feature gates.
 */
export type DaemonRuntimeActionRouteOwners = Readonly<{
  computer?: ComputerRoutes | null;
  browserControl?: BrowserDaemonControlRoutes | null;
  browserContext?: BrowserContextRoutes | null;
  browserAutomation?: BrowserAutomationRoutes | null;
  browserUiAutomation?: BrowserUiAutomationRouteOwner | null;
  /**
   * Provisions the managed browser runtime when an agent asks for automation and no route exists
   * (user ruling, 2026-08-23: install on first automation attempt, never at daemon startup).
   * Resolved per dispatch like every other owner here.
   */
  provisionBrowserAutomationRuntime?: ProvisionBrowserAutomationRuntime | null;
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
  env: ProcessEnvInput;
  /** Resolve at dispatch time so route replacement cannot leave plugin actions stale. */
  resolveRouteOwners: () => DaemonRuntimeActionRouteOwners;
  /** The daemon's cached, synchronous server feature snapshot accessor. */
  resolveServerFeaturesSnapshot: () => CliServerFeaturesSnapshot | undefined;
  /** Existing Machine operation owner observes every admitted Browser open. */
  observeExecution?: HostActionOperationRuntime['observeExecution'];
}>;

/**
 * The canonical daemon runtime-Action composition. Physical browser ownership chooses the daemon
 * route or the exact mounted UI owner; feature decisions and family fallbacks stay here.
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

  const execute: RuntimeActionExecute = async (args) => {
    args.context.signal?.throwIfAborted();
    // Native target availability/OS grants and consent have their own canonical owners;
    // browser/server feature bits do not decide native computer-use admission.
    if (resolveRuntimeActionExecutionFamily(args.actionId) === 'computer') {
      const routes = isRuntimeActionExecutorReal(args.actionId) ? input.resolveRouteOwners().computer : undefined;
      return routes ? await routes.dispatch(args.actionId, args.input, args.context) : unavailableRuntimeActionExecutor(args);
    }
    // The browser executor falls back to local services, simulator, and peer mediation. Refresh all
    // of their caches before selecting a leaf so every family remains fail-closed on server-disable.
    // OS prerequisite recovery is not decided by unrelated server/browser availability.
    if (args.actionId !== 'browser.sandbox.install') {
      await Promise.all([
        browserDaemonFeatureGate.refresh(),
        localServicesDaemonFeatureGate.refresh(),
        simulatorDaemonFeatureGate.refresh(),
      ]);
    }
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
          resolveInputControl: routes.browserAutomation?.resolveInputControl,
        })
      : undefined;
    const browserRecordingActionRoutes = routes.browserRecording
      ? createBrowserRecordingActionRoutes({ routes: routes.browserRecording })
      : undefined;
    const browserRuntimeActionExecutor = createBrowserDaemonRuntimeActionExecutor({
      ...(routes.browserControl ? { control: routes.browserControl } : {}),
      resolveControl: () => input.resolveRouteOwners().browserControl,
      ...(routes.browserContext ? { context: routes.browserContext } : {}),
      ...(routes.browserAutomation ? { automation: routes.browserAutomation } : {}),
      resolveAutomation: () => input.resolveRouteOwners().browserAutomation,
      // Without a current daemon ownership source, an unknown view must never provision Chromium.
      ownsAutomationView: routes.browserUiAutomation?.ownsAutomationView ?? (() => false),
      ...(routes.browserUiAutomation ? { uiAutomation: routes.browserUiAutomation.uiAutomation } : {}),
      ...(routes.provisionBrowserAutomationRuntime
        ? { provisionAutomationRuntime: routes.provisionBrowserAutomationRuntime }
        : {}),
      ...(routes.browserDiagnostics ? { diagnostics: routes.browserDiagnostics } : {}),
      ...(browserRecordingActionRoutes ? { recording: browserRecordingActionRoutes } : {}),
      ...(browserRecordingAttachToComposer ? { recordingAttach: browserRecordingAttachToComposer } : {}),
      featureGate: browserDaemonFeatureGate,
      fallback: localServicesRuntimeActionExecutor,
    });
    // Once dispatched, the owning leaf settles cancellation and effect completion. Admission
    // aborts above must not overwrite an acknowledged or explicitly uncertain owner result.
    return browserRuntimeActionExecutor(args);
  };

  return async args => {
    args.context.signal?.throwIfAborted();
    // Route availability changes provisioning, not operation ownership. Approval
    // replay and Session dispatch must observe installed opens through this same
    // runner; an already-observed RPC carries its acceptance port instead.
    if (args.actionId !== 'browser.view.open' || !input.observeExecution
      || args.context.operationAcceptance?.actionId === args.actionId) return await execute(args);
    const context: RpcActionExecutorContext = args.context;
    const observed = await input.observeExecution({ actionId: args.actionId, input: args.input,
      ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
      ...(context.defaultSessionId ? { sessionId: context.defaultSessionId } : {}),
      rpcContext: context,
      execute: async operation => {
        // Acceptance returns before installation settles. Keep the admitted
        // requester alive through this operation's actual effect and completion.
        const release = readRequesterAccountActionContext(context.externalActionExecutionAuthorization)?.retain();
        try {
          const result = await execute({ ...args, context: { ...context, ...operation } });
          const failure = ActionExecuteFailureSchema.safeParse(result);
          if (failure.success) return failure.data;
          const terminal = BrowserCommandDispatchResultV1Schema.safeParse(result);
          if (!terminal.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
          // A typed command failure is still the Action's valid result. Retain
          // its completion and retryability facts for callers and bound get readers.
          return { ok: true, result: terminal.data };
        } finally { await release?.(); }
      },
    });
    return observed.ok ? observed.result : observed;
  };
}
