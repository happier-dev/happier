import { createBrowserProfileCookieImporter } from "@/daemon/browser/profiles/importCookies";
import type { BrowserStoragePartitionOwner } from '@/daemon/browser/storage/partitions';
import { invalidateProcessLaunchDiscovery } from "@/processes/launchNotification";
import { join, resolve } from "node:path";
import type { ApiMachineClient } from "@/api/apiMachine";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { createBrowserDiagnosticsRoutes, type BrowserDiagnosticsRoutes } from "@/daemon/browser/diagnostics/routes";
import { createBrowserDiagnosticsActionRoutes, type BrowserDiagnosticsActionRoutes, type BrowserDiagnosticsInteractionTransport } from "@/daemon/browser/diagnostics/actionRoutes";
import { createBrowserDiagnosticsInteractionTransport } from "@/daemon/browser/diagnostics/interactionTransport";
import { createBrowserDiagnosticsDaemonStore } from "@/daemon/browser/diagnostics/store";
import { createBrowserDaemonControlBroker } from "@/daemon/browser/control/broker";
import { createBrowserDaemonControlRoutes, type BrowserDaemonControlRoutes } from "@/daemon/browser/control/routes";
import { createBrowserContextRoutes, type BrowserContextRoutes } from "@/daemon/browser/context/routes";
import { createUnavailableBrowserContextSource, type BrowserContextSource } from "@/daemon/browser/context/source";
import { createSidecarCdpBrowserContextSource } from "@/daemon/browser/context/cdp/productSource";
import { createBrowserContextDiagnosticsSummarySource, type BrowserContextDiagnosticsSummarySource } from "@/daemon/browser/context/diagnostics/summary";
import { createSidecarCdpDiagnosticsRuntime } from "@/daemon/browser/sidecar/diagnostics/runtime";
import { createTransferPathAllowanceRegistry } from "@/transfers/targets/createTransferPathAllowanceRegistry";
import { createBrowserAutomationDaemonService, type BrowserAutomationDaemonService } from "@/daemon/browser/automation/service";
import { createBrowserAutomationRuntimeProvisioner } from "@/daemon/browser/sidecar/provisioning";
import type { ProvisionBrowserAutomationRuntime } from "@/daemon/browser/actions/runtimeActionExecutor";
import { createBrowserAutomationRoutes, type BrowserAutomationRoutes } from "@/daemon/browser/automation/routes";
import { createBrowserAutomationCdpAdapter } from "@/daemon/browser/automation/adapters/cdp";
import type { BrowserAutomationCdpTransport } from "@/daemon/browser/automation/adapters/cdp";
import { createBrowserAutomationOwnerRegistry } from "@/daemon/browser/automation/owners";
import { createControlAdapterAutomationTransport } from "@/daemon/browser/automation/adapters/controlBridge";
import { createBrowserRecordingDaemonRuntime, type BrowserRecordingDaemonRuntime, type BrowserRecordingDaemonRuntimeOptions } from "@/daemon/browser/recording/runtime";
import { resolveBrowserRecordingStartContext as resolveBrowserRecordingStartContextForProducers } from "@/daemon/browser/recording/startContext";
import { resolveFfmpegStaticBinaryPath } from "@/daemon/runtime/ffmpegStatic";
import { createBrowserRecordingNativeViewCaptureCommand } from "@/daemon/browser/recording/adapters/nativeViewCommand";
import { createBrowserRecordingCdpScreencastTransport } from "@/daemon/browser/recording/adapters/cdpScreencastTransport";
import { createBrowserCdpScreencastProducer, type BrowserCdpScreencastProducer } from "@/daemon/browser/capture/cdpScreencast";
import { registerBrowserLiveCapture } from "@/daemon/browser/capture/registration";
import { createDesktopBrowserRecordingNativeViewCaptureTransport, type DesktopBrowserRecordingFrameCaptureInvoke } from "@/daemon/browser/recording/adapters/nativeViewTransport";
import { createReverseDesktopBrowserRecordingNativeViewCaptureInvoke } from "@/daemon/browser/recording/adapters/reverseCaptureInvoke";
import { createDesktopReverseBrowserRecordingCaptureUiCall } from "@/daemon/browser/recording/reverseChannel/desktopReverseCaptureUiCall";
import { createBrowserAutomationReverseDispatcher } from "@/daemon/browser/automation/reverseDispatch";
import type { BrowserUiAutomationRouteOwner } from "@/daemon/runtimeActionExecutor";
import type { BrowserRecordingRoutes } from "@/daemon/browser/recording/routes";
import { createBrowserProfileStore, type BrowserProfileStore } from "@/daemon/browser/profiles/store";
import { createBrowserStoragePartitionOwner } from "@/daemon/browser/storage/partitions";
import type { BrowserSidecarContextCaptureSurface, BrowserSidecarControlAdapterFactory, BrowserSidecarControlAdapterFactoryInput, BrowserSidecarControlAdapterFactoryResult } from "@/daemon/browser/sidecar/controlAdapter";
import { createProductBrowserSidecarControlAdapterFactory } from "@/daemon/browser/sidecar/productSource";
import { createBrowserDaemonFeatureGate, type BrowserDaemonFeatureGate } from "@/daemon/browser/featureGate";
import type { MachineLiveStreamCaptureRegistry } from "@/daemon/peer/mediation/stream";
import { type CliServerFeaturesSnapshot } from "@/features/serverFeaturesClient";
import type { StoredCredentials } from '@/persistence';
import { readOwnSessionMachineWorkspace } from '@/session/machineControlLocality';
import type { DaemonSessionMutationCustody } from "@/daemon/connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody";

