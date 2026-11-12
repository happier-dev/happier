import { configuration } from '@/configuration';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { logger } from '@/ui/logger';
import { DEFAULT_COMPUTER_USE_SETTINGS_V1, readComputerUseSettingsForMachine } from '@happier-dev/protocol/computer/v1';

import { createBrowserRoutePublication } from '@/daemon/browser/control/routePublication';
import type { BrowserSidecarControlAdapterFactoryResult } from '@/daemon/browser/sidecar/controlAdapter';
import type { ComputerRequesterHost } from '@/daemon/computer/requester';
import { createComputerRoutes, type ComputerRoutes } from '@/daemon/computer/routes';
import { createComposedSimulatorPreviewAdapter } from '@/daemon/devices/simulator/adapter';
import { createDefaultAndroidSimulatorResourcesDiscovery } from '@/daemon/devices/simulator/android/discovery';
import { createAndroidScrcpyTunnelOwner } from '@/daemon/devices/simulator/android/tunnelOwner';
import { createSimulatorCaptureAdapterForResource } from '@/daemon/devices/simulator/captureAdapters';
import { createSimulatorCaptureRegistryReconciler } from '@/daemon/devices/simulator/captureRegistration';
import {
  createDefaultIosSimulatorResourcesDiscovery,
  resolveIosSimulatorCaptureAdapterAvailability,
  resolvePinnedIosSimulatorHelperArtifact,
} from '@/daemon/devices/simulator/ios/discovery';
import { createIosSimulatorHelperSession } from '@/daemon/devices/simulator/ios/helperSession';
import { verifyIosSimulatorHelperSignature } from '@/daemon/devices/simulator/ios/signature';
import type { SimulatorInputLeaseManager } from '@/daemon/devices/simulator/lease';
import { createAndroidSimulatorPlatformAdapter } from '@/daemon/devices/simulator/platform/android';
import { createIosSimulatorPlatformAdapter } from '@/daemon/devices/simulator/platform/ios';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import { createSimulatorPreviewDaemonRuntime } from '@/daemon/devices/simulator/runtime';
import { createSimulatorStreamControlBridge } from '@/daemon/devices/simulator/streamControlBridge';
import { createRecordingSessionMediaHost } from '@/daemon/recording/sessionMediaHost';

import type { MachineRoleStopReason } from '../types';


type BrowserRoutePublicationInput = Parameters<typeof createBrowserRoutePublication>[0];
type BrowserResourceOwner = Pick<Extract<BrowserSidecarControlAdapterFactoryResult, { ok: true }>, 'adapter' | 'readProcessRoots' | 'readResourceTargets'>;

export type DevicesRoleContext = Readonly<{
  /** The daemon-level inputs; the browser route publication reads the same object. */
  params: BrowserRoutePublicationInput['params'] & Readonly<{
    simulatorInputLeaseManager?: SimulatorInputLeaseManager;
    onComputerRoutesReady?: (resolveComputer: () => ComputerRoutes | null) => void;
    onSimulatorPreviewRoutesReady?: (routes: SimulatorPreviewRoutes) => void;
    /** The role stopped: every route it published through these callbacks is withdrawn. */
    onDevicesRoleStopped?: () => void;
  }>;
  /** Runtime-action route providers on the daemon's Action executor (computer, simulator, browser). */
  runtimeActionRouteProviderTarget: BrowserRoutePublicationInput['runtimeActionRouteProviderTarget'] & Readonly<{
    setComputerRoutesProvider?: (provider: (() => ComputerRoutes | null) | null) => void;
    setSimulatorPreviewRoutesProvider?: (provider: (() => SimulatorPreviewRoutes | null) | null) => void;
  }>;
  resolveServerFeaturesSnapshot: BrowserRoutePublicationInput['resolveServerFeaturesSnapshot'];
  readSessionAccountId: BrowserRoutePublicationInput['readSessionAccountId'];
  /** Requester custody is machine core's; computer use consumes it. */
  computerRequesterHost: ComputerRequesterHost;
  /** Daemon work signal: aborts on daemon shutdown. */
  shutdownSignal: AbortSignal;
}>;

export type DevicesRoleActivation = Readonly<{
  computerRoutes: () => ComputerRoutes | null;
  simulatorPreviewRoutes: SimulatorPreviewRoutes;
  browser: Readonly<{
    refreshRouteOwners: () => Promise<void>;
    purgeForSessionDeleted: (sessionId: string) => Promise<void>;
    purgeForLogout: () => Promise<void>;
    /** The managed browser's resources for Guard and the process census (null until one runs). */
    resourceOwner: () => BrowserResourceOwner | null;
  }>;
  /** Long-lived helper processes the role owns (iOS simulator helper). */
  readHelperProcessRoots: () => ReturnType<ReturnType<typeof createIosSimulatorHelperSession>['readProcessRoots']>;
  /**
   * `inactive`: the role was turned off, so the data only it can reach (Session and ephemeral
   * browser profiles) is purged first. `shutdown`: the daemon stops; data stays as today.
   */
  stop: (reason?: MachineRoleStopReason) => Promise<void>;
}>;

