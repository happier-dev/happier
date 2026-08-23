import type { ApiClient } from '@/api/api';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonState } from '@/api/types';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import type { MachineLiveStreamControlLeaseV1 } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import { startAutomationWorker, type AutomationWorkerHandle } from '../automation/automationWorker';
import { startMemoryWorker, type MemoryWorkerHandle } from '../memory/memoryWorker';
import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import { createDaemonPublicVoiceModelPackRuntime } from '../voiceInference/publicModelPacks/runtime';
import { resolveVoiceInferencePaths } from '../voiceInference/voiceInferencePaths';
import { configuration } from '@/configuration';
import type { startDaemonMachineRegistration } from '../machine/startDaemonMachineRegistration';
import {
  createDaemonMachineLiveStreamCaptureAdapter,
  type MachineLiveStreamCaptureRegistry,
} from '../peer/mediation/stream';
import type { DaemonPeerMediationObservabilityEmitter } from '../peer/mediation/observability/events';
import type { StoredCredentials } from '@/persistence';
import type { NormalizedLocalServiceInventorySnapshot } from '../local/services/inventory/scanner';
import packageJson from '../../../package.json';
import type { PersistedTakeoverAdmissionWaiter } from '../spawn/persistedTakeoverAdmission';
import type {
  ExternalSessionPersistedTakeoverAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type {
  ExternalSessionHostOperationInstallation,
  ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import { MemorySettingsSecretsUnavailableError } from '@/settings/memorySettings';
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';

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
    credentials: StoredCredentials;
    daemonSessionMutationCustody?: DaemonSessionMutationCustody;
    deviceLocalSecretStorage?: DeviceLocalSecretStorage;
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
    awaitAgentSessionOpen: BootstrapRuntime['awaitAgentSessionOpen'];
    isSessionAlreadyRunning: BootstrapRuntime['isSessionAlreadyRunning'];
    loadLocalSessionMetadataForHandoff: BootstrapRuntime['loadLocalSessionMetadataForHandoff'];
    savePreparedTargetLocalMetadata: BootstrapRuntime['savePreparedTargetLocalMetadata'];
    beforeShutdown: BootstrapRuntime['beforeShutdown'];
    requestShutdown: BootstrapRuntime['requestShutdown'];
    directPeerServerLifecycle: BootstrapRuntime['directPeerServerLifecycle'];
    directTransferPromptAssetAdapterRegistry: BootstrapRuntime['directTransferPromptAssetAdapterRegistry'];
    directTransferPromptRegistryRegistry: BootstrapRuntime['directTransferPromptRegistryRegistry'];
    daemonServerWorkScheduler: BootstrapRuntime['daemonServerWorkScheduler'];
    cancelConnectedServiceRuntimeAuthRecovery?: BootstrapRuntime['cancelConnectedServiceRuntimeAuthRecovery'];
    retryTemporaryThrottleNow?: BootstrapRuntime['retryTemporaryThrottleNow'];
    setDaemonServerWorkOnline: BootstrapRuntime['setDaemonServerWorkOnline'];
    onMachineConnectionOnline: NonNullable<BootstrapRuntime['onMachineConnectionOnline']>;
    reconcileConnectedServicesProjection: Parameters<ApiMachineClient['onConnectedServicesProjection']>[0];
    subscribeConnectedAccountInvalidations?: BootstrapRuntime['subscribeConnectedAccountInvalidations'];
    isShuttingDown: BootstrapRuntime['isShuttingDown'];
    getServerFeaturesSnapshot?: BootstrapRuntime['getServerFeaturesSnapshot'];
    liveStreamCaptureRegistry?: MachineLiveStreamCaptureRegistry;
    readActiveLiveStreamControlLease?: (leaseInput: Readonly<{
      streamId: string;
      sourceId: string;
      nowMs: number;
    }>) => MachineLiveStreamControlLeaseV1 | null;
    // PMS-WIRE: shared observability emitter whose store is published on the Api provider bridge.
    peerMediationObservabilityEmitter?: DaemonPeerMediationObservabilityEmitter;
    readLocalServiceInventorySnapshot?: () => Promise<NormalizedLocalServiceInventorySnapshot | null>;
    managedCatalogRuntime?: BootstrapRuntime['managedCatalogRuntime'];
    resolveManagedPurposeBindingIntent?: BootstrapRuntime['resolveManagedPurposeBindingIntent'];
    createAgentCatalogObservation?: BootstrapRuntime['createAgentCatalogObservation'];
    onAutomationWorkerStarted?: (worker: AutomationWorkerHandle) => void;
    prepareApiMachineForSessions?: (apiMachine: ApiMachineClient) => void;
    persistedTakeoverAdmissionWaiter?: PersistedTakeoverAdmissionWaiter;
    attachPersistedTakeoverAdmissionOwner?: (
      owner: ExternalSessionPersistedTakeoverAdmissionOwner,
    ) => () => void;
    installExternalSessionHostOperations?: (
      operations: ExternalSessionHostOperationSet,
    ) => Promise<ExternalSessionHostOperationInstallation>;
    externalActionIngressOwner?: ExternalActionIngressOwner;
  }>,
): BootstrapRuntime {
  let connectedApiMachine: ApiMachineClient | null = null;
  return {
    cliVersion: packageJson.version,
    credentials: params.credentials,
    ...(params.daemonSessionMutationCustody
      ? { daemonSessionMutationCustody: params.daemonSessionMutationCustody }
      : {}),
    ...(params.deviceLocalSecretStorage
      ? { deviceLocalSecretStorage: params.deviceLocalSecretStorage }
      : {}),
    daemonServerWorkScheduler: params.daemonServerWorkScheduler,
    setDaemonServerWorkOnline: params.setDaemonServerWorkOnline,
    onMachineConnectionOnline: params.onMachineConnectionOnline,
    reconcileConnectedServicesProjection: params.reconcileConnectedServicesProjection,
    ...(params.subscribeConnectedAccountInvalidations
      ? { subscribeConnectedAccountInvalidations: params.subscribeConnectedAccountInvalidations }
      : {}),
    isShuttingDown: params.isShuttingDown,
    ...(params.getServerFeaturesSnapshot
      ? { getServerFeaturesSnapshot: params.getServerFeaturesSnapshot }
      : {}),
    createConnectedApiMachine: (registeredMachine) => {
      if (params.diagnosticSubsystemGates.disableMachineSync) return null;
      const apiMachine = params.api.machineSyncClient(registeredMachine, {
            runtimeId: params.runtimeId,
            cliVersion: packageJson.version,
            publicReleaseChannel: params.publicReleaseChannel,
            startupSource: params.startupSource,
            serviceManaged: params.startupSource === 'background-service',
            ...(params.serviceLabel ? { serviceLabel: params.serviceLabel } : null),
          }, {
            isDaemonQuiescing: params.isShuttingDown,
      });
      connectedApiMachine = apiMachine;
      params.prepareApiMachineForSessions?.(apiMachine);
      return apiMachine;
    },
    attachTransferRuntimeStatePublisher: async (connectedApiMachine) => {
      if (!params.transferRuntimeStatePublisher) return;
      await params.transferRuntimeStatePublisher.attachApiMachine(connectedApiMachine);
    },
    startAutomationWorkerForMachine: (runtimeMachineId) => {
      if (params.diagnosticSubsystemGates.disableAutomationWorker) {
        logger.warn('[DAEMON RUN] Diagnostic gate enabled: automation worker disabled');
        return null;
      }
      const worker = startAutomationWorker({
        token: params.credentials.token,
        credentials: params.credentials,
        machineId: runtimeMachineId,
        ...(params.credentials.encryption
          ? { encryption: params.credentials.encryption }
          : {}),
        spawnSession: params.spawnSession,
        ...(connectedApiMachine
          ? {
              machineAdmissionTransport: async (request, options) =>
                await connectedApiMachine!.enqueueSessionPendingByMachine(request, options),
              dispatchSessionServerStart: async (request, options) =>
                await connectedApiMachine!.dispatchSessionServerStart(request, options),
            }
          : {}),
      });
      params.onAutomationWorkerStarted?.(worker);
      return worker;
    },
    startMemoryWorkerForMachine: async (runtimeMachineId) => {
      try {
        return await startMemoryWorker({
          credentials: params.credentials,
          machineId: runtimeMachineId,
        });
      } catch (error) {
        if (error instanceof MemorySettingsSecretsUnavailableError) {
          throw error;
        }
        logger.warn('[DAEMON RUN] Failed to start memory worker (best-effort)', error);
        return null;
      }
    },
    startVoiceInferenceWorkerForMachine: async (runtimeMachineId, accountId) => {
      try {
        return await startVoiceInferenceWorker({
          ...(accountId
            ? {
                publicModelPacks: createDaemonPublicVoiceModelPackRuntime({
                  accountId,
                  machineId: runtimeMachineId,
                  happyHomeDir: configuration.happyHomeDir,
                  paths: resolveVoiceInferencePaths(),
                }),
              }
            : {}),
        });
      } catch (error) {
        logger.warn('[DAEMON RUN] Failed to start voice inference worker (best-effort)', error);
        return null;
      }
    },
    spawnSession: params.spawnSession,
    stopSession: params.stopSession,
    awaitAgentSessionOpen: params.awaitAgentSessionOpen,
    isSessionAlreadyRunning: params.isSessionAlreadyRunning,
    loadLocalSessionMetadataForHandoff: params.loadLocalSessionMetadataForHandoff,
    savePreparedTargetLocalMetadata: params.savePreparedTargetLocalMetadata,
    beforeShutdown: params.beforeShutdown,
    requestShutdown: params.requestShutdown,
    directPeerServerLifecycle: params.directPeerServerLifecycle,
    directTransferPromptAssetAdapterRegistry: params.directTransferPromptAssetAdapterRegistry,
    directTransferPromptRegistryRegistry: params.directTransferPromptRegistryRegistry,
    ...(params.cancelConnectedServiceRuntimeAuthRecovery
      ? { cancelConnectedServiceRuntimeAuthRecovery: params.cancelConnectedServiceRuntimeAuthRecovery }
      : {}),
    ...(params.retryTemporaryThrottleNow
      ? { retryTemporaryThrottleNow: params.retryTemporaryThrottleNow }
      : {}),
    peerMediationMachineRpc: {
      stream: {
        captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(params.liveStreamCaptureRegistry),
        ...(params.readActiveLiveStreamControlLease
          ? { readActiveControlLease: params.readActiveLiveStreamControlLease }
          : {}),
      },
      ...(params.peerMediationObservabilityEmitter
        ? { observability: params.peerMediationObservabilityEmitter }
        : {}),
    },
    ...(params.readLocalServiceInventorySnapshot
      ? { readLocalServiceInventorySnapshot: params.readLocalServiceInventorySnapshot }
      : {}),
    ...(params.managedCatalogRuntime
      ? { managedCatalogRuntime: params.managedCatalogRuntime }
      : {}),
    ...(params.resolveManagedPurposeBindingIntent
      ? {
          resolveManagedPurposeBindingIntent:
            params.resolveManagedPurposeBindingIntent,
        }
      : {}),
    ...(params.createAgentCatalogObservation
      ? { createAgentCatalogObservation: params.createAgentCatalogObservation }
      : {}),
    ...(params.persistedTakeoverAdmissionWaiter
      ? {
          persistedTakeoverAdmissionWaiter:
            params.persistedTakeoverAdmissionWaiter,
        }
      : {}),
    ...(params.attachPersistedTakeoverAdmissionOwner
      ? {
          attachPersistedTakeoverAdmissionOwner:
            params.attachPersistedTakeoverAdmissionOwner,
        }
      : {}),
    ...(params.installExternalSessionHostOperations
      ? {
          installExternalSessionHostOperations:
            params.installExternalSessionHostOperations,
        }
      : {}),
    ...(params.externalActionIngressOwner
      ? { externalActionIngressOwner: params.externalActionIngressOwner }
      : {}),
  };
}
