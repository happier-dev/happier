import type { ApiClient } from '@/api/api';
import type { DaemonState } from '@/api/types';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { logger } from '@/ui/logger';
import { startAutomationWorker, type AutomationWorkerHandle } from '../automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from '../memory/memoryWorker';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import type { startDaemonMachineRegistration } from '../machine/startDaemonMachineRegistration';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../peer/mediation/stream';
import type { Credentials } from '@/persistence';
import packageJson from '../../../package.json';

type BootstrapRuntime = Omit<
  Parameters<typeof startDaemonMachineRegistration>[0]['bootstrapRuntime'],
  | 'preferredHost'
  | 'happyHomeDir'
  | 'happyLibDir'
  | 'filesystemAccessPolicy'
  | 'takeoverRequested'
  | 'connectedServiceRefreshLoopHandle'
  | 'connectedServiceQuotasLoopHandle'
>;

type MachineSyncRuntime = Parameters<typeof startDaemonMachineRegistration>[0]['onMachineSyncRuntime'] extends (
  runtime: infer Runtime,
) => void
  ? Runtime
  : never;

export function createDaemonMachineBootstrapRuntime(
  params: Readonly<{
    api: ApiClient;
    credentials: Credentials;
    diagnosticSubsystemGates: Readonly<{
      disableMachineSync: boolean;
      disableAutomationWorker: boolean;
    }>;
    runtimeId: string;
    publicReleaseChannel: NonNullable<DaemonState['publicReleaseChannel']>;
    startupSource: string;
    serviceLabel: string | undefined;
    transferRuntimeStatePublisher: Readonly<{
      attachApiMachine: (connectedApiMachine: NonNullable<MachineSyncRuntime['apiMachine']>) => Promise<void>;
    }> | null;
    spawnSession: BootstrapRuntime['spawnSession'];
    stopSession: BootstrapRuntime['stopSession'];
    isSessionAlreadyRunning: BootstrapRuntime['isSessionAlreadyRunning'];
    loadLocalSessionMetadataForHandoff: BootstrapRuntime['loadLocalSessionMetadataForHandoff'];
    savePreparedTargetLocalMetadata: BootstrapRuntime['savePreparedTargetLocalMetadata'];
    beforeShutdown: BootstrapRuntime['beforeShutdown'];
    requestShutdown: BootstrapRuntime['requestShutdown'];
    directPeerServerLifecycle: BootstrapRuntime['directPeerServerLifecycle'];
    directTransferPromptAssetAdapterRegistry: BootstrapRuntime['directTransferPromptAssetAdapterRegistry'];
    directTransferPromptRegistryRegistry: BootstrapRuntime['directTransferPromptRegistryRegistry'];
    daemonServerWorkScheduler: BootstrapRuntime['daemonServerWorkScheduler'];
    retryTemporaryThrottleNow?: BootstrapRuntime['retryTemporaryThrottleNow'];
    setDaemonServerWorkOnline: BootstrapRuntime['setDaemonServerWorkOnline'];
    onMachineConnectionOnline: NonNullable<BootstrapRuntime['onMachineConnectionOnline']>;
    isShuttingDown: BootstrapRuntime['isShuttingDown'];
  }>,
): BootstrapRuntime {
  return {
    cliVersion: packageJson.version,
    credentials: params.credentials,
    daemonServerWorkScheduler: params.daemonServerWorkScheduler,
    setDaemonServerWorkOnline: params.setDaemonServerWorkOnline,
    onMachineConnectionOnline: params.onMachineConnectionOnline,
    isShuttingDown: params.isShuttingDown,
    createConnectedApiMachine: (registeredMachine) =>
      params.diagnosticSubsystemGates.disableMachineSync
        ? null
        : params.api.machineSyncClient(registeredMachine, {
            runtimeId: params.runtimeId,
            cliVersion: packageJson.version,
            publicReleaseChannel: params.publicReleaseChannel,
            startupSource: params.startupSource,
            serviceManaged: params.startupSource === 'background-service',
            ...(params.serviceLabel ? { serviceLabel: params.serviceLabel } : null),
          }),
    attachTransferRuntimeStatePublisher: async (connectedApiMachine) => {
      if (!params.transferRuntimeStatePublisher) return;
      await params.transferRuntimeStatePublisher.attachApiMachine(connectedApiMachine);
    },
    startAutomationWorkerForMachine: (runtimeMachineId) => {
      if (params.diagnosticSubsystemGates.disableAutomationWorker) {
        logger.warn('[DAEMON RUN] Diagnostic gate enabled: automation worker disabled');
        return null;
      }
      return startAutomationWorker({
        token: params.credentials.token,
        machineId: runtimeMachineId,
        encryption: params.credentials.encryption,
        spawnSession: params.spawnSession,
      });
    },
    startMemoryWorkerForMachine: async (runtimeMachineId) => {
      try {
        return await startMemoryWorker({
          credentials: params.credentials,
          machineId: runtimeMachineId,
        });
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to start memory worker (best-effort)', error);
        return null;
      }
    },
    startVoiceInferenceWorkerForMachine: async (_runtimeMachineId) => {
      try {
        return await startVoiceInferenceWorker();
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to start voice inference worker (best-effort)', error);
        return null;
      }
    },
    spawnSession: params.spawnSession,
    stopSession: params.stopSession,
    isSessionAlreadyRunning: params.isSessionAlreadyRunning,
    loadLocalSessionMetadataForHandoff: params.loadLocalSessionMetadataForHandoff,
    savePreparedTargetLocalMetadata: params.savePreparedTargetLocalMetadata,
    beforeShutdown: params.beforeShutdown,
    requestShutdown: params.requestShutdown,
    directPeerServerLifecycle: params.directPeerServerLifecycle,
    directTransferPromptAssetAdapterRegistry: params.directTransferPromptAssetAdapterRegistry,
    directTransferPromptRegistryRegistry: params.directTransferPromptRegistryRegistry,
    ...(params.retryTemporaryThrottleNow
      ? { retryTemporaryThrottleNow: params.retryTemporaryThrottleNow }
      : {}),
    peerMediationMachineRpc: {
      stream: {
        captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(),
      },
    },
  };
}