/**
 * `devices` role: simulator preview, computer use and the browser runtime, with their RPC families
 * and runtime-action routes. Loaded by `import()` only while the role is active; `stop()` withdraws
 * every route it published and stops its helpers.
 */
export async function activateDevicesRole(ctx: DevicesRoleContext): Promise<DevicesRoleActivation> {
  const { params, runtimeActionRouteProviderTarget } = ctx;
  let stopped = false;
  let guardBrowserResourceOwner: BrowserResourceOwner | null = null;
  const androidScrcpyTunnelOwner = createAndroidScrcpyTunnelOwner();
  // iOS capture-availability gate (capability-truth): trust is derived ONLY from a daemon-side
  // signature/notarization + digest verification of the vendored helper artifact. Until the
  // signed/notarized helper is produced and pinned (see scripts/buildIosSimulatorHelper.mjs +
  // PINNED_IOS_SIMULATOR_HELPER_ARTIFACT), this resolves to false and iOS stays fail-closed.
  const verifyIosHelperSignature = (path: string) => verifyIosSimulatorHelperSignature({ path });
  // Resolve the pinned vendored helper through the full digest + Developer ID signature +
  // notarization verification chain ONCE. The same verified resolution drives both the
  // capture-availability gate and the helper-session owner's process path, so a verified
  // resource always has a real producer + input sender behind it (capability-truth). While the
  // placeholder digest is pinned (no signed/notarized artifact produced yet), this fails closed.
  const iosSimulatorHelperArtifact = await resolvePinnedIosSimulatorHelperArtifact({
    verifyHelperSignature: verifyIosHelperSignature,
  });
  const iosSimulatorCaptureAdapterAvailable = await resolveIosSimulatorCaptureAdapterAvailability({
    resolveHelperArtifact: async () => iosSimulatorHelperArtifact,
  });
  // Single long-lived `--daemon-json` helper-session owner: the iOS analog of the Android scrcpy
  // server handle. It owns the piped child process and is BOTH the frame-stream producer
  // (openStream) AND the input command sender (sendCommand). Constructed only when the artifact
  // verified, so capture/input are never silently no-ops behind an unverified binary.
  const iosSimulatorHelperSession = iosSimulatorHelperArtifact.ok
    ? createIosSimulatorHelperSession({ helperPath: iosSimulatorHelperArtifact.path })
    : null;
  const simulatorPreviewAdapter = createComposedSimulatorPreviewAdapter({
    platforms: [
      createIosSimulatorPlatformAdapter({
        captureAdapterAvailable: iosSimulatorCaptureAdapterAvailable,
        discoverResources: createDefaultIosSimulatorResourcesDiscovery({
          captureAdapterAvailable: iosSimulatorCaptureAdapterAvailable,
          verifyHelperSignature: verifyIosHelperSignature,
        }),
        ...(iosSimulatorHelperSession ? { sendInputCommand: iosSimulatorHelperSession.sendCommand } : {}),
      }),
      createAndroidSimulatorPlatformAdapter({
        discoverResources: createDefaultAndroidSimulatorResourcesDiscovery(),
        resolveScrcpyControl: ({ serial }) => androidScrcpyTunnelOwner.getControl({ serial }),
        stopScrcpyControl: () => androidScrcpyTunnelOwner.stop(),
      }),
    ],
  });
  // PATCH-01 / A1: the bridge from the simulator encoder-control RPC entry point to the live
  // capture session's `applySidebandControl` sink. `wrapCaptureAdapter` records each started
  // session's sideband sink (keyed by the relay streamId) so `dispatchStreamControl` forwards a
  // `simulator.quality.set` / `simulator.keyframe.request` RPC into the SAME session the relay
  // terminator drives — not a parallel control path.
  const simulatorStreamControlBridge = createSimulatorStreamControlBridge();
  const simulatorPreviewRuntime = createSimulatorPreviewDaemonRuntime({
    machineId: params.machineId,
    adapter: simulatorPreviewAdapter,
    dispatchStreamControl: simulatorStreamControlBridge.dispatch,
    ...(params.simulatorInputLeaseManager ? { leaseManager: params.simulatorInputLeaseManager } : {}),
    ...(params.liveStreamCaptureRegistry
      ? {
          captureReconciler: createSimulatorCaptureRegistryReconciler({
            registry: params.liveStreamCaptureRegistry,
            createAdapter: (resource) =>
              simulatorStreamControlBridge.wrapCaptureAdapter(
                createSimulatorCaptureAdapterForResource(resource, {
                  android: {
                    // Encoder-control (set_quality / request_keyframe / snapshot) + adaptive
                    // bitrate are backed by the server-restart producer: scrcpy runs
                    // raw_stream=true so encoder params are fixed at launch and only change
                    // via a clean server restart through the tunnel owner (which keeps the
                    // shared input control sender in sync).
                    ensureServer: androidScrcpyTunnelOwner.ensureServer,
                    restartServer: androidScrcpyTunnelOwner.restartServer,
                    adaptiveBitrate: true,
                  },
                  // iOS MJPEG frame producer. openStream is supplied ONLY when the signed
                  // helper artifact verified (capability-truth: a verified resource always
                  // has a real producer behind it). While unverified, openStream is omitted
                  // and the iOS branch returns the typed-unavailable capture adapter.
                  ios: iosSimulatorHelperSession ? { openStream: iosSimulatorHelperSession.openStream } : {},
                }),
              ),
          }),
        }
      : {}),
  });
  // Driver installation/capture is lazy and follows an approved explicit-target Action,
  // never daemon startup. Native lifecycle uses the already-published capture registry.
  let computerRoutes: ComputerRoutes | null = params.liveStreamCaptureRegistry
    ? createComputerRoutes({
        machineId: params.machineId,
        machineDisplayName: params.currentMachineHost ?? undefined,
        registry: params.liveStreamCaptureRegistry,
        defaultDisplayId: process.env.DISPLAY,
        recording: {
          workingDirectory: configuration.happyHomeDir,
          ...createRecordingSessionMediaHost({
            credentials: params.credentials, serverHttpBaseUrl: params.serverBaseUrl,
            machineId: params.machineId, currentMachineHost: params.currentMachineHost ?? '',
            currentMachineHomeDir: params.currentMachineHomeDir ?? '',
            signal: ctx.shutdownSignal,
            mutationCustody: params.daemonSessionMutationCustody, title: 'Computer recording',
          }),
        },
        requesterHost: ctx.computerRequesterHost,
        resolveProviderSettings: () => {
          const settings = getActiveAccountSettingsSnapshot()?.settings;
          return settings ? readComputerUseSettingsForMachine(settings, params.machineId) : DEFAULT_COMPUTER_USE_SETTINGS_V1;
        },
      })
    : null;
  const resolveComputer = () => computerRoutes;
  runtimeActionRouteProviderTarget.setComputerRoutesProvider?.(resolveComputer);
  // Machine registration may finish after startup: the core attachment cache keeps what these
  // callbacks publish and replays it onto each Machine transport as one owned RPC set.
  params.onComputerRoutesReady?.(resolveComputer);
  const browserRoutePublication = createBrowserRoutePublication({
    params,
    runtimeActionRouteProviderTarget,
    resolveServerFeaturesSnapshot: ctx.resolveServerFeaturesSnapshot,
    readSessionAccountId: ctx.readSessionAccountId,
    shutdownSignal: ctx.shutdownSignal,
    setGuardBrowserResourceOwner: (owner) => { guardBrowserResourceOwner = owner; },
  });
  browserRoutePublication.publishBrowserAutomationRuntimeProvisioner();
  // Browser artifact verification is optional to control readiness. The same
  // refresh owner publishes routes only after its source and feature proof;
  // retirement disposes a late adapter before it can become reachable.
  void browserRoutePublication.refreshBrowserRouteOwners().catch((error) => {
    logger.debug('[DAEMON RUN] Browser route startup refresh failed (non-fatal)', error);
  });
  runtimeActionRouteProviderTarget.setSimulatorPreviewRoutesProvider?.(() => simulatorPreviewRuntime.routes);
  params.onSimulatorPreviewRoutesReady?.(simulatorPreviewRuntime.routes);

  return {
    computerRoutes: resolveComputer,
    simulatorPreviewRoutes: simulatorPreviewRuntime.routes,
    browser: {
      refreshRouteOwners: browserRoutePublication.refreshBrowserRouteOwners,
      purgeForSessionDeleted: browserRoutePublication.purgeBrowserStorageForSessionDeleted,
      purgeForLogout: browserRoutePublication.purgeBrowserStorageForLogout,
      resourceOwner: () => guardBrowserResourceOwner,
    },
    readHelperProcessRoots: () => iosSimulatorHelperSession?.readProcessRoots() ?? [],
    stop: async (reason = 'shutdown') => {
      if (stopped) return;
      stopped = true;
      // Retire first so a late browser refresh cannot publish after the withdrawal.
      browserRoutePublication.retire();
      params.onDevicesRoleStopped?.();
      // The purge settles each profile's engine before deleting its bytes.
      if (reason === 'inactive') await browserRoutePublication.purgeBrowserStorageForRoleDeactivation();
      runtimeActionRouteProviderTarget.setComputerRoutesProvider?.(null);
      const retiringComputerRoutes = computerRoutes;
      computerRoutes = null;
      await retiringComputerRoutes?.dispose();
      await browserRoutePublication.dispose();
      runtimeActionRouteProviderTarget.setSimulatorPreviewRoutesProvider?.(null);
      await browserRoutePublication.stopRecording();
      await simulatorPreviewRuntime.stop();
      guardBrowserResourceOwner = null;
      // Tear down the long-lived iOS helper child process (SIGTERM) so a verified signed helper
      // never outlives the role. No-op when iOS stayed fail-closed (no session was created).
      await iosSimulatorHelperSession?.stop().catch((error: unknown) => {
        logger.debug('[DAEMON RUN] Failed to stop iOS simulator helper session', error);
      });
    },
  };
}