export type DaemonBrowserStoragePurgeOwner = Readonly<{
  store: BrowserProfileStore;
  partitionOwner: BrowserStoragePartitionOwner;
  purgeForSessionDeleted: (sessionId: string) => Promise<void>;
  purgeForLogout: () => Promise<void>;
}>;

export function createBrowserRoutePublication({
  params, runtimeActionRouteProviderTarget, resolveServerFeaturesSnapshot,
  setGuardBrowserResourceOwner, shutdownSignal,
}: Readonly<{
  params: Readonly<{
readMachineResourcesPolicy?: import('@/processes/toolIdleTimeouts').MachineResourcesPolicyReader;
machineId: string;
credentials: StoredCredentials;
serverBaseUrl: string;
currentMachineHost?: string | null;
currentMachineHomeDir?: string | null;
daemonSessionMutationCustody: Pick<
      DaemonSessionMutationCustody,
      'stageTranscriptEvent' | 'stageTranscriptMessage'
    > &
      Partial<Pick<DaemonSessionMutationCustody, 'stage'>>;
getApiMachineForSessions: () => ApiMachineClient | null;
onBrowserDiagnosticsRoutesReady?: (
      routes: BrowserDiagnosticsRoutes,
    ) => void;
onBrowserRecordingRoutesReady?: (routes: BrowserRecordingRoutes) => void;
onBrowserRecordingRuntimeReady?: (runtime: BrowserRecordingDaemonRuntime | null) => void;
onBrowserControlRoutesReady?: (routes: BrowserDaemonControlRoutes) => void;
onBrowserContextRoutesReady?: (routes: BrowserContextRoutes) => void;
onBrowserAutomationRoutesReady?: (routes: BrowserAutomationRoutes) => void;
liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
browserSidecarControlAdapterFactory?: BrowserSidecarControlAdapterFactory;
readMachineMemory?: BrowserSidecarControlAdapterFactoryInput['readMachineMemory'];
browserDaemonFeatureGate?: BrowserDaemonFeatureGate;
browserContextSourceFactory?: (
      input: Readonly<{ machineId: string }>,
    ) => BrowserContextSource;
resolveBrowserRecordingStartContext?: BrowserRecordingDaemonRuntimeOptions['resolveStartContext'];
browserRecordingStreamFrameEncoderFactory?: BrowserRecordingDaemonRuntimeOptions['streamFrameEncoderFactory'];
browserRecordingNativeViewCapture?: BrowserRecordingDaemonRuntimeOptions['nativeViewCapture'];
desktopBrowserRecordingNativeViewCaptureInvoke?: DesktopBrowserRecordingFrameCaptureInvoke;
onBrowserStoragePurgeOwnerReady?: (
      owner: DaemonBrowserStoragePurgeOwner,
    ) => void;
processEnv: NodeJS.ProcessEnv;
}>;
  runtimeActionRouteProviderTarget: Readonly<{
setBrowserDaemonControlRoutesProvider?: (
      provider: (() => BrowserDaemonControlRoutes | null) | null,
    ) => void;
setBrowserDaemonContextRoutesProvider?: (
      provider: (() => BrowserContextRoutes | null) | null,
    ) => void;
setBrowserDaemonAutomationRoutesProvider?: (
      provider: (() => BrowserAutomationRoutes | null) | null,
    ) => void;
setBrowserUiAutomationProvider?: (
      provider: (() => BrowserUiAutomationRouteOwner | null) | null,
    ) => void;
setBrowserAutomationRuntimeProvisionerProvider?: (
      provider: (() => ProvisionBrowserAutomationRuntime | null) | null,
    ) => void;
setBrowserDiagnosticsActionRoutesProvider?: (
      provider: (() => BrowserDiagnosticsActionRoutes | null) | null,
    ) => void;
setBrowserRecordingRoutesProvider?: (
      provider: (() => BrowserRecordingRoutes | null) | null,
    ) => void;
}>;
  resolveServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  setGuardBrowserResourceOwner: (owner: Pick<Extract<BrowserSidecarControlAdapterFactoryResult, { ok: true }>, 'adapter' | 'readProcessRoots' | 'readResourceTargets'>) => void;
  shutdownSignal: AbortSignal;
}>): Readonly<{
    refreshBrowserRouteOwners: () => Promise<void>;
    publishBrowserRouteOwners: () => void;
    publishBrowserAutomationRuntimeProvisioner: () => void;
    retire: () => void;
    dispose: () => Promise<void>;
    stopRecording: () => void;
    purgeBrowserStorageForSessionDeleted: (sessionId: string) => Promise<void>;
    purgeBrowserStorageForLogout: () => Promise<void>;
}> {
  let controlRuntimeResourcesDisposed = false;
  // OWNER-GATE: one daemon-boundary browser feature gate. The first startup pass keeps the daemon
  // fail-closed when the server feature snapshot is unavailable; the returned
  // refreshBrowserRouteOwners() method re-runs the SAME gate/producer construction after the
  // central server-features store recovers (for example after machine-registration retry).
  const browserDaemonFeatureGate =
    params.browserDaemonFeatureGate ??
    createBrowserDaemonFeatureGate({
      env: params.processEnv,
      resolveServerFeaturesSnapshot,
      onError: (error) => {
        logger.debug(
          '[DAEMON RUN] Browser daemon feature gate refresh failed (non-fatal)',
          error,
        );
      },
    });
  const browserDiagnosticsStore = createBrowserDiagnosticsDaemonStore({
    machineId: params.machineId,
  });
  // SB-G: the offline-diagnostics summaries read the store on demand instead of retaining a second
  // copy of the same redacted event stream under the same view key. The store is the one retainer,
  // so a view's diagnostics are pruned exactly once by the bridge's view-close / session-close
  // clears (BRW-6 purge posture) and the two buffers cannot diverge.
  const browserContextDiagnosticsSummarySource: BrowserContextDiagnosticsSummarySource =
    createBrowserContextDiagnosticsSummarySource({
      store: browserDiagnosticsStore,
    });
  let browserDiagnosticsRoutes: BrowserDiagnosticsRoutes | null = null;
  // DEV-5 / DIAG-INTERACTION: the `browser.diagnostics.*` runtime-action route owner. snapshot/clear
  // are backed by the live daemon diagnostics store; the interactive verbs (pause/resume/eval/
  // getProperties/releaseObjectGroup/elementPicker) ride the live sidecar CDP interaction transport
  // when the managed-Chromium sidecar exposes one (constructed below, next to the offline-diagnostics
  // runtime, over the SAME live transport + view bindings). Absent ⇒ the interaction verbs stay
  // honestly fail-closed (`browser_diagnostics_route_unavailable`, never a fake success). The route
  // owner is assembled AFTER the sidecar block so it can carry the interaction transport.
  let browserDiagnosticsInteractionTransport: BrowserDiagnosticsInteractionTransport | null =
    null;
  let browserDiagnosticsActionRoutes: BrowserDiagnosticsActionRoutes | null =
    null;
  let browserDiagnosticsActionRoutesHasInteraction = false;
  const browserControlBroker = createBrowserDaemonControlBroker();
  const browserAutomationOwners = createBrowserAutomationOwnerRegistry();
  let browserAutomationCdpTransport: BrowserAutomationCdpTransport | null =
    null;
  const resolveBrowserInputControl = (
    view: Readonly<{ browserSessionId: string; viewId: string }>,
  ) => browserAutomationOwners.getInputControl(view);
  const browserUiAutomation: BrowserUiAutomationRouteOwner = {
    ownsAutomationView: browserControlBroker.ownsView,
    uiAutomation: createBrowserAutomationReverseDispatcher({
      getMachineClient: params.getApiMachineForSessions,
    }),
  };
  runtimeActionRouteProviderTarget.setBrowserUiAutomationProvider?.(
    () => browserUiAutomation,
  );
  let unregisterBrowserSidecarControlAdapter: (() => void) | null = null;
  let disposeBrowserSidecarControlAdapter: (() => void | Promise<void>) | null =
    null;
  let disposeBrowserSidecarDiagnosticsRuntime: (() => void) | null = null;
  let browserControlRoutes: BrowserDaemonControlRoutes | null = null;
  let browserContextRoutes: BrowserContextRoutes | null = null;
  let browserAutomationRoutes: BrowserAutomationRoutes | null = null;
  let disposeBrowserAutomationService: (() => void) | null = null;
  let browserAutomationServiceForCapture: BrowserAutomationDaemonService | null =
    null;
  let browserLiveCaptureRegistration: ReturnType<
    typeof registerBrowserLiveCapture
  > | null = null;
  let browserRecordingRuntime: BrowserRecordingDaemonRuntime | null = null;
  let browserSidecarContextCaptureForRecording: BrowserSidecarContextCaptureSurface | null =
    null;
  let browserCdpScreencastProducer: BrowserCdpScreencastProducer | null = null;
  let browserRecordingRuntimeHasCdpScreencast = false;
  let browserRecordingCdpScreencastAvailable = false;
  let browserControlRoutesPublished = false;
  let browserContextRoutesPublished = false;
  let browserAutomationRoutesPublished = false;
  let browserDiagnosticsRoutesPublished = false;
  let browserRecordingRoutesPublished = false;
  let refreshBrowserRouteOwnersInFlight: Promise<void> | null = null;
  const publishBrowserRouteOwners = (): void => {
    if (browserControlRoutes && !browserControlRoutesPublished) {
      browserControlRoutesPublished = true;
      runtimeActionRouteProviderTarget.setBrowserDaemonControlRoutesProvider?.(
        () => browserControlRoutes,
      );
      params.onBrowserControlRoutesReady?.(browserControlRoutes);
      params
        .getApiMachineForSessions()
        ?.registerBrowserControlRoutes(browserControlRoutes);
    }
    if (browserContextRoutes && !browserContextRoutesPublished) {
      browserContextRoutesPublished = true;
      runtimeActionRouteProviderTarget.setBrowserDaemonContextRoutesProvider?.(
        () => browserContextRoutes,
      );
      params.onBrowserContextRoutesReady?.(browserContextRoutes);
      params
        .getApiMachineForSessions()
        ?.registerBrowserContextRoutes?.(browserContextRoutes);
    }
    if (browserAutomationRoutes && !browserAutomationRoutesPublished) {
      browserAutomationRoutesPublished = true;
      runtimeActionRouteProviderTarget.setBrowserDaemonAutomationRoutesProvider?.(
        () => browserAutomationRoutes,
      );
      params.onBrowserAutomationRoutesReady?.(browserAutomationRoutes);
    }
    if (browserDiagnosticsRoutes && !browserDiagnosticsRoutesPublished) {
      browserDiagnosticsRoutesPublished = true;
      params.onBrowserDiagnosticsRoutesReady?.(browserDiagnosticsRoutes);
      params
        .getApiMachineForSessions()
        ?.registerBrowserDiagnosticsRoutes(browserDiagnosticsRoutes);
    }
    if (browserDiagnosticsActionRoutes) {
      runtimeActionRouteProviderTarget.setBrowserDiagnosticsActionRoutesProvider?.(
        () => browserDiagnosticsActionRoutes,
      );
    }
    if (browserRecordingRuntime && !browserRecordingRoutesPublished) {
      const browserRecordingRoutes = browserRecordingRuntime.routes;
      browserRecordingRoutesPublished = true;
      runtimeActionRouteProviderTarget.setBrowserRecordingRoutesProvider?.(
        () => browserRecordingRoutes,
      );
      params.onBrowserRecordingRoutesReady?.(browserRecordingRoutes);
      params
        .getApiMachineForSessions()
        ?.registerBrowserRecordingRoutes(browserRecordingRoutes);
    }
  };
  const refreshBrowserRouteOwners = async (): Promise<void> => {
    if (controlRuntimeResourcesDisposed || shutdownSignal.aborted) return;
    if (refreshBrowserRouteOwnersInFlight)
      return refreshBrowserRouteOwnersInFlight;
    refreshBrowserRouteOwnersInFlight = (async () => {
      await browserDaemonFeatureGate.refresh();
      if (controlRuntimeResourcesDisposed || shutdownSignal.aborted) return;
      const browserDiagnosticsEnabled = browserDaemonFeatureGate.isEnabled(
        'browser.diagnostics',
      );
      if (browserDiagnosticsEnabled && !browserDiagnosticsRoutes) {
        browserDiagnosticsRoutes = createBrowserDiagnosticsRoutes({
          store: browserDiagnosticsStore,
        });
      }
      if (
        browserDiagnosticsEnabled &&
        (!browserDiagnosticsActionRoutes ||
          (browserDiagnosticsInteractionTransport &&
            !browserDiagnosticsActionRoutesHasInteraction))
      ) {
        browserDiagnosticsActionRoutes = createBrowserDiagnosticsActionRoutes({
          store: browserDiagnosticsStore,
          ...(browserDiagnosticsInteractionTransport
            ? { interaction: browserDiagnosticsInteractionTransport }
            : {}),
        });
        browserDiagnosticsActionRoutesHasInteraction = Boolean(
          browserDiagnosticsInteractionTransport,
        );
      }

      const browserSidecarEnabled =
        browserDaemonFeatureGate.isEnabled('browser.sidecar');
      // E2-F1: this gate used to also require `params.resolveBrowserUseAllowed?.() === true`,
      // a browser-use consent hook that NO production caller has ever passed — `git log -S`
      // over the whole repository history finds it only inside this file and its own test. It
      // was therefore permanently `false`, and this block holds the sole
      // `browserControlBroker.registerAdapter` call plus the only assignments of
      // `browserControlRoutes` / `browserContextRoutes` / `browserAutomationRoutes`, so no
      // agent could ever reach a daemon browser route. It is not a lost producer: no
      // `browserUse` policy owner exists anywhere in the product. Consent for agent-driven
      // browser use is owned by the action-approval danger floor (every
      // `browser.automation.*` id is in `protocol/src/actions/danger.ts`, and
      // `readFeatureEnv.ts` says so verbatim); the server feature bit below is the
      // availability authority. One owner each — no second decision-maker.
      if (browserSidecarEnabled && !unregisterBrowserSidecarControlAdapter) {
        const browserSidecarControlAdapterFactory =
          params.browserSidecarControlAdapterFactory ??
          createProductBrowserSidecarControlAdapterFactory({
            featureEnabled: browserSidecarEnabled,
            profileStore: browserProfileStore,
            readMachineResourcesPolicy: params.readMachineResourcesPolicy,
            // OPEN PRODUCT DECISION (E2-F1, awaiting a user ruling — see
            // `.project/plans/2026-08-23-ru2-surfaces-finalization/lanes/A1.md`).
            // `autoInstallWhenMissing` defaults to `true`, and MCH-2's lazy install is
            // the ONLY production path that can ever place the managed
            // Chrome-for-Testing artifact on disk (`getArchiveDownloadInstallableAdapter`
            // has zero non-test callers). Leaving it defaulted here would make every
            // daemon fetch ~150 MB of third-party Chromium at startup, because
            // `browser.sidecar` is default-ALLOW and this refresh runs on every start.
            // That is a cost/trust change no user has agreed to, so it stays explicitly
            // off: the daemon wires browser control/context/automation the moment a
            // managed Chromium exists on disk, and provisioning it stays a separate,
            // explicit decision. Flip this to `true` to adopt the lazy install.
            autoInstallWhenMissing: false,
          });
        const browserSidecarControlAdapterResult =
          await browserSidecarControlAdapterFactory({
            machineId: params.machineId,
            readMachineMemory: params.readMachineMemory,
            resolveInputControl: resolveBrowserInputControl,
            readSessionIdle: browserAutomationOwners.readSessionIdle,
          });
        if (controlRuntimeResourcesDisposed || shutdownSignal.aborted) {
          if (browserSidecarControlAdapterResult?.ok) {
            await browserSidecarControlAdapterResult.dispose?.();
          }
          return;
        }
        if (browserSidecarControlAdapterResult?.ok) {
          setGuardBrowserResourceOwner(browserSidecarControlAdapterResult);
          invalidateProcessLaunchDiscovery();
          unregisterBrowserSidecarControlAdapter =
            browserControlBroker.registerAdapter(
              browserSidecarControlAdapterResult.adapter,
            );
          disposeBrowserSidecarControlAdapter =
            browserSidecarControlAdapterResult.dispose ?? null;
          if (
            browserControlBroker.hasExecutableAdapters() &&
            !browserControlRoutes
          ) {
            browserControlRoutes = createBrowserDaemonControlRoutes({
              importCookies: createBrowserProfileCookieImporter(browserSidecarControlAdapterResult.contextCapture),
              broker: browserControlBroker,
              captureRegistry: params.liveStreamCaptureRegistry,
              automation: () => browserAutomationServiceForCapture,
            });
          }
          if (
            browserControlBroker.hasExecutableAdapters() &&
            browserDaemonFeatureGate.isEnabled('browser.context') &&
            !browserContextRoutes
          ) {
            const browserContextSource = params.browserContextSourceFactory
              ? params.browserContextSourceFactory({
                  machineId: params.machineId,
                })
              : browserSidecarControlAdapterResult.contextCapture
                ? createSidecarCdpBrowserContextSource({
                    contextCapture:
                      browserSidecarControlAdapterResult.contextCapture,
                    resolveInputControl: resolveBrowserInputControl,
                    prepareObservation: async (view) => {
                      await browserAutomationOwners.tryReleaseConfidentiality(
                        view,
                      );
                    },
                    readFocusedCredentialTarget: (view) =>
                      browserAutomationCdpTransport?.readFocusedCredentialTarget?.(
                        view,
                      ) ?? Promise.resolve(undefined),
                    workingDirectory: configuration.happyHomeDir,
                    screenshotMediaStorage: 'daemon',
                    pathAllowanceRegistry:
                      createTransferPathAllowanceRegistry(),
                    diagnosticsSummarySource:
                      browserContextDiagnosticsSummarySource,
                  })
                : createUnavailableBrowserContextSource();
            browserContextRoutes = createBrowserContextRoutes({
              ownerAccountId: params.machineId,
              source: browserContextSource,
              resolveInputControl: resolveBrowserInputControl,
              // Recheck the live feature and active Session profile. The capture source
              // supplies privacy facts to the shared Protocol export decision.
              resolveGate: (view) => {
                const profile =
                  browserSidecarControlAdapterResult.contextCapture?.resolveProfile?.(
                    view,
                  );
                return {
                  featureEnabled:
                    browserDaemonFeatureGate.isEnabled('browser.context'),
                  // Privacy intent is Session ownership, not storage retention.
                  policyAllowed:
                    profile?.owner.kind === 'session' &&
                    profile.owner.id === view.browserSessionId &&
                    profile.lifecycleState === 'active',
                  runtimeAvailable: Boolean(
                    browserSidecarControlAdapterResult.contextCapture?.resolvePageHandle(
                      view,
                    ),
                  ),
                };
              },
            });
          }
          // Human sidecar commands can mutate a page while agent automation is disabled.
          // They share the same input authority and drain as automation and streamed human input.
          if (
            browserControlBroker.hasExecutableAdapters() &&
            !browserAutomationServiceForCapture
          ) {
            const browserSidecarContextCapture =
              browserSidecarControlAdapterResult.contextCapture;
            browserAutomationCdpTransport =
              createControlAdapterAutomationTransport({
                adapter: browserSidecarControlAdapterResult.adapter,
                summarizeDiagnostics: (view) => {
                  const consoleSummary =
                    browserContextDiagnosticsSummarySource.summarize({
                      ...view,
                      kind: 'browserConsoleSummary',
                    });
                  const networkSummary =
                    browserContextDiagnosticsSummarySource.summarize({
                      ...view,
                      kind: 'browserNetworkSummary',
                    });
                  if (!consoleSummary && !networkSummary) return null;
                  return {
                    summary: [consoleSummary?.summary, networkSummary?.summary]
                      .filter(Boolean)
                      .join('\n'),
                    ...(consoleSummary?.truncated || networkSummary?.truncated
                      ? { truncated: true }
                      : {}),
                  };
                },
                ...(browserContextRoutes
                  ? { browserContext: browserContextRoutes }
                  : {}),
                ...(browserSidecarContextCapture
                  ? { contextCapture: browserSidecarContextCapture }
                  : {}),
              });
            const browserAutomationService =
              createBrowserAutomationDaemonService({
                owners: browserAutomationOwners,
                adapter: createBrowserAutomationCdpAdapter({
                  transport: browserAutomationCdpTransport,
                }),
                ...(browserSidecarContextCapture?.subscribeViewLifecycle
                  ? {
                      subscribeViewLifecycle:
                        browserSidecarContextCapture.subscribeViewLifecycle,
                    }
                  : {}),
              });
            disposeBrowserAutomationService = () =>
              browserAutomationService.dispose();
            browserAutomationServiceForCapture = browserAutomationService;
          }
          const browserSidecarContextCapture =
            browserSidecarControlAdapterResult.contextCapture;
          browserSidecarContextCaptureForRecording =
            browserSidecarContextCapture ?? null;
          if (
            browserSidecarContextCapture?.subscribeCdpEvents &&
            !browserCdpScreencastProducer
          ) {
            browserCdpScreencastProducer = createBrowserCdpScreencastProducer({
              contextCapture: browserSidecarContextCapture,
              resolveInputControl: resolveBrowserInputControl,
            });
          }
          if (
            params.liveStreamCaptureRegistry &&
            browserSidecarContextCapture &&
            browserCdpScreencastProducer &&
            !browserLiveCaptureRegistration
          ) {
            browserLiveCaptureRegistration = registerBrowserLiveCapture({
              registry: params.liveStreamCaptureRegistry,
              contextCapture: browserSidecarContextCapture,
              producer: browserCdpScreencastProducer,
              automation: () => browserAutomationServiceForCapture,
              resolveInputControl: resolveBrowserInputControl,
            });
          }
          if (
            browserDiagnosticsEnabled &&
            !disposeBrowserSidecarDiagnosticsRuntime &&
            browserSidecarContextCapture?.subscribeCdpEvents &&
            browserSidecarContextCapture.subscribeViewLifecycle
          ) {
            const subscribeCdpEvents =
              browserSidecarContextCapture.subscribeCdpEvents;
            const subscribeViewLifecycle =
              browserSidecarContextCapture.subscribeViewLifecycle;
            const diagnosticsRuntime = createSidecarCdpDiagnosticsRuntime({
              ownerAccountId: params.machineId,
              store: browserDiagnosticsStore,
              resolveInputControl: resolveBrowserInputControl,
              contextCapture: {
                transport: browserSidecarContextCapture.transport,
                resolvePageHandle: (view) =>
                  browserSidecarContextCapture.resolvePageHandle(view),
                subscribeCdpEvents,
                subscribeViewLifecycle,
              },
              isEnabled: () =>
                browserDaemonFeatureGate.isEnabled('browser.diagnostics'),
              onError: (error) => {
                logger.debug(
                  '[DAEMON RUN] Browser sidecar diagnostics runtime error (non-fatal)',
                  error,
                );
              },
            });
            disposeBrowserSidecarDiagnosticsRuntime = () =>
              diagnosticsRuntime.dispose();
          }
          if (
            browserDiagnosticsEnabled &&
            !browserDiagnosticsInteractionTransport &&
            browserSidecarContextCapture?.transport &&
            browserSidecarContextCapture.subscribeViewLifecycle
          ) {
            const subscribeViewLifecycle =
              browserSidecarContextCapture.subscribeViewLifecycle;
            const interactionContextCapture = browserSidecarContextCapture;
            browserDiagnosticsInteractionTransport =
              createBrowserDiagnosticsInteractionTransport({
                resolveInputControl: resolveBrowserInputControl,
                contextCapture: {
                  transport: interactionContextCapture.transport,
                  resolvePageHandle: (view) =>
                    interactionContextCapture.resolvePageHandle(view),
                  subscribeViewLifecycle,
                  ...(interactionContextCapture.subscribeCdpEvents
                    ? {
                        subscribeCdpEvents:
                          interactionContextCapture.subscribeCdpEvents,
                      }
                    : {}),
                },
                onError: (error) => {
                  logger.debug(
                    '[DAEMON RUN] Browser diagnostics interaction transport error (non-fatal)',
                    error,
                  );
                },
              });
            browserDiagnosticsActionRoutes =
              createBrowserDiagnosticsActionRoutes({
                store: browserDiagnosticsStore,
                interaction: browserDiagnosticsInteractionTransport,
              });
            browserDiagnosticsActionRoutesHasInteraction = true;
          }
        } else if (
          browserSidecarControlAdapterResult &&
          !browserSidecarControlAdapterResult.ok
        ) {
          logger.debug(
            '[DAEMON RUN] Browser sidecar control adapter unavailable',
            {
              errorCode: browserSidecarControlAdapterResult.errorCode,
              disabledReason: browserSidecarControlAdapterResult.disabledReason,
            },
          );
        }
      }
      if (
        browserAutomationServiceForCapture &&
        browserDaemonFeatureGate.isEnabled('browser.automation') &&
        !browserAutomationRoutes
      ) {
        browserAutomationRoutes = createBrowserAutomationRoutes({
          service: browserAutomationServiceForCapture,
        });
      }
      if (
        browserRecordingRuntime &&
        browserSidecarContextCaptureForRecording?.subscribeCdpEvents &&
        !browserRecordingRuntimeHasCdpScreencast
      ) {
        browserRecordingRuntime.stop();
        browserRecordingRuntime = null;
        params.onBrowserRecordingRuntimeReady?.(null);
        browserRecordingRoutesPublished = false;
        runtimeActionRouteProviderTarget.setBrowserRecordingRoutesProvider?.(
          null,
        );
        browserRecordingRuntimeHasCdpScreencast = false;
      }
      if (
        browserDaemonFeatureGate.isEnabled('browser.recording') &&
        !browserRecordingRuntime
      ) {
        const cdpScreencastTransport = browserCdpScreencastProducer && browserSidecarContextCaptureForRecording
          ? createBrowserRecordingCdpScreencastTransport({
              producer: browserCdpScreencastProducer,
              contextCapture: browserSidecarContextCaptureForRecording,
              resolveInputControl: resolveBrowserInputControl,
            })
          : null;
        browserRecordingCdpScreencastAvailable = Boolean(
          cdpScreencastTransport,
        );
        browserRecordingRuntime = createBrowserRecordingDaemonRuntime({
          workingDirectory: configuration.happyHomeDir,
          resolveInputControl: resolveBrowserInputControl,
          resolveWorkingDirectory: async ({ sessionId }) => {
            const workspace = await readOwnSessionMachineWorkspace({
              credentials: params.credentials,
              serverHttpBaseUrl: params.serverBaseUrl,
              sessionId,
              machineId: params.machineId,
              currentMachineHost: params.currentMachineHost ?? '',
              currentMachineHomeDir: params.currentMachineHomeDir ?? '',
              signal: shutdownSignal,
            });
            if (!workspace)
              throw new Error(
                'Browser recording session working directory is unavailable.',
              );
            return workspace.rootPath;
          },
          commitAttachment: async ({ sessionId, localId, meta }) => {
            await params.daemonSessionMutationCustody.stageTranscriptMessage({
              sessionId,
              localId,
              messageRole: 'user',
              payload: {
                role: 'user',
                content: { type: 'text', text: 'Browser recording' },
                meta,
              },
            });
          },
          liveStreamCaptureRegistry: params.liveStreamCaptureRegistry,
          streamFrameEncoderFactory:
            params.browserRecordingStreamFrameEncoderFactory,
          ...(browserRecordingNativeViewCapture
            ? { nativeViewCapture: browserRecordingNativeViewCapture }
            : {}),
          ...(cdpScreencastTransport
            ? { cdpScreencast: { transport: cdpScreencastTransport } }
            : {}),
          resolveStartContext: resolveBrowserRecordingStartContext,
        });
        params.onBrowserRecordingRuntimeReady?.(browserRecordingRuntime);
        browserRecordingRuntimeHasCdpScreencast = Boolean(
          cdpScreencastTransport,
        );
      }
      publishBrowserRouteOwners();
    })().finally(() => {
      refreshBrowserRouteOwnersInFlight = null;
    });
    return refreshBrowserRouteOwnersInFlight;
  };
  // Recording start-context: explicit override wins (QA/tests); otherwise the production
  // resolver flips each recording capability ON only where the matching producer actually
  // exists: PMS stream-frame registry, desktop native-view capture, and/or managed-Chromium
  // CDP screencast. A producer never stands in as proof for a different capture profile.
  // Desktop daemon entrypoint wiring (BA-4 + W2C-BA-1): prefer a directly-injected producer
  // (tests/QA), then a directly-injected desktop invoke (tests/QA), else the canonical CROSS-PROCESS
  // reverse channel — the spawned cli daemon cannot `invokeTauri` the desktop Wry WebView directly
  // (separate OS process), so it asks the connected desktop UI to capture each reference-only frame
  // over the persistent machine socket (`RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME`). Transport
  // construction is not proof of platform support. Start resolves the actual
  // producer through the live RPC registry, then its UI/native command validates
  // capture support before a frame or successful recording can exist. Positive
  // registration hints cannot prove non-support after reconnect.
  const desktopBrowserRecordingNativeViewCaptureInvoke: DesktopBrowserRecordingFrameCaptureInvoke =
    params.desktopBrowserRecordingNativeViewCaptureInvoke ??
    createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({
      callUi: createDesktopReverseBrowserRecordingCaptureUiCall({
        getMachineClient: () => params.getApiMachineForSessions() ?? null,
      }),
    });
  const browserRecordingNativeViewCapture: NonNullable<BrowserRecordingDaemonRuntimeOptions['nativeViewCapture']> =
    params.browserRecordingNativeViewCapture ?? {
      captureCommand: createBrowserRecordingNativeViewCaptureCommand({
        transport: createDesktopBrowserRecordingNativeViewCaptureTransport({
          invokeRecordingFrameCapture:
            desktopBrowserRecordingNativeViewCaptureInvoke,
          workingDirectory: configuration.happyHomeDir,
        }),
      }),
    };
  const resolveBrowserRecordingStartContext =
    params.resolveBrowserRecordingStartContext ??
    (async (startInput) =>
      resolveBrowserRecordingStartContextForProducers({
        hasLiveStreamCaptureRegistry: Boolean(params.liveStreamCaptureRegistry),
        hasNativeViewCapture: browserRecordingNativeViewCapture.isPlatformCaptureSupported?.() !== false,
        hasCdpScreencast: browserRecordingCdpScreencastAvailable,
        hasFrameEncoder: Boolean(params.browserRecordingStreamFrameEncoderFactory)
          || ((Boolean(params.liveStreamCaptureRegistry) || browserRecordingCdpScreencastAvailable)
            && Boolean(await resolveFfmpegStaticBinaryPath())),
      })(startInput));
  // BRW-6 privacy: daemon-side owner of on-disk browser profile/partition purge. Subscribed
  // to the session-deleted signal (purges session profiles and cleanup-on-close ephemeral profiles) and the
  // logout transition (purges `ephemeral` profiles + partitions). Fail-closed: a failed disk
  // purge marks the profile `unusable` and emits an audit; it is never silently reused.
  const browserStoragePartitionOwner = createBrowserStoragePartitionOwner({
    storageRootDirectory: configuration.happyHomeDir,
  });
  const browserProfileStore: BrowserProfileStore = createBrowserProfileStore({
    storageRootDirectory: configuration.happyHomeDir,
    partitionOwner: browserStoragePartitionOwner,
    emitAudit: (record) => {
      logger.debug('[DAEMON RUN] Browser profile purge audit', record);
    },
  });
  const purgeBrowserStorageForSessionDeleted = async (
    sessionId: string,
  ): Promise<void> => {
    const trimmed = sessionId.trim();
    if (!trimmed) return;
    const outcome = await browserProfileStore.purgeForSessionDeleted({
      sessionId: trimmed,
    });
    if (outcome.failedProfileIds.length > 0) {
      logger.debug(
        '[DAEMON RUN] Browser storage session-delete purge failed for profiles',
        {
          sessionId: trimmed,
          failedProfileIds: outcome.failedProfileIds,
        },
      );
    }
  };
  const purgeBrowserStorageForLogout = async (): Promise<void> => {
    const outcome = await browserProfileStore.purgeForLogout();
    if (outcome.failedProfileIds.length > 0) {
      logger.debug(
        '[DAEMON RUN] Browser storage logout purge failed for profiles',
        {
          failedProfileIds: outcome.failedProfileIds,
        },
      );
    }
  };
  params.onBrowserStoragePurgeOwnerReady?.({
    store: browserProfileStore,
    partitionOwner: browserStoragePartitionOwner,
    purgeForSessionDeleted: purgeBrowserStorageForSessionDeleted,
    purgeForLogout: purgeBrowserStorageForLogout,
  });
  const publishBrowserAutomationRuntimeProvisioner = (): void => {
  // Install-on-first-automation-attempt (user ruling, 2026-08-23). Startup deliberately does NOT
  // fetch the ~150MB managed Chromium (`autoInstallWhenMissing: false` above); the provisioner is
  // published so the FIRST `browser.automation.*` dispatch that finds no route can start the
  // fetch and, when it lands, refresh these same route owners. No feature check here: the browser
  // action executor already refuses the family when `browser.automation` is server-disabled, and a
  // second gate would be a second decision-maker for one question.
  const browserAutomationRuntimeProvisioner =
    createBrowserAutomationRuntimeProvisioner({
      refreshRouteOwners: refreshBrowserRouteOwners,
      onError: (error) => {
        logger.debug(
          '[DAEMON RUN] Managed browser runtime provisioning failed (non-fatal)',
          error,
        );
      },
    });
  runtimeActionRouteProviderTarget.setBrowserAutomationRuntimeProvisionerProvider?.(
    () => browserAutomationRuntimeProvisioner.provision,
  );
  };
  const retire = (): void => { controlRuntimeResourcesDisposed = true; };
  const dispose = async (): Promise<void> => {
    if (browserControlRoutes) {
      runtimeActionRouteProviderTarget.setBrowserDaemonControlRoutesProvider?.(
        null,
      );
    }
    if (browserContextRoutes) {
      runtimeActionRouteProviderTarget.setBrowserDaemonContextRoutesProvider?.(
        null,
      );
    }
    if (browserAutomationRoutes) {
      runtimeActionRouteProviderTarget.setBrowserDaemonAutomationRoutesProvider?.(
        null,
      );
    }
    runtimeActionRouteProviderTarget.setBrowserAutomationRuntimeProvisionerProvider?.(
      null,
    );
    runtimeActionRouteProviderTarget.setBrowserUiAutomationProvider?.(null);
    if (browserDiagnosticsActionRoutes) {
      runtimeActionRouteProviderTarget.setBrowserDiagnosticsActionRoutesProvider?.(
        null,
      );
    }
    if (browserRecordingRuntime) {
      runtimeActionRouteProviderTarget.setBrowserRecordingRoutesProvider?.(
        null,
      );
    }
    await browserDiagnosticsInteractionTransport?.dispose();
    browserDiagnosticsInteractionTransport = null;
    browserLiveCaptureRegistration?.dispose();
    browserLiveCaptureRegistration = null;
    disposeBrowserAutomationService?.();
    disposeBrowserAutomationService = null;
    browserAutomationServiceForCapture = null;
    disposeBrowserSidecarDiagnosticsRuntime?.();
    unregisterBrowserSidecarControlAdapter?.();
    await browserCdpScreencastProducer?.dispose().catch((error: unknown) => {
      logger.debug(
        '[DAEMON RUN] Failed to stop browser screencast producer',
        error,
      );
    });
    browserCdpScreencastProducer = null;
    await disposeBrowserSidecarControlAdapter?.();
  };
  const stopRecording = (): void => {
    browserRecordingRuntime?.stop();
    browserRecordingRuntime = null;
    params.onBrowserRecordingRuntimeReady?.(null);
  };
  return { refreshBrowserRouteOwners, publishBrowserRouteOwners, publishBrowserAutomationRuntimeProvisioner,
    retire, dispose, stopRecording, purgeBrowserStorageForSessionDeleted, purgeBrowserStorageForLogout };
}
