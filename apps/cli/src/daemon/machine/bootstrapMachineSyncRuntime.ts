import fs from 'fs/promises';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readLocalHostIdentity } from '@happier-dev/cli-common/process';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { MachineRpcHandlerDeps } from '@/api/machine/rpcHandlers';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';
import type { CliUpdateFacts } from '@happier-dev/protocol';
import type { DaemonState, Machine, MachineMetadata } from '@/api/types';
import { StoredMachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { SessionHandoffDirectPeerTransferHandle } from '@/api/machine/sessionHandoff/handlers';
import { createFileTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { DirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import type { PreparedFilesystemTransferScope } from '@/machines/transfer/preparedFilesystemTransferScope';
import { resolvePromptAssetDownloadSource } from '@/transfers/targets/resolvePromptAssetDownloadSource';
import { resolvePromptRegistryItemDownloadSource } from '@/transfers/targets/resolvePromptRegistryItemDownloadSource';
import { prepareWorkspaceFileExport } from '@/machines/transfer/prepareWorkspaceFileExport';
import { prepareWorkspaceSyncSeedExport } from '@/machines/transfer/prepareWorkspaceSyncSeedExport';
import { resolveComposerMediaStageDownloadSource } from '@/transfers/targets/resolveComposerMediaStageDownloadSource';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import type {
  ComposerContentHandleV1,
  MachineLiveStreamControlLeaseV1,
  PromptAssetReadRequest,
  PromptRegistryFetchItemRequestV1,
} from '@happier-dev/protocol';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import { parseHostEventPayloadV1 } from '@happier-dev/protocol/plugins/events/hostV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { SessionExecutionRunBrokerAuthorityResponseV1Schema } from '@happier-dev/protocol/daemon/executionRuns';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import { activatePendingInactiveSession } from '@/daemon/sessions/activatePendingInactiveSession';
import {
  createPendingSessionActivationRecovery,
  readRequesterPendingSessionActivation,
  type PendingSessionActivationInput,
} from '@/daemon/sessions/pendingSessionActivationRecovery';
import type { RequesterSessionRuntimeContext, ResolveRequesterSessionRuntimeContext, RequesterSessionCredentialBindingsResult,
  RequesterSessionCredentialBinding } from '../sessionEncryption/requesterSessionCredentials';
import { activateInactiveUsageLimitResume } from '@/daemon/sessions/activateInactiveUsageLimitResume';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import { subscribeMemorySessionRemoval } from '../memory/subscribeMemorySessionRemoval';
import { subscribeManagedSessionDirectoryRemoval } from '../sessions/subscribeManagedSessionDirectoryRemoval';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import type { DaemonServerWorkScheduler } from '../serverWork';
import { createDaemonConnectivityCoordinator } from '../connection/createDaemonConnectivityCoordinator';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { logger } from '@/ui/logger';
import type { PromptRegistryRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { bindPluginDaemonConnectionStateSource } from '@/agent/runtime/registry/pluginConnectionStateSource';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { Credentials, StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { normalizeAccountSettingsVersionHint } from '@/settings/accountSettings/accountSettingsVersion';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createAccountScopedProviderModelProjectionReader } from '@/providers/modelManagement/remoteProjection';
import type { ProviderRuntimeModelProjectionReader } from '@/providers/spawn/runtimeCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import type { ResolveSharedManagedProviderGatewayBinding } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { readCurrentManagedChildMachineMetadata, refreshMachineMetadataForCurrentDaemon } from './metadata';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createLegacyProfileMigrationRpcServices } from '@/providers/migrations/rpc';
import {
  createRuntimeProviderOperationsProducer,
  type RuntimeProviderOperationsProducer,
} from '@/providers/runtimeServices';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createNpmRegistryProfileProbe } from '@/plugins/distribution/npm/profiles/probe';
import { triggerLegacyProfileMigration as triggerLegacyProfileMigrationRuntime } from '@/providers/migrations/runtime';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { PeerLoopbackEndpointCandidateV1Schema } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import type { FeaturesResponse, PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol';
import type { WorkspaceContentPolicyV1 } from '@happier-dev/protocol';
import {
  startPeerMediationLoopback,
  type StartPeerMediationLoopbackInput,
  type StartedPeerMediationLoopback,
} from '../peer/mediation/rpc/startLoopback';
import { createMachineLiveStreamRelayTerminator } from '../peer/mediation/stream';
import { registerMachinePeerTcpTunnelRelayRuntime } from './registerMachinePeerTcpTunnelRelayRuntime';
import type { DaemonPeerMediationObservabilityEmitter } from '../peer/mediation/observability/events';
import type { DirectRouteGrantTrustRoot } from '../peer/mediation/verifyDirectRouteGrant';
import type { DaemonMachineIrohRuntime } from '../peer/iroh/daemonMachineIrohRuntime';
import type {
  PeerTcpTunnelVoiceBinaryAppendConsumer,
  PeerTcpTunnelVoiceBinaryTerminalConsumer,
} from '../peer/mediation/tunnel/voiceBinaryAppend';
import type { RegisterPeerTcpTunnelRelayTerminatorOptions } from '../peer/mediation/tunnel/relay';
import type { NormalizedLocalServiceInventorySnapshot } from '../local/services/inventory/scanner';
import { projectProviderDiscoveryCandidates } from '@/providers/discovery/project';
import { createProviderLocalInstallationReader } from '@/providers/discovery/installations';
import { createDaemonSpawnToolResolutionContext } from '../spawnHooks';
import { createProviderLocalCatalogFallbackRunner } from '@/providers/probe/localCommand';
import type { createAgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { resolveDaemonSpawnSessionByNonce } from '../controlClient';
import {
  UsageLimitRecoveryScheduler,
  type UsageLimitRecoveryIntent,
} from '../connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { createInactiveUsageLimitRecoveryCheckOwner } from '../connectedServices/usageLimitRecovery/inactiveUsageLimitRecoveryCheckOwner';
import { createPendingResetStartRecoveryPorts } from '../connectedServices/usageLimitRecovery/createPendingResetStartRecoveryPorts';
import {
  createDaemonSessionMutationCustody,
  type DaemonSessionMutationCustody,
} from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { createRecoveryIntentFileStore } from '../connectedServices/recoveryScheduler/recoveryIntentFileStore';
import type { DurableBackoffRecoveryStore } from '../connectedServices/recoveryScheduler/DurableBackoffRecoveryScheduler';
import { abandonSpawnedSessionUntilCompleted } from '@/session/services/awaitSpawnedSessionId';
import { setSessionArchivedState } from '@/session/services/setSessionArchivedState';
import type { PersistedTakeoverAdmissionWaiter } from '@/daemon/spawn/persistedTakeoverAdmission';
import type {
  ExternalSessionPluginAdmissionOwner,
} from '@/session/actions/externalSessions/pluginExternalSessionAdmissionOwner';
import type {
  ExternalSessionPersistedTakeoverAdmissionOwner,
} from '@/session/actions/externalSessions/persistedTakeoverAdmission';
import type {
  ExternalSessionHostOperationInstallation,
  ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import type { SessionLifecycleMachineDeps } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import type { DeviceLocalSecretStorage } from '../deviceLocalSecretStorage';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import type { ExternalActionIngressOwner } from '@/rpc/handlers/externalAction';
import type { ExecutionRunTeamCredentialProviderBindingPreparer } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import { createWorkflowRecoveryTriggers } from '@/daemon/workflows/recoveryTriggers';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import type { WorkflowRecoveryTrigger } from '@/daemon/workflows/recovery';

function readAccountSettingsChangedHintVersion(update: unknown): number | null {
  if (!update || typeof update !== 'object') return null;
  const body = (update as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return null;
  if ((body as { t?: unknown }).t !== 'account-settings-changed') return null;
  return normalizeAccountSettingsVersionHint((body as { settingsVersion?: unknown }).settingsVersion);
}

/**
 * The server has already committed and stamped this lossy observation. This
 * ingress validates and projects it into the daemon-lifetime broker; it never
 * derives lifecycle facts or participates in Automation settlement.
 */
function projectAutomationRunStateChangedHostEvent(
  update: unknown,
  isShuttingDown: () => boolean,
): boolean {
  if (!update || typeof update !== 'object') return false;
  const body = UpdateBodySchema.safeParse((update as { body?: unknown }).body);
  if (!body.success || body.data.t !== 'automation-run-state-changed') return false;
  if (isShuttingDown()) return true;
  const payload = parseHostEventPayloadV1(
    HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
    {
      runId: body.data.runId,
      automationId: body.data.automationId,
      runCause: body.data.runCause,
      previousState: body.data.previousState,
      currentState: body.data.currentState,
      transitionedAt: body.data.transitionedAt,
      claimedByMachineId: body.data.claimedByMachineId,
      ...(body.data.transitionCause === undefined
        ? {}
        : { transitionCause: body.data.transitionCause }),
    },
  );
  const registryLease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
  if (!registryLease) return true;
  try {
    const broker = registryLease.registry.stableEventsBroker;
    if (!broker) return true;
    broker.publishHostEventEnvelope({
      eventId: HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
      scope: { kind: 'account' },
      payload,
    });
  } catch (error) {
    logger.warn('[DAEMON RUN] Automation lifecycle Host Event projection failed (ignored)', {
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    void registryLease.release().catch((error) => {
      logger.warn('[DAEMON RUN] Automation lifecycle Host Event registry release failed (ignored)', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return true;
}

async function refreshDaemonAccountSettingsForHint(params: Readonly<{
  credentials: StoredCredentials;
  settingsVersion: number | null;
}>): Promise<boolean> {
  const requiresConservativeRefresh = params.settingsVersion === null;
  await refreshAccountSettingsForMinimumVersion({
    credentials: params.credentials,
    minSettingsVersion: params.settingsVersion,
    mode: 'blocking',
    ...(requiresConservativeRefresh ? { forceRefresh: true } : {}),
  });
  return true;
}

type ConnectedServiceRefreshLoopHandle = Readonly<{
  stop: () => void;
  pause: () => void;
  resume: () => void;
}>;

type PeerMediationMachineRpcBootstrapConfig = Readonly<{
  accountId?: string | null;
  serverFeatures?: FeaturesResponse | null;
  nowMs?: () => number;
  // PMS-WIRE: the shared observability emitter supplied by startup so the relay terminators publish
  // into the SAME store the read-path executor reads. Absent (e.g. narrow unit callers) → the
  // bootstrap falls back to a self-owned store.
  observability?: DaemonPeerMediationObservabilityEmitter;
  endpointFingerprint?: () => string;
  endpointTtlMs?: number;
  host?: string;
  port?: number;
  localPerPeerMaxConcurrentCalls?: number;
  stream?: StartPeerMediationLoopbackInput['stream'] & Readonly<{
    readActiveControlLease?: (leaseInput: Readonly<{
      streamId: string;
      sourceId: string;
      nowMs: number;
    }>) => MachineLiveStreamControlLeaseV1 | null;
  }>;
  startPeerMediationLoopbackServer?: StartPeerMediationLoopbackInput['startPeerMediationLoopbackServer'];
  /**
   * Target-daemon owner for the provider-broker application stream. The
   * resolver is deliberately supplied by the runtime composition root: it
   * must bind an already admitted Session/Run provider operation to the
   * existing managed-service endpoint and never infer a destination from the
   * handshake. Keeping this callback optional preserves fail-closed startup
   * until that owner is live.
   */
  resolveProviderBrokerApplicationTarget?: NonNullable<
    StartPeerMediationLoopbackInput['irohMachineAdmission']
  >['resolveProviderBrokerApplicationTarget'];
  resolveExternalProviderBrokerApplicationTarget?: RegisterPeerTcpTunnelRelayTerminatorOptions['resolveProviderBrokerApplicationTarget'];
  resolveRunnerBrokerReadinessApplicationTarget?: NonNullable<
    StartPeerMediationLoopbackInput['irohMachineAdmission']
  >['resolveRunnerBrokerReadinessApplicationTarget'];
}>;

type PeerTcpTunnelRelayBootstrapContext = Readonly<{
  accountId: string;
  serverFeatures: FeaturesResponse;
}>;

const PEER_MEDIATION_MACHINE_RPC_FEATURES_TIMEOUT_MS = 1_500;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized ? normalized : null;
}

export function createMachineSharedProviderGatewayResolver(input: Readonly<{
  machineId: string;
  readAccountId(): string | null;
  readOrigin(): Promise<CurrentMachineExecutionOriginContext | null>;
}>): ResolveSharedManagedProviderGatewayBinding {
  return async ({ connectionId, consumerId, signal }) => {
    signal?.throwIfAborted();
    const origin = await input.readOrigin();
    signal?.throwIfAborted();
    const accountId = normalizeNonEmptyString(input.readAccountId());
    const homeId = normalizeNonEmptyString(origin?.serverIdentityId);
    if (!homeId || !accountId || origin?.machineId !== input.machineId) {
      throw createProviderErrorV1('provider_authorization_changed', {
        connectionId,
        machineId: input.machineId,
      });
    }
    return Object.freeze({ homeId, accountId, connectionId, machineId: input.machineId, consumerId });
  };
}

function readUsageLimitRecoveryResultStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const status = (result as Record<string, unknown>).status;
  return typeof status === 'string' ? status : null;
}

function readUsageLimitRecoveryIntentFromControlResult(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const metadata = (result as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

async function resolvePeerMediationMachineRpcServerFeatures(
  config: PeerMediationMachineRpcBootstrapConfig | undefined,
): Promise<FeaturesResponse | null> {
  if (config?.serverFeatures !== undefined) {
    return config.serverFeatures;
  }
  const snapshot = await fetchServerFeaturesSnapshot({
    serverUrl: configuration.serverUrl,
    timeoutMs: PEER_MEDIATION_MACHINE_RPC_FEATURES_TIMEOUT_MS,
  });
  return snapshot.status === 'ready' ? snapshot.features : null;
}

function mergePeerMediationLoopbackEndpoint(
  state: DaemonState | null,
  endpoint: PeerLoopbackEndpointCandidateV1,
  activeFlows: StartedPeerMediationLoopback['activeFlows'],
): DaemonState {
  const parsedEndpoint = PeerLoopbackEndpointCandidateV1Schema.parse(endpoint);
  const base: DaemonState = state === null ? { status: 'running' } : StoredMachinePublishedDaemonStateV1Schema.parse(state);
  return {
    ...base,
    peerMediation: {
      ...base.peerMediation,
      loopback: {
        ...base.peerMediation?.loopback,
        endpoint: parsedEndpoint,
        flows: {
          ...base.peerMediation?.loopback?.flows,
          ...(activeFlows.machine_rpc ? { machine_rpc: { active: true } } : {}),
          ...(activeFlows.live_stream ? { live_stream: { active: true } } : {}),
          ...(activeFlows.tcp_tunnel ? { tcp_tunnel: { active: true } } : {}),
          ...(activeFlows.voice_media ? { voice_media: { active: true } } : {}),
        },
      },
    },
  };
}

function reconcileMachineIrohEndpoint(
  state: DaemonState,
  runtime: DaemonMachineIrohRuntime | undefined,
): DaemonState {
  const base = StoredMachinePublishedDaemonStateV1Schema.parse(state);
  return {
    ...base,
    peerMediation: {
      ...base.peerMediation,
      iroh: runtime ? { endpoint: runtime.endpoint } : undefined,
    },
  };
}

function removeMachineIrohEndpoint(state: DaemonState | null): DaemonState {
  if (!state) throw new Error('Cannot remove an Iroh endpoint from an unpublished daemon state');
  return reconcileMachineIrohEndpoint(state, undefined);
}

async function maybeStartPeerMediationLoopback(params: Readonly<{
  config: PeerMediationMachineRpcBootstrapConfig | undefined;
  connectedApiMachine: ApiMachineClient;
  credentials: StoredCredentials | undefined;
  machine: Machine;
  machineId: string;
  voiceBinaryAppendConsumer?: PeerTcpTunnelVoiceBinaryAppendConsumer;
  voiceBinaryTerminalConsumer?: PeerTcpTunnelVoiceBinaryTerminalConsumer;
  /** PMS-9 / P1-9: shared emitter so the DIRECT loopback routes publish flow facts too. */
  observability?: DaemonPeerMediationObservabilityEmitter;
  machineIrohRuntime?: DaemonMachineIrohRuntime;
  directPeerServerLifecycle: DirectTransferServerLifecycle | null;
  acquireWorkspaceSyncMachineIngress?: BootstrapMachineSyncRuntimeParams['acquireWorkspaceSyncMachineIngress'];
  acquireLocalServicePreviewApplication?: BootstrapMachineSyncRuntimeParams['acquireLocalServicePreviewApplication'];
  getServerFeaturesSnapshot?: BootstrapMachineSyncRuntimeParams['getServerFeaturesSnapshot'];
  resolvePeerMediationTrustRoots?: BootstrapMachineSyncRuntimeParams['resolvePeerMediationTrustRoots'];
}>): Promise<StartedPeerMediationLoopback | null> {
  const serverFeatures = await resolvePeerMediationMachineRpcServerFeatures(params.config);
  if (!serverFeatures) return null;
  const accountId = normalizeNonEmptyString(params.config?.accountId)
    ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null);
  if (!accountId) return null;
  let tcpTunnelApplicationPort: number | null = null;
  const started = await startPeerMediationLoopback({
    accountId,
    machineId: params.machineId,
    serverFeatures,
    ...(params.resolvePeerMediationTrustRoots
      ? { resolveTrustRoots: params.resolvePeerMediationTrustRoots }
      : {}),
    rpcHandlerManager: params.connectedApiMachine.getPeerMediationMachineRpcHandlerManager(),
    tunnel: {
      ...(params.acquireLocalServicePreviewApplication ? { acquirePreviewApplication: params.acquireLocalServicePreviewApplication } : {}),
      ...(params.voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer: params.voiceBinaryAppendConsumer } : {}),
      ...(params.voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer: params.voiceBinaryTerminalConsumer } : {}),
    },
    ...(params.observability ? { observability: params.observability } : {}),
    ...(params.config?.nowMs ? { nowMs: params.config.nowMs } : {}),
    ...(params.config?.endpointFingerprint ? { endpointFingerprint: params.config.endpointFingerprint } : {}),
    ...(params.config?.endpointTtlMs ? { endpointTtlMs: params.config.endpointTtlMs } : {}),
    ...(params.config?.host ? { host: params.config.host } : {}),
    ...(typeof params.config?.port === 'number' ? { port: params.config.port } : {}),
    ...(params.config?.stream ? { stream: params.config.stream } : {}),
    ...(typeof params.config?.localPerPeerMaxConcurrentCalls === 'number'
      ? { localPerPeerMaxConcurrentCalls: params.config.localPerPeerMaxConcurrentCalls }
      : {}),
    ...(params.config?.startPeerMediationLoopbackServer
      ? { startPeerMediationLoopbackServer: params.config.startPeerMediationLoopbackServer }
      : {}),
    ...(params.machineIrohRuntime ? {
      irohMachineAdmission: {
        localEndpointId: params.machineIrohRuntime.endpoint.endpointId,
        role: 'acceptor' as const,
        // Machine-carrier handshake flows only. The provider-broker and runner
        // readiness branches are admitted by their own resolvers below.
        allowedFlows: ['finite_transfer', 'workspace_sync', 'tcp_tunnel'] as const,
        resolveTrustRoots: params.resolvePeerMediationTrustRoots ?? (() => []),
        resolveApplicationTarget: async ({ handshake, signal }) => {
          if (handshake.flow === 'tcp_tunnel') {
            // The outer carrier always reaches the canonical tunnel listener.
            // Signed destination/port admission and grant consumption stay in
            // its inner open owner, never in this transport target resolver.
            return tcpTunnelApplicationPort === null ? null : { port: tcpTunnelApplicationPort };
          }
          if (handshake.flow === 'finite_transfer') {
            return params.directPeerServerLifecycle
              ? { port: await params.directPeerServerLifecycle.ensureListening() }
              : null;
          }
          if (handshake.flow !== 'workspace_sync') return null;
          if (!params.acquireWorkspaceSyncMachineIngress) return null;
          if (handshake.initiator.kind !== 'machine') return null;
          const ingress = await params.acquireWorkspaceSyncMachineIngress({
            operationId: handshake.operationId,
            sourceMachineId: handshake.initiator.machineId,
            targetMachineId: handshake.target.machineId,
            ...(handshake.grant.payload.exp !== null ? { expiresAtMs: handshake.grant.payload.exp } : {}),
            signal,
          });
          return { port: ingress.port, localCapability: ingress.localCapability };
        },
        ...(params.config?.resolveProviderBrokerApplicationTarget
          ? {
              resolveProviderBrokerApplicationTarget:
                params.config.resolveProviderBrokerApplicationTarget,
            }
          : {}),
        ...(params.config?.resolveRunnerBrokerReadinessApplicationTarget
          ? {
              resolveRunnerBrokerReadinessApplicationTarget:
                params.config.resolveRunnerBrokerReadinessApplicationTarget,
            }
          : {}),
      },
    } : {}),
  });
  if (!started) return null;
  if (started.activeFlows.tcp_tunnel) {
    tcpTunnelApplicationPort = Number(new URL(started.endpoint.url).port);
  }
  return {
    ...started,
    stop: async () => {
      tcpTunnelApplicationPort = null;
      await started.stop();
    },
  };
}

async function resolvePeerTcpTunnelRelayBootstrapContext(params: Readonly<{
  config: PeerMediationMachineRpcBootstrapConfig | undefined;
  credentials: StoredCredentials | undefined;
}>): Promise<PeerTcpTunnelRelayBootstrapContext | null> {
  const serverFeatures = await resolvePeerMediationMachineRpcServerFeatures(params.config);
  if (!serverFeatures) return null;
  if (readServerEnabledBit(serverFeatures, 'machines.tunnel.serverRouted') !== true) return null;
  const accountId = normalizeNonEmptyString(params.config?.accountId)
    ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null);
  if (!accountId) return null;
  return { accountId, serverFeatures };
}

export type BootstrapMachineSyncRuntimeResult = Readonly<{
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  externalSessionHostActionExecutor?: RpcActionExecutor;
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  apiMachine: ApiMachineClient | null;
  apiMachineForSessions: ApiMachineClient | null;
  automationWorker: AutomationWorkerHandle | null;
  memoryWorker: MemoryWorkerHandle | null;
  voiceInferenceWorker: VoiceInferenceWorkerHandle | null;
  daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null;
  machineConnectionStateCleanup: (() => void) | null;
  stopPeerMediationLoopbackServer: () => Promise<void>;
  stopMachineIrohAcceptor: () => Promise<void>;
  resumeMachineConnectionPublications: () => Promise<void>;
  daemonSessionMutationCustody: DaemonSessionMutationCustody | null;
  cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop(input: Readonly<{
    sessionId: string;
  }>): Promise<unknown>;
  /**
   * Retires this attempt's inactive usage-limit recovery scheduler. Its armed timers outlive the
   * attempt otherwise and would keep waking probes that stage durable session work long after a
   * replacement attempt hydrated the same durable store.
   */
  disposeInactiveSessionUsageLimitRecovery: () => void;
  providerOperationsProducer: RuntimeProviderOperationsProducer | null;
}>;

export type MachineSyncRuntimeAttemptResources = Readonly<
  Pick<
    BootstrapMachineSyncRuntimeResult,
    | 'apiMachine'
    | 'automationWorker'
    | 'memoryWorker'
    | 'voiceInferenceWorker'
    | 'machineConnectionStateCleanup'
    | 'stopPeerMediationLoopbackServer'
    | 'stopMachineIrohAcceptor'
  > & {
    disposeInactiveSessionUsageLimitRecovery: (() => void) | null;
    cleanupMachineLiveStreamRelay?: (() => void) | null;
    cleanupPeerTcpTunnelRelay?: (() => void) | null;
  }
>;

/**
 * Retires one machine-sync attempt without closing daemon-lifetime custody.
 * Registration retries use this after either bootstrap or post-bootstrap handoff
 * fails, before a replacement attempt can publish new resources.
 */
export async function retireMachineSyncRuntimeAttempt(
  params: MachineSyncRuntimeAttemptResources,
): Promise<void> {
  try {
    params.disposeInactiveSessionUsageLimitRecovery?.();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to retire inactive usage-limit recovery timers after machine-sync attempt failure', error);
  }
  try {
    params.machineConnectionStateCleanup?.();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to retire machine connection listeners after machine-sync attempt failure', error);
  }
  try {
    params.cleanupMachineLiveStreamRelay?.();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to retire live-stream relay after machine-sync attempt failure', error);
  }
  try {
    params.cleanupPeerTcpTunnelRelay?.();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to retire peer TCP relay after machine-sync attempt failure', error);
  }
  try {
    await params.stopMachineIrohAcceptor();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to stop Iroh machine acceptor after machine-sync attempt failure', error);
  }
  try {
    await params.stopPeerMediationLoopbackServer();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to stop peer mediation loopback after machine-sync attempt failure', error);
  }
  try {
    params.automationWorker?.stop();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to stop automation worker after machine-sync attempt failure', error);
  }
  try {
    await params.memoryWorker?.stop();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to stop memory worker after machine-sync attempt failure', error);
  }
  try {
    await params.voiceInferenceWorker?.stop();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to stop voice inference worker after machine-sync attempt failure', error);
  }
  try {
    await params.apiMachine?.shutdown();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to shut down machine client after machine-sync attempt failure', error);
  }
}

export type BootstrapMachineSyncRuntimeParams = Readonly<{
  cliVersion: string;
  machineId: string;
  machine: Machine;
  credentials?: StoredCredentials;
  requesterServerId?: string;
  resolveCurrentMachineExecutionOriginContext?: () => Promise<CurrentMachineExecutionOriginContext | null>;
  resolveRequesterSessionRuntimeContext?: ResolveRequesterSessionRuntimeContext;
  readRequesterSessionCredentialBindings?: () => Promise<RequesterSessionCredentialBindingsResult>;
  releaseRequesterSessionRuntimeContext?: (context: RequesterSessionRuntimeContext) => Promise<void>;
  daemonSessionMutationCustody?: DaemonSessionMutationCustody;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  preferredHost: string;
  happyHomeDir: string;
  happyLibDir: string;
  /** K5 (plan R13): this daemon's CLI update facts, published with its daemon-owned metadata. */
  readCliUpdateFacts?: () => CliUpdateFacts;
  /**
   * Calls `onChange` whenever an update attempt records its end (`last-update.json`), so a remote
   * update that ended without restarting this daemon is republished; returns the stop function.
   */
  watchCliUpdateRecord?: (onChange: () => void) => (() => void) | null;
  filesystemAccessPolicy: FilesystemAccessPolicy;
  takeoverRequested: boolean;
  isShuttingDown: () => boolean;
  createConnectedApiMachine: (
    machine: Machine,
  ) => ApiMachineClient | null | Promise<ApiMachineClient | null>;
  attachTransferRuntimeStatePublisher: (apiMachine: ApiMachineClient) => Promise<void>;
  startAutomationWorkerForMachine: (machineId: string) => AutomationWorkerHandle | null;
  startMemoryWorkerForMachine: (machineId: string) => Promise<MemoryWorkerHandle | null>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  sessionRunnerStatus?: MachineRpcHandlerDeps['sessionRunnerStatus'];
  awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
  isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadataForHandoff: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  beforeShutdown: () => Promise<void>;
  requestShutdown: (source: 'happier-app', errorMessage?: string) => void;
  directPeerServerLifecycle: DirectTransferServerLifecycle | null;
  prepareWorkspaceSyncSeedExport?: NonNullable<import('@/api/machine/rpcHandlers.workspaceSync').MachineWorkspaceSyncRpcService['prepareSourceSeedExport']>;
  prepareWorkspaceSyncResolutionExport?: NonNullable<import('@/api/machine/rpcHandlers.workspaceSync').MachineWorkspaceSyncRpcService['prepareConflictResolutionExport']>;
  machineIrohRuntime?: DaemonMachineIrohRuntime;
  acquireLocalServicePreviewApplication?: import('../local/services/preview/routes').LocalServicePreviewRoutes['acquireNativeApplication'];
  prepareServerTransportForReconnect?: () => Promise<ReadinessProbeResult>;
  acquireWorkspaceSyncMachineIngress?: (input: Readonly<{
    operationId: string;
    sourceMachineId: string;
    targetMachineId: string;
    expiresAtMs?: number;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    port: number;
    localCapability: string;
    close(): Promise<void>;
  }>>;
  directTransferPromptAssetAdapterRegistry: ReturnType<typeof createPromptAssetAdapterRegistry>;
  directTransferPromptRegistryRegistry: PromptRegistryRegistry;
  connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle | null;
  connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null;
  daemonServerWorkScheduler: DaemonServerWorkScheduler;
  retryTemporaryThrottleNow?: (input: Readonly<{ sessionId: string }>) => Promise<unknown> | unknown;
  readTemporaryThrottleRecovery?: (sessionId: string) => Readonly<{ issueFingerprint: string; armedAtMs: number }> | null;
  cancelTemporaryThrottleRecovery?: (input: Readonly<{ sessionId: string; issueFingerprint?: string; armedAtMs?: number }>) => Promise<unknown> | unknown;
  cancelConnectedServiceRuntimeAuthRecovery?: (input: Readonly<{
    sessionId: string;
    attemptId: string;
  }>) => Promise<unknown> | unknown;
  setDaemonServerWorkOnline?: (online: boolean) => void;
  onMachineConnectionOnline?: () => void | Promise<void>;
  reconcileConnectedServicesProjection?: Parameters<ApiMachineClient['onConnectedServicesProjection']>[0];
  subscribeConnectedAccountInvalidations?: (listener: () => void) => () => void;
  startVoiceInferenceWorkerForMachine: (machineId: string, accountId: string | null) => Promise<VoiceInferenceWorkerHandle | null>;
  getServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
  resolvePeerMediationTrustRoots?: () => readonly DirectRouteGrantTrustRoot[];
  peerMediationMachineRpc?: PeerMediationMachineRpcBootstrapConfig;
  inactiveUsageLimitRecoveryStore?: DurableBackoffRecoveryStore<UsageLimitRecoveryIntent>;
  readLocalServiceInventorySnapshot?: () => Promise<NormalizedLocalServiceInventorySnapshot | null>;
  managedCatalogRuntime?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['managedCatalogRuntime'];
  resolveManagedPurposeBindingIntent?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['resolveManagedPurposeBindingIntent'];
  openTeamDirect?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['openTeamDirect'];
  createAgentCatalogObservation?: (
    infrastructure: Pick<
      Parameters<typeof createAgentProviderCatalogObservationService>[0],
      'client' | 'scheduler'
    >,
  ) => ReturnType<typeof createAgentProviderCatalogObservationService>;
  triggerLegacyProfileMigration?: typeof triggerLegacyProfileMigrationRuntime;
  persistedTakeoverAdmissionWaiter?: PersistedTakeoverAdmissionWaiter;
  attachPersistedTakeoverAdmissionOwner?: (
    owner: ExternalSessionPersistedTakeoverAdmissionOwner,
  ) => () => void;
  installExternalSessionHostOperations?: (
    operations: ExternalSessionHostOperationSet,
  ) => Promise<ExternalSessionHostOperationInstallation>;
  externalActionIngressOwner?: ExternalActionIngressOwner;
  prepareRunTeamCredentialProviderBinding?: ExecutionRunTeamCredentialProviderBindingPreparer;
  openAccountConnectionManagedConsumerSource?: import('@/agent/runtime/bridges/executionRun/runtime/managedProvider').ExecutionRunManagedProviderSourceOpener;
  recoverWorkflowRuns?: (trigger: WorkflowRecoveryTrigger) => Promise<void>;
}>;

export async function bootstrapMachineSyncRuntime(
  params: BootstrapMachineSyncRuntimeParams,
): Promise<BootstrapMachineSyncRuntimeResult> {
  if (params.isShuttingDown()) {
    return {
      apiMachine: null,
      apiMachineForSessions: null,
      automationWorker: null,
      memoryWorker: null,
      voiceInferenceWorker: null,
      daemonConnectivityCoordinator: null,
      machineConnectionStateCleanup: null,
      stopPeerMediationLoopbackServer: async () => {},
      stopMachineIrohAcceptor: async () => {},
      resumeMachineConnectionPublications: async () => {},
      daemonSessionMutationCustody: null,
      cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop: async () => null,
      disposeInactiveSessionUsageLimitRecovery: () => {},
      providerOperationsProducer: null,
    };
  }

  // ApiMachineClient discards a persisted endpoint before it can connect.
  // Retain the withdrawal fact until the reconnect publisher has removed the
  // old server-side daemon state as well.
  let needsPersistedIrohEndpointWithdrawal = Boolean(params.machine.daemonState?.peerMediation?.iroh);
  const connectedApiMachine = await params.createConnectedApiMachine(params.machine);
  const workflowRecoveryTriggers = params.recoverWorkflowRuns
    ? createWorkflowRecoveryTriggers(params.recoverWorkflowRuns)
    : null;
  let automationWorker: AutomationWorkerHandle | null = null;
  let externalSessionPluginAdmissionOwner:
    ExternalSessionPluginAdmissionOwner | undefined;
  let externalSessionHostActionExecutor: RpcActionExecutor | undefined;
  let sessionSpawnDirectTargetTransport: SessionSpawnDirectTargetTransport | undefined;
  let providerOperationsProducer: RuntimeProviderOperationsProducer | null = null;
  let memoryWorker: MemoryWorkerHandle | null = null;
  let voiceInferenceWorker: VoiceInferenceWorkerHandle | null = null;
  let voiceBinaryAppendConsumer: PeerTcpTunnelVoiceBinaryAppendConsumer | undefined;
  let voiceBinaryTerminalConsumer: PeerTcpTunnelVoiceBinaryTerminalConsumer | undefined;
  let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
  let machineConnectionStateCleanup: (() => void) | null = null;
  let peerMediationLoopback: StartedPeerMediationLoopback | null = null;
  let activeMachineIrohRuntime: DaemonMachineIrohRuntime | undefined;
  let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
  let stopMachineIrohAcceptor: () => Promise<void> = async () => {};
  let cleanupMachineLiveStreamRelay: (() => void) | null = null;
  let cleanupPeerTcpTunnelRelay: (() => void) | null = null;
  let resumeMachineConnectionPublications = async (): Promise<void> => {};
  let disposeInactiveSessionUsageLimitRecovery: (() => void) | null = null;

  const getAttemptResources = (): MachineSyncRuntimeAttemptResources => ({
    apiMachine: connectedApiMachine,
    automationWorker,
    memoryWorker,
    voiceInferenceWorker,
    machineConnectionStateCleanup,
    stopPeerMediationLoopbackServer,
    stopMachineIrohAcceptor,
    cleanupMachineLiveStreamRelay,
    cleanupPeerTcpTunnelRelay,
    disposeInactiveSessionUsageLimitRecovery,
  });

  if (connectedApiMachine) {
    try {
      await params.attachTransferRuntimeStatePublisher(connectedApiMachine);
      if (params.reconcileConnectedServicesProjection) {
        connectedApiMachine.onConnectedServicesProjection(params.reconcileConnectedServicesProjection);
      }
    } catch (error) {
      await retireMachineSyncRuntimeAttempt(getAttemptResources());
      throw error;
    }
  }

  try {
  const directPeerServerLifecycle = params.directPeerServerLifecycle;
  const directPeerTransferHandlers: SessionHandoffDirectPeerTransferHandle | null = directPeerServerLifecycle
    ? {
        publishTransfer: async ({ transferId, payload: _payload, payloadSource, onDemandScope }) => {
          if (!payloadSource) {
            throw new Error('Direct peer handoff publish requires a file-backed payload source');
          }
          return (await directPeerServerLifecycle.publishTransferWhenReady({
            transferId,
            payloadSource,
            ...(onDemandScope ? { onDemandScope } : {}),
          })).endpointCandidates;
        },
        requestPayloadFile: async ({
          transferId,
          endpointCandidates,
          destinationPath,
          expectedSizeBytes,
          expectedManifestHash,
          openBody,
          timeoutMs,
          onProgress,
        }) =>
          await directPeerServerLifecycle.requestPayloadFile({
            transferId,
            endpointCandidates,
            destinationPath,
            ...(typeof expectedSizeBytes === 'number' ? { expectedSizeBytes } : {}),
            ...(typeof expectedManifestHash === 'string' ? { expectedManifestHash } : {}),
            ...(openBody !== undefined ? { openBody } : {}),
            ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
            ...(onProgress ? { onProgress } : {}),
          }),
        clearPublishedTransfer: (transferId: string) => directPeerServerLifecycle.clearPublishedTransfer(transferId),
      }
    : null;

  const directTransferComposerMediaStageStore = createActiveDaemonComposerMediaStageStore({
    machineId: params.machineId,
  });
  const directTransferExportHandlers = directPeerServerLifecycle
    ? {
        releaseExportSession: (transferId: string, filesystemScope?: PreparedFilesystemTransferScope | null) => {
          directPeerServerLifecycle.clearPublishedTransfer(transferId, filesystemScope);
        },
        prepareExportSession: async (
          input:
            | Readonly<{
                t: 'prompt_asset_download_v1';
                assetTypeId: string;
                scope: PromptAssetReadRequest['scope'];
                externalRef: PromptAssetReadRequest['externalRef'];
              }>
            | Readonly<{
                t: 'prompt_registry_download_v1';
                sourceId: string;
                itemId: string;
                configuredSources: PromptRegistryFetchItemRequestV1['configuredSources'];
              }>
            | Readonly<{
                t: 'workspace_file_download_v1';
                workingDirectory: string;
                path: string;
                asZip: boolean;
                confinedToWorkingDirectory?: boolean;
              }>
            | Readonly<{
                t: 'workspace_sync_seed_v1';
                operationId: string;
                sourceWorkspaceRefId: string;
                targetMachineId: string;
                contentPolicy: WorkspaceContentPolicyV1;
              }>
            | Readonly<{
                t: 'workspace_sync_resolution_v1';
              } & import('@happier-dev/protocol').WorkspaceSyncTargetConflictStageV1>
            | Readonly<{
                t: 'composer_media_stage_inspect_v1';
                handle: ComposerContentHandleV1;
                offset: number;
                maxBytes: number;
              }>,
          filesystemScope?: PreparedFilesystemTransferScope,
        ) => {
          if (input.t === 'workspace_file_download_v1') {
            return await prepareWorkspaceFileExport({ lifecycle: directPeerServerLifecycle,
              accessPolicy: params.filesystemAccessPolicy, request: input,
              ...(filesystemScope ? { filesystemScope } : {}) });
          }
          if (input.t === 'workspace_sync_seed_v1') {
            if (!params.prepareWorkspaceSyncSeedExport) throw new Error('Workspace sync source seed is unavailable');
            return await prepareWorkspaceSyncSeedExport({ lifecycle: directPeerServerLifecycle,
              request: input, prepareSourceSeedExport: params.prepareWorkspaceSyncSeedExport });
          }
          if (input.t === 'workspace_sync_resolution_v1') {
            if (!params.prepareWorkspaceSyncResolutionExport) throw new Error('Reviewed workspace conflict export is unavailable');
            const { t: _transferKind, ...request } = input;
            const prepared = await params.prepareWorkspaceSyncResolutionExport(request);
            const published = await directPeerServerLifecycle.publishTransferWhenReady({
              transferId: input.operationId,
              payloadSource: prepared.payloadSource,
              onDemandScope: prepared.onDemandScope,
            });
            return {
              transferId: published.transferId,
              endpointCandidates: published.endpointCandidates,
              expiresAt: published.expiresAt,
              ...(prepared.payloadSource.sizeBytes === undefined ? {} : { sizeBytes: prepared.payloadSource.sizeBytes }),
              ...(prepared.payloadSource.manifestHash === undefined ? {} : { manifestHash: prepared.payloadSource.manifestHash }),
            };
          }
          const resolvedSource =
            input.t === 'prompt_asset_download_v1'
              ? await resolvePromptAssetDownloadSource({
                  adapterRegistry: params.directTransferPromptAssetAdapterRegistry,
                  request: {
                    assetTypeId: input.assetTypeId,
                    scope: input.scope,
                    externalRef: input.externalRef,
                  },
                })
              : input.t === 'prompt_registry_download_v1'
                ? await resolvePromptRegistryItemDownloadSource({
                    registry: params.directTransferPromptRegistryRegistry,
                    request: {
                      sourceId: input.sourceId,
                      itemId: input.itemId,
                      configuredSources: input.configuredSources,
                    },
                  })
                : input.t === 'composer_media_stage_inspect_v1'
                    ? await resolveComposerMediaStageDownloadSource({
                        request: {
                          ...input,
                          recipientPublicKeyBase64: '',
                        },
                        deps: { store: directTransferComposerMediaStageStore },
                        sessionRpcTransferMaxBytes: null,
                      })
                  : { success: false as const, error: 'Unsupported direct transfer export request' };
          if (!resolvedSource.success) {
            throw new Error(resolvedSource.error);
          }
          const sourceOffsetBytes = 'sourceOffsetBytes' in resolvedSource.source
            && typeof resolvedSource.source.sourceOffsetBytes === 'number'
            ? resolvedSource.source.sourceOffsetBytes
            : undefined;
          const payloadSource = createFileTransferPayloadSource({
            filePath: resolvedSource.source.filePath,
            sizeBytes: resolvedSource.source.sizeBytes,
            name: resolvedSource.source.name,
            dispose: resolvedSource.source.deleteFileOnClose
              ? async () => {
                  await fs.rm(resolvedSource.source.filePath, { force: true }).catch(() => undefined);
                }
              : undefined,
            ...(typeof sourceOffsetBytes === 'number'
              ? { sourceOffsetBytes }
              : {}),
          });

          const transferId = `${
            input.t === 'prompt_asset_download_v1'
              ? 'prompt-asset-download'
              : input.t === 'prompt_registry_download_v1'
                ? 'prompt-registry-download'
                : input.t === 'composer_media_stage_inspect_v1'
                  ? 'composer-media-inspection'
                : 'workspace-file-download'
          }:${randomUUID()}`;
          const published = await directPeerServerLifecycle.publishTransferWhenReady({
            transferId,
            payloadSource,
          });

          return {
            transferId: published.transferId,
            endpointCandidates: published.endpointCandidates,
            expiresAt: published.expiresAt,
            name: resolvedSource.source.name,
            sizeBytes: resolvedSource.source.sizeBytes,
          };
        },
      }
    : null;

  const inactiveUsageLimitRecoveryCheckOwner = createInactiveUsageLimitRecoveryCheckOwner();
  const encryptionCredentials: Credentials | null = params.credentials?.encryption
    ? params.credentials
    : null;
  const storedCredentials = params.credentials;
  const usageLimitRecoveryMutationCustody = params.daemonSessionMutationCustody
    ?? (params.credentials
      ? createDaemonSessionMutationCustody({ credentials: params.credentials })
      : null);
  const pendingResetStartPorts = storedCredentials && connectedApiMachine && params.connectedServiceQuotasLoopHandle
    ? createPendingResetStartRecoveryPorts({
      credentials: storedCredentials,
      machineId: params.machineId,
      isCurrent: () => !params.isShuttingDown(),
      resolveRequesterSessionRuntimeContext: params.resolveRequesterSessionRuntimeContext,
      releaseRequesterSessionRuntimeContext: params.releaseRequesterSessionRuntimeContext,
      release: demand => connectedApiMachine.releasePendingResetStart(demand),
      onError: error => logger.warn('[DAEMON RUN] Pending reset start remains held', error),
    }) : null;
  const inactiveUsageLimitRecoveryScheduler = new UsageLimitRecoveryScheduler({
    nowMs: () => Date.now(),
    ...(pendingResetStartPorts ? { pendingResetStarts: pendingResetStartPorts } : {}),
    store: params.inactiveUsageLimitRecoveryStore ?? createRecoveryIntentFileStore(join(
      configuration.activeServerDir,
      'connected-services',
      'inactive-usage-limit-recovery.json',
    )),
    recover: async (_intent, context) => {
      if (!inactiveUsageLimitRecoveryCheckOwner.hasRunner(context.sessionId)) {
        return {
          status: 'wait',
          nextCheckAtMs: Date.now() + 60_000,
          lastProbeError: 'usage_limit_recovery_runner_unavailable',
        };
      }
      const result = await inactiveUsageLimitRecoveryCheckOwner.run(context.sessionId);
      const status = readUsageLimitRecoveryResultStatus(result);
      if (status === 'ready' || status === 'resumed') {
        return { status: 'ready' };
      }
      const recovery = readUsageLimitRecoveryIntentFromControlResult(result);
      if (recovery?.status === 'waiting') {
        return {
          status: 'wait',
          nextCheckAtMs: recovery.nextCheckAtMs ?? recovery.resetAtMs ?? Date.now() + 60_000,
          lastProbeError: recovery.lastProbeError,
        };
      }
      if (status === 'exhausted' || recovery?.status === 'exhausted') {
        return { status: 'exhausted', lastProbeError: recovery?.lastProbeError };
      }
      if (recovery?.status === 'cancelled') {
        // The probe proved the persisted intent is stale (turn completed or the
        // intent was cleared out-of-band): stop the wake loop terminally.
        return { status: 'superseded', lastProbeError: recovery.lastProbeError };
      }
      return {
        status: 'wait',
        nextCheckAtMs: Date.now() + 60_000,
        lastProbeError: typeof status === 'string' ? status : 'usage_limit_recovery_probe_unavailable',
      };
    },
  });
  disposeInactiveSessionUsageLimitRecovery = () => inactiveUsageLimitRecoveryScheduler.dispose();
  inactiveUsageLimitRecoveryScheduler.hydratePassive();

  if (connectedApiMachine) {
    if (storedCredentials) {
      machineConnectionStateCleanup = await subscribeManagedSessionDirectoryRemoval({
        directories: createManagedSessionDirectories(),
        token: storedCredentials.token,
        stopSession: params.stopSession,
        onSessionDeletedChange: (listener) => connectedApiMachine.onSessionDeletedChange(listener),
        onSessionAccessReset: (listener) => connectedApiMachine.onSessionAccessReset(listener),
        onConnectionStateChange: (listener) => connectedApiMachine.onConnectionStateChange(listener),
      });
    }
    automationWorker = params.startAutomationWorkerForMachine(params.machineId);
    const activeAutomationWorker = automationWorker;
    memoryWorker = await params.startMemoryWorkerForMachine(params.machineId);
    if (memoryWorker) {
      // Derived daemon-memory rows for a deleted, access-revoked, or
      // archive-excluded Session are cleared through the memory owner's single
      // removal operation. Deletion/revocation purges run inside the Account
      // change cursor's custody window, so a failure replays the fact.
      const disposeMemorySessionRemoval = subscribeMemorySessionRemoval({
        memoryWorker,
        onSessionTranscriptRevised: (listener) => connectedApiMachine.onSessionTranscriptRevised(listener),
        onSessionDeletedChange: (listener) => connectedApiMachine.onSessionDeletedChange(listener),
        onSessionAccessRevoked: (listener) => connectedApiMachine.onSessionAccessRevoked(listener),
        onSessionAccessReset: (listener) => connectedApiMachine.onSessionAccessReset(listener),
        onSessionArchivedStateChange: (listener) =>
          connectedApiMachine.onSessionArchivedStateChange(listener),
      });
      const stopMemoryWorker = memoryWorker.stop;
      memoryWorker = {
        ...memoryWorker,
        stop: async () => {
          disposeMemorySessionRemoval();
          await stopMemoryWorker();
        },
      };
    }
    voiceInferenceWorker = await params.startVoiceInferenceWorkerForMachine(
      params.machineId,
      normalizeNonEmptyString(params.peerMediationMachineRpc?.accountId)
        ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null),
    );
    const providerFeatureGate = {
      isEnabled: (featureId: 'providers' | 'providers.localDiscovery' | 'providers.localModelManagement') => {
        const serverSnapshot = params.getServerFeaturesSnapshot?.();
        return resolveCliFeatureDecision({
          featureId,
          env: process.env,
          ...(serverSnapshot ? { serverSnapshot } : {}),
        }).state === 'enabled';
      },
    };
    const triggerProviderLegacyProfileMigration = async (): Promise<void> => {
      if (!params.credentials) return;
      const triggerMigration = params.triggerLegacyProfileMigration ?? triggerLegacyProfileMigrationRuntime;
      try {
        const admitted = await warmActiveAccountSettingsSnapshotBestEffort({ credentials: params.credentials, logger });
        if (!admitted) {
          logger.warn('[providers] Legacy profile migration deferred', { reason: 'account-settings-unavailable' });
          return;
        }
        const result = await triggerMigration({
          credentials: params.credentials,
          providersEnabled: providerFeatureGate.isEnabled('providers'),
          machineId: params.machineId,
        });
        if (result.status === 'deferred') {
          logger.warn('[providers] Legacy profile migration deferred', { reason: result.reason });
        }
      } catch (error) {
        logger.warn('[providers] Legacy profile migration failed without blocking daemon lifecycle', error);
      }
    };
    void triggerProviderLegacyProfileMigration();
    const providerLocalToolContext = createDaemonSpawnToolResolutionContext({ processEnv: process.env });
    const resolveSharedGateway = createMachineSharedProviderGatewayResolver({
      machineId: params.machineId,
      readAccountId: () => normalizeNonEmptyString(params.peerMediationMachineRpc?.accountId)
        ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null),
      readOrigin: async () => await params.resolveCurrentMachineExecutionOriginContext?.() ?? null,
    });
    let providerRuntimeServices!: ReturnType<typeof createRuntimeProviderModelManagementServices>;
    let providerLocalInstallationReader!: ReturnType<typeof createProviderLocalInstallationReader>;
    const providerConnectionRuntimeServices = params.credentials
      ? createRuntimeProviderConnectionServices({
          machineId: params.machineId,
          credentials: params.credentials,
          happyHomeDir: configuration.happyHomeDir,
          featureGate: providerFeatureGate,
          resolveSharedGateway,
          runtimeSummary: (input) => providerRuntimeServices.summary(input),
          refreshOnEnable: (input) => providerRuntimeServices.probe(input),
          ...(params.resolveManagedPurposeBindingIntent
            ? {
                resolveManagedPurposeBindingIntent:
                  params.resolveManagedPurposeBindingIntent,
              }
            : {}),
          discoveryCandidates: async ({ registry, connections }) => {
            const snapshot = await params.readLocalServiceInventorySnapshot?.();
            return snapshot
              ? projectProviderDiscoveryCandidates({
                  snapshot,
                  registry,
                  connections,
                })
              : [];
          },
          localInstallations: (request) => providerLocalInstallationReader.read(request),
        })
      : null;
    const providerConnectionUnavailable = async (request: Readonly<{ connectionId?: string; machineId: string }>) => ({
      status: 'error' as const,
      error: createProviderErrorV1('provider_feature_disabled', {
        ...(request.connectionId ? { connectionId: request.connectionId } : {}),
        machineId: request.machineId,
      }),
    });
    const providerHomeServerUrl = resolveServerHttpBaseUrl();
    const readProviderModelProjection: ProviderRuntimeModelProjectionReader | undefined = storedCredentials
      ? (request, signal) => {
          const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
          return createAccountScopedProviderModelProjectionReader({
            serverUrl: providerHomeServerUrl,
            readCredentials: async () => storedCredentials,
            readAccountSettingsSnapshot: async () => getActiveAccountSettingsSnapshot(),
            isCurrent: () => !params.isShuttingDown()
              && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken
              && getActiveAccountSettingsSnapshot()?.scopeKey === resolveAccountSettingsScopeKey(storedCredentials),
          })(request, signal);
        }
      : undefined;
    providerRuntimeServices = createRuntimeProviderModelManagementServices({
      machineId: params.machineId,
      happyHomeDir: configuration.happyHomeDir,
      featureGate: providerFeatureGate,
      resolveSharedGateway,
      ...(readProviderModelProjection ? { readModelProjection: readProviderModelProjection } : {}),
      modelSettingsMutation: providerConnectionRuntimeServices?.service.mutateModelSettings
        ?? providerConnectionUnavailable,
      localCatalogFallback: createProviderLocalCatalogFallbackRunner({
        runner: providerLocalToolContext,
      }),
      ...(params.managedCatalogRuntime
        ? { managedCatalogRuntime: params.managedCatalogRuntime }
        : {}),
      ...(params.resolveManagedPurposeBindingIntent
        ? {
            resolveManagedPurposeBindingIntent:
              params.resolveManagedPurposeBindingIntent,
          }
        : {}),
      ...(params.openTeamDirect ? { openTeamDirect: params.openTeamDirect } : {}),
    });
    providerLocalInstallationReader = createProviderLocalInstallationReader({
      ...providerLocalToolContext,
      runtimeStore: providerRuntimeServices.runtimeStore,
    });
    const agentCatalogObservation = params.createAgentCatalogObservation?.(
      providerRuntimeServices.probeInfrastructure,
    ) ?? null;
    const providerProfileMigrationUnavailable = async (request: Readonly<{
      machineId: string;
      sourceProfileId?: string;
    }>) => ({
      status: 'error' as const,
      error: createProviderErrorV1('provider_feature_disabled', {
        machineId: request.machineId,
        sourceProfileId: request.sourceProfileId,
      }),
    });
    const providerProfileMigrationRpcServices = params.credentials
      ? createLegacyProfileMigrationRpcServices({ credentials: params.credentials })
      : null;
    providerOperationsProducer = createRuntimeProviderOperationsProducer({
      machineId: params.machineId,
      featureGate: providerFeatureGate,
      machineServices: {
        ...providerRuntimeServices,
        probe: (input, waiterLifetime) => providerRuntimeServices.probe(
          input,
          'manual_refresh',
          waiterLifetime,
        ),
        probeDraft: (input, waiterLifetime) => providerRuntimeServices.probeDraft(input, waiterLifetime),
        describeConnections: providerConnectionRuntimeServices?.describeConnections
          ?? providerConnectionUnavailable,
        mutateConnection: providerConnectionRuntimeServices?.mutateConnection
          ?? providerConnectionUnavailable,
        previewProfileMigration: providerProfileMigrationRpcServices?.previewProfileMigration
          ?? providerProfileMigrationUnavailable,
        confirmProfileMigration: providerProfileMigrationRpcServices?.confirmProfileMigration
          ?? providerProfileMigrationUnavailable,
        confirmProfileMigrationConflict: providerProfileMigrationRpcServices?.confirmProfileMigrationConflict
          ?? providerProfileMigrationUnavailable,
        prepareProfileMigrationSource: providerProfileMigrationRpcServices?.prepareProfileMigrationSource
          ?? providerProfileMigrationUnavailable,
      },
    });

    const machineRpcLifecycleRegistration = connectedApiMachine.setRPCHandlers(
      {
        spawnSession: params.spawnSession,
        sessionSpawnV1OutcomeRequired: true,
        resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
        ...(storedCredentials ? {
          abandonSpawnSessionByNonce: async (spawnNonce: string) => await abandonSpawnedSessionUntilCompleted({
            spawnNonce,
            resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
            archiveSession: async (sessionId) => {
              const archived = await setSessionArchivedState({
                credentials: storedCredentials,
                idOrPrefix: sessionId,
                archived: true,
              });
              return archived.ok && archived.archivedAt !== null;
            },
          }),
        } : {}),
        stopSession: params.stopSession,
        isSessionActive: params.isSessionAlreadyRunning,
        loadLocalSessionMetadata: params.loadLocalSessionMetadataForHandoff,
        requestShutdown: () => {
          void params.beforeShutdown().finally(() => params.requestShutdown('happier-app'));
        },
        ...(memoryWorker ? { memory: memoryWorker } : {}),
        daemonServerWorkScheduler: params.daemonServerWorkScheduler,
        ...(voiceInferenceWorker ? { voiceInference: voiceInferenceWorker } : {}),
        machineTransferChannel: {
          onEnvelope: (listener) => connectedApiMachine.onMachineTransferEnvelope(listener),
          sendEnvelope: (payload) => connectedApiMachine.sendMachineTransferEnvelope(payload),
        },
        transferRelayV2Channel: {
          machineId: params.machineId,
          onEnvelope: (listener) => connectedApiMachine.onTransferRelayV2Envelope(listener),
          sendEnvelope: (payload) => connectedApiMachine.sendTransferRelayV2Envelope(payload),
        },
        ...(directPeerTransferHandlers ? { directPeerTransfer: directPeerTransferHandlers } : {}),
        ...(directPeerServerLifecycle
          ? {
              directTransferImport: {
                prepareImportSession: directPeerServerLifecycle.prepareImportSession,
                abortImportSession: directPeerServerLifecycle.abortImportSession,
              },
            }
          : {}),
        ...(directTransferExportHandlers
          ? {
              directTransferExport: directTransferExportHandlers,
            }
          : {}),
      },
      {
        ...(params.sessionRunnerStatus ? { sessionRunnerStatus: params.sessionRunnerStatus } : {}),
        sessionPendingResetStartInstalled: pendingResetStartPorts !== null,
        npmRegistryProfiles: {
          machineId: params.machineId,
          service: createNpmRegistryProfileService({
            happyHomeDir: params.happyHomeDir,
            probe: createNpmRegistryProfileProbe(),
          }),
        },
        providerRpc: {
          machineId: params.machineId,
          services: providerOperationsProducer.machineServices,
          featureGate: providerFeatureGate,
        },
        ...(agentCatalogObservation ? { agentCatalogObservation } : {}),
        emitExternalSessionTranscriptUpdate: (payload) => connectedApiMachine.emitExternalSessionTranscriptUpdate(payload),
        emitExternalSessionSourceUnavailableOccurrence: (payload) =>
          connectedApiMachine.emitExternalSessionSourceUnavailableOccurrence(payload),
        ...(params.deviceLocalSecretStorage
          ? { deviceLocalSecretStorage: params.deviceLocalSecretStorage }
          : {}),
        executeExternalSessionHistoricalImportCommand: async (command) =>
          await connectedApiMachine.executeExternalSessionHistoricalImportCommand(command),
        persistedTakeoverAdmissionWaiter:
          params.persistedTakeoverAdmissionWaiter,
        attachPersistedTakeoverAdmissionOwner:
          params.attachPersistedTakeoverAdmissionOwner,
        installExternalSessionHostOperations:
          params.installExternalSessionHostOperations,
        currentMachineId: params.machineId,
        ...(params.prepareRunTeamCredentialProviderBinding
          ? { prepareRunTeamCredentialProviderBinding: params.prepareRunTeamCredentialProviderBinding }
          : {}),
        ...(params.openAccountConnectionManagedConsumerSource
          ? { openAccountConnectionManagedConsumerSource: params.openAccountConnectionManagedConsumerSource }
          : {}),
        ...(params.resolveManagedPurposeBindingIntent
          ? { resolveManagedPurposeBindingIntent: params.resolveManagedPurposeBindingIntent }
          : {}),
        ...(storedCredentials
          ? {
              resolveExecutionRunLiveBrokerAuthority: async (input) => {
                const snapshot = params.getServerFeaturesSnapshot?.();
                const target = await resolveSessionTransportContext({
                  credentials: storedCredentials,
                  idOrPrefix: input.sessionId,
                  ...(snapshot ? { serverFeaturesSnapshot: snapshot } : {}),
                });
                if (!target.ok || target.sessionId !== input.sessionId) {
                  return { status: 'not_current' as const, reason: 'runtime_unavailable' as const };
                }
                const rpc = {
                  token: storedCredentials.token,
                  sessionId: target.sessionId,
                  method: `${target.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_BROKER_AUTHORITY_RESOLVE_V1}`,
                  request: {
                    v: 1,
                    executionRunId: input.executionRunId,
                    ...(input.expectedIntent !== undefined ? { expectedIntent: input.expectedIntent } : {}),
                    expectedOccurrenceId: input.expectedOccurrenceId,
                    ...(input.expectedDirectMaterialUse
                      ? { expectedDirectMaterialUse: input.expectedDirectMaterialUse }
                      : {}),
                  },
                };
                const response = target.mode === 'plain'
                  ? await callSessionRpc({ ...rpc, mode: 'plain' })
                  : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: target.ctx });
                return SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(response);
              },
            }
          : {}),
        ...(params.externalActionIngressOwner
          ? { externalActionIngressOwner: params.externalActionIngressOwner }
          : {}),
        ...(params.awaitAgentSessionOpen
          ? { awaitAgentSessionOpen: params.awaitAgentSessionOpen }
          : {}),
        ...(params.subscribeConnectedAccountInvalidations
          ? {
              subscribeConnectedAccountInvalidations:
                params.subscribeConnectedAccountInvalidations,
            }
          : {}),
        getServerFeaturesSnapshot: params.getServerFeaturesSnapshot,
        ...(usageLimitRecoveryMutationCustody
          ? {
              stageUsageLimitRecoveryMutation: async (input) => {
                await usageLimitRecoveryMutationCustody.stage(input);
              },
              stageWorkStateMutation: async (input) => {
                await usageLimitRecoveryMutationCustody.stageWorkState(input);
              },
            }
          : {}),
        resumeInactiveSessionWhenUsageLimitReady: async ({ sessionId, rawSession, metadata }) =>
          await activateInactiveUsageLimitResume({
            fallbackMachineId: params.machineId,
            sessionId,
            rawSession,
            metadata,
            spawnSession: params.spawnSession,
          }),
        scheduleInactiveSessionUsageLimitRecoveryCheck: async ({ sessionId, recovery, runCheckNow }) => {
          await inactiveUsageLimitRecoveryCheckOwner.schedule({
            sessionId,
            recovery,
            runCheckNow,
            scheduler: inactiveUsageLimitRecoveryScheduler,
          });
        },
        readInactiveSessionUsageLimitRecovery: ({ sessionId }) =>
          inactiveUsageLimitRecoveryScheduler.read(sessionId),
        cancelInactiveSessionUsageLimitRecoveryCheck: async ({
          sessionId,
          issueFingerprint,
          armedAtMs,
          runtimeAuthRecoveryAttemptId,
        }) => {
          await inactiveUsageLimitRecoveryCheckOwner.cancelExact({
            sessionId,
            issueFingerprint,
            armedAtMs,
            ...(runtimeAuthRecoveryAttemptId ? { runtimeAuthRecoveryAttemptId } : {}),
            scheduler: inactiveUsageLimitRecoveryScheduler,
          });
        },
        ...(params.cancelConnectedServiceRuntimeAuthRecovery
          ? { cancelConnectedServiceRuntimeAuthRecovery: params.cancelConnectedServiceRuntimeAuthRecovery }
          : {}),
        ...(params.retryTemporaryThrottleNow
          ? { retryTemporaryThrottleNow: params.retryTemporaryThrottleNow }
          : {}),
        ...(params.readTemporaryThrottleRecovery
          ? { readTemporaryThrottleRecovery: params.readTemporaryThrottleRecovery }
          : {}),
        ...(params.cancelTemporaryThrottleRecovery
          ? { cancelTemporaryThrottleRecovery: params.cancelTemporaryThrottleRecovery }
          : {}),
      },
    );
    externalSessionPluginAdmissionOwner =
      machineRpcLifecycleRegistration.externalSessionPluginAdmissionOwner;
    externalSessionHostActionExecutor =
      machineRpcLifecycleRegistration.externalSessionHostActionExecutor;
    sessionSpawnDirectTargetTransport =
      machineRpcLifecycleRegistration.sessionSpawnDirectTargetTransport;
    voiceBinaryAppendConsumer =
      machineRpcLifecycleRegistration?.voiceInference?.voiceInferenceStreaming.appendSttStreamBinaryFrame;
    voiceBinaryTerminalConsumer =
      machineRpcLifecycleRegistration?.voiceInference?.voiceInferenceStreaming.cancelSttStreamForTransportLoss;

    // PMS-9 (finding #49) + PMS-WIRE: supply ONE observability emitter to the DIRECT loopback routes
    // AND both relay terminators. In production startup hands in the shared emitter
    // (`params.peerMediationMachineRpc.observability`) whose store is also published onto the Api
    // provider bridge for the read-path executor, so the write-path and read-path bind to the SAME
    // store. Narrow callers without that shared runtime do not collect into an unread fallback.
    const peerMediationObservabilityEmitter = params.peerMediationMachineRpc?.observability;

    peerMediationLoopback = await maybeStartPeerMediationLoopback({
      config: params.peerMediationMachineRpc,
      observability: peerMediationObservabilityEmitter,
      connectedApiMachine,
      credentials: params.credentials,
      machine: params.machine,
      machineId: params.machineId,
      ...(params.machineIrohRuntime ? { machineIrohRuntime: params.machineIrohRuntime } : {}),
      directPeerServerLifecycle: params.directPeerServerLifecycle,
      ...(params.acquireLocalServicePreviewApplication ? { acquireLocalServicePreviewApplication: params.acquireLocalServicePreviewApplication } : {}),
      ...(params.acquireWorkspaceSyncMachineIngress
        ? { acquireWorkspaceSyncMachineIngress: params.acquireWorkspaceSyncMachineIngress }
        : {}),
      ...(params.getServerFeaturesSnapshot
        ? { getServerFeaturesSnapshot: params.getServerFeaturesSnapshot }
        : {}),
      ...(params.resolvePeerMediationTrustRoots
        ? { resolvePeerMediationTrustRoots: params.resolvePeerMediationTrustRoots }
        : {}),
      ...(voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer } : {}),
      ...(voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer } : {}),
    }).catch((error) => {
      logger.warn('[DAEMON RUN] Failed to start peer mediation loopback route', error);
      return null;
    });
    if (peerMediationLoopback) {
      const startedPeerMediationLoopback = peerMediationLoopback;
      const hasNativePreviewApplication = Boolean(
        params.acquireLocalServicePreviewApplication && peerMediationLoopback.activeFlows.tcp_tunnel,
      );
      stopPeerMediationLoopbackServer = async () => {
        if (hasNativePreviewApplication) {
          await connectedApiMachine.setLocalServicePreviewNativeAccessLive(false).catch((error) => {
            logger.warn('[DAEMON RUN] Failed to withdraw native preview capability', error);
          });
        }
        await startedPeerMediationLoopback.stop();
      };
      if (params.machineIrohRuntime) {
        const admissionPort = Number(new URL(peerMediationLoopback.endpoint.url).port);
        try {
          await params.machineIrohRuntime.startAttemptAcceptor({ admissionPort });
          activeMachineIrohRuntime = params.machineIrohRuntime;
          let stopped = false;
          stopMachineIrohAcceptor = async () => {
            if (stopped) return;
            stopped = true;
            activeMachineIrohRuntime = undefined;
            if (hasNativePreviewApplication) {
              await connectedApiMachine.setLocalServicePreviewNativeAccessLive(false).catch((error) => {
                logger.warn('[DAEMON RUN] Failed to withdraw native preview capability', error);
              });
            }
            await params.machineIrohRuntime!.stopActiveTunnels().catch((error) => {
              logger.warn('[DAEMON RUN] Failed to close active Iroh machine tunnels', error);
            });
            await params.machineIrohRuntime!.stopAttemptAcceptor().catch((error) => {
              logger.warn('[DAEMON RUN] Failed to stop Iroh machine acceptor', error);
            });
            await connectedApiMachine.updateDaemonState(removeMachineIrohEndpoint, {
              allowWhileQuiescing: true,
            }).catch((error) => {
              logger.warn('[DAEMON RUN] Failed to remove retired Iroh machine endpoint publication', error);
            });
          };
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to start Iroh machine acceptor', error);
        }
        if (activeMachineIrohRuntime && hasNativePreviewApplication) {
          await connectedApiMachine.setLocalServicePreviewNativeAccessLive(true).catch((error) => {
            logger.warn('[DAEMON RUN] Failed to publish native preview capability', error);
          });
        }
      }
    }

    const peerTcpTunnelRelayContext = await resolvePeerTcpTunnelRelayBootstrapContext({
      config: params.peerMediationMachineRpc,
      credentials: params.credentials,
    }).catch((error) => {
      logger.warn('[DAEMON RUN] Failed to resolve peer TCP tunnel relay context', error);
      return null;
    });
    if (peerTcpTunnelRelayContext) {
      const nowMs = params.peerMediationMachineRpc?.nowMs ?? (() => Date.now());
      const relayRuntime = registerMachinePeerTcpTunnelRelayRuntime({
          accountId: peerTcpTunnelRelayContext.accountId,
          machineId: params.machineId,
          serverFeatures: peerTcpTunnelRelayContext.serverFeatures,
          nowMs,
          eventPort: {
            subscribe: (listener) => connectedApiMachine.onPeerTcpTunnelRelayEnvelope(listener),
            emit: (payload) => connectedApiMachine.sendPeerTcpTunnelRelayEnvelope(payload),
          },
          observability: peerMediationObservabilityEmitter,
          ...(voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer } : {}),
          ...(voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer } : {}),
          ...(params.peerMediationMachineRpc?.resolveExternalProviderBrokerApplicationTarget
            ? {
                resolveProviderBrokerApplicationTarget:
                  params.peerMediationMachineRpc.resolveExternalProviderBrokerApplicationTarget,
              }
            : {}),
          onHandlerError: (error) => {
            logger.warn('[DAEMON RUN] Peer TCP tunnel relay handler failed', error);
          },
        });
      if (relayRuntime) {
        cleanupPeerTcpTunnelRelay = () => {
          cleanupPeerTcpTunnelRelay = null;
          void relayRuntime.dispose().catch((error) => {
            logger.warn('[DAEMON RUN] Failed to retire peer TCP tunnel relay', error);
          });
        };
      }
    }

    const liveStreamOptions = params.peerMediationMachineRpc?.stream;
    const liveStreamCaptureAdapter = liveStreamOptions?.captureAdapter;
    if (liveStreamCaptureAdapter) {
      const liveStreamRelayTerminator = createMachineLiveStreamRelayTerminator({
        machineId: params.machineId,
        captureAdapter: liveStreamCaptureAdapter,
        nowMs: params.peerMediationMachineRpc?.nowMs ?? (() => Date.now()),
        emitEnvelope: (payload) => connectedApiMachine.sendMachineLiveStreamRelayEnvelope(payload),
        observability: peerMediationObservabilityEmitter,
        ...(liveStreamOptions.readActiveControlLease
          ? { readActiveControlLease: liveStreamOptions.readActiveControlLease }
          : {}),
      });
      const stopPriorPeerMediationRuntime = stopPeerMediationLoopbackServer;
      stopPeerMediationLoopbackServer = async () => {
        await Promise.all([
          stopPriorPeerMediationRuntime(),
          liveStreamRelayTerminator.dispose(),
        ]);
      };
      // SIM-P0-1: the viewer cannot start a server-relayed stream on its own socket, so the UI
      // delivers the server-minted, signed startRequest over machine RPC; the terminator starts
      // capture and echoes the start on this machine-scoped socket for server-side verification.
      connectedApiMachine.registerLiveStreamRelayRoutes({
        start: (startRequest, callerAuthority) => liveStreamRelayTerminator.start(startRequest, callerAuthority),
      });
      const cleanupMachineLiveStreamRelaySubscription = connectedApiMachine.onMachineLiveStreamRelayEnvelope((payload) => {
        // Starts arrive exclusively over the machine RPC above (SIM-P0-1). The server never
        // forwards `start` envelopes into machine rooms, so no start branch exists here.
        if (payload.message.kind !== 'control' && payload.message.kind !== 'sideband_control' && payload.message.kind !== 'renew') return;
        const result = liveStreamRelayTerminator.applyControl(payload);
        if (result.ok) return;
        logger.warn('[DAEMON RUN] Live-stream relay control denied', {
          reasonCode: result.reasonCode,
          streamId: payload.message.kind === 'renew' ? payload.message.startRequest.streamId : payload.message.control.streamId,
        });
      });
      let didCleanupMachineLiveStreamRelay = false;
      cleanupMachineLiveStreamRelay = () => {
        if (didCleanupMachineLiveStreamRelay) return;
        didCleanupMachineLiveStreamRelay = true;
        cleanupMachineLiveStreamRelaySubscription();
        void liveStreamRelayTerminator.dispose().catch((error) => {
          logger.warn('[DAEMON RUN] Failed to dispose live-stream relay captures', error);
        });
        cleanupMachineLiveStreamRelay = null;
      };
    }

    if (storedCredentials) {
      const credentials = storedCredentials;
      const stopProjectRowsRefresh = connectedApiMachine.onAccountProjectRowsChanged(async ({ signal }) => {
        await readProjectAccountRows({ credentials, signal });
      });
      const priorMachineConnectionStateCleanup = machineConnectionStateCleanup;
      machineConnectionStateCleanup = () => {
        stopProjectRowsRefresh();
        priorMachineConnectionStateCleanup?.();
      };
      connectedApiMachine.onUpdate((update) => {
        const settingsVersion = readAccountSettingsChangedHintVersion(update);
        if (settingsVersion === null) return false;

        void refreshDaemonAccountSettingsForHint({ credentials, settingsVersion }).catch((error) => {
          logger.warn('[DAEMON RUN] Failed to refresh account settings from live hint', error);
        });
        return true;
      });

      connectedApiMachine.onAccountSettingsVersionHint(async (hint) => {
        await refreshDaemonAccountSettingsForHint({
          credentials,
          settingsVersion: hint.settingsVersion,
        });
      });
    }

    let recoverPendingSessionActivationsAfterConnect = async (): Promise<void> => {};
    if (storedCredentials) {
      const credentials = storedCredentials;
      const activateRequesterSession = async (
        binding: Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution'>,
        hint?: PendingSessionActivationInput,
      ): Promise<void> => {
        if (!params.resolveRequesterSessionRuntimeContext || !params.releaseRequesterSessionRuntimeContext
          || !params.resolveCurrentMachineExecutionOriginContext
          || binding.attribution.machineId !== params.machineId) return;
        const context = await params.resolveRequesterSessionRuntimeContext(binding.sessionId, binding.attribution);
        if (!context) return;
        try {
          if (!await context.isCurrent()) return;
          const current = await readRequesterPendingSessionActivation({ sessionId: binding.sessionId, bootstrap: context.bootstrap,
            resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext });
          if (!await context.isCurrent() || !current || hint && (hint.requestId !== current.requestId
            || hint.requestedAt !== undefined && hint.requestedAt !== current.requestedAt)) return;
          const result = await activatePendingInactiveSession({ credentials: context.bootstrap.credentials,
            machineId: params.machineId, sessionId: current.sessionId, requestId: current.requestId,
            pendingVersion: hint?.pendingVersion ?? current.pendingVersion, requester: context.bootstrap,
            expectedTarget: current.target,
            resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext,
            spawnSession: options => params.spawnSession({ ...options, requesterSessionBootstrap: context.bootstrap,
              requesterSessionRuntimeContext: context }) });
          if (result.status === 'rejected') logger.warn('[DAEMON RUN] Requester Pending activation rejected; custody retained', {
            sessionId: current.sessionId, requestId: current.requestId, reason: result.reason,
          });
        } finally { await params.releaseRequesterSessionRuntimeContext(context); }
      };
      const activatePendingSession = async (hint: PendingSessionActivationInput): Promise<void> => {
        if (hint.target) {
          const origin = await params.resolveCurrentMachineExecutionOriginContext?.();
          if (!params.requesterServerId || origin?.serverIdentityId !== hint.target.homeId
            || origin.machineId !== hint.target.machineId) return;
          await activateRequesterSession({ sessionId: hint.target.sessionId, attribution: {
            serverId: params.requesterServerId, accountId: hint.target.accountId,
            machineId: hint.target.machineId, installationId: hint.target.installationId,
          } }, hint);
          return;
        }
        const result = await activatePendingInactiveSession({
          credentials,
          machineId: params.machineId,
          sessionId: hint.sessionId,
          requestId: hint.requestId,
          pendingVersion: hint.pendingVersion,
          spawnSession: params.spawnSession,
        });
        if (result.status === 'rejected') {
          logger.warn('[DAEMON RUN] Exact inactive Pending activation was rejected; Pending custody retained', {
            sessionId: hint.sessionId,
            requestId: hint.requestId,
            source: hint.source,
            reason: result.reason,
          });
        }
      };
      const pendingSessionActivationRecovery = createPendingSessionActivationRecovery({
        token: credentials.token,
        activate: activatePendingSession,
        visitOwnedSession: sessionId => inactiveUsageLimitRecoveryScheduler.reconcilePendingResetStarts(sessionId)
          .catch(error => logger.warn('[DAEMON RUN] Pending reset reconnect demand remains held', error)),
        warn: (message, input, error) => logger.warn(`[DAEMON RUN] ${message}`, { input, error }),
        recoverRequesterSessions: async () => {
          const discovery = await params.readRequesterSessionCredentialBindings?.();
          if (!discovery) return;
          if (discovery.status !== 'ready') {
            logger.warn('[DAEMON RUN] Requester pending recovery unavailable; protected custody retained', { reason: discovery.reason });
            return;
          }
          for (const binding of discovery.bindings) {
            await inactiveUsageLimitRecoveryScheduler.reconcilePendingResetStarts(binding.sessionId)
              .catch(error => logger.warn('[DAEMON RUN] Requester Pending reset demand remains held', error));
            await activateRequesterSession(binding).catch(error => logger.warn('[DAEMON RUN] Requester pending recovery item failed; custody retained', {
              sessionId: binding.sessionId, error: serializeAxiosErrorForLog(error),
            }));
          }
        },
      });
      connectedApiMachine.onPendingSessionActivationHint(
        pendingSessionActivationRecovery.activateHint,
      );
      recoverPendingSessionActivationsAfterConnect =
        pendingSessionActivationRecovery.recoverAfterConnect;
    }

    connectedApiMachine.onUpdate((update) => {
      const body = UpdateBodySchema.safeParse(update?.body);
      if (body.success && body.data.t === 'pending-changed' && !params.isShuttingDown()) {
        void inactiveUsageLimitRecoveryScheduler.reconcilePendingResetStarts(body.data.sessionId ?? body.data.sid)
          .catch(error => logger.warn('[DAEMON RUN] Pending reset live demand remains held', error));
      }
      const projectedAutomationRunStateChanged = projectAutomationRunStateChangedHostEvent(
        update,
        params.isShuttingDown,
      );
      if (projectedAutomationRunStateChanged) {
        if (activeAutomationWorker && !params.isShuttingDown()) {
          activeAutomationWorker.handleServerUpdate(update);
        }
        return true;
      }
      if (!activeAutomationWorker) return false;
      const t = (update?.body as any)?.t;
      if (t === 'automation-assignment-updated' || t === 'automation-run-updated') {
        const automationWorkerHandle = activeAutomationWorker;
        automationWorkerHandle.handleServerUpdate(update);
        return true;
      }
      return false;
    });

    const connectedServiceQuotasLoopHandle = params.connectedServiceQuotasLoopHandle;
    const connectedServiceRefreshLoopHandle = params.connectedServiceRefreshLoopHandle;
    const unsubscribePendingResetQuotaTick = connectedServiceQuotasLoopHandle?.subscribeAfterTick(async () => {
      if (params.isShuttingDown()) return;
      await inactiveUsageLimitRecoveryScheduler.reconcilePendingResetStartsForTrackedSessions()
        .catch(error => logger.warn('[DAEMON RUN] Pending reset quota demand remains held', error));
    });

    daemonConnectivityCoordinator = createDaemonConnectivityCoordinator({
      resources: [
        ...(machineRpcLifecycleRegistration?.connectivityResources ?? []),
        ...(activeAutomationWorker
          ? [
              {
                name: 'automationWorker',
                pause: () => {
                  const automationWorkerHandle = activeAutomationWorker;
                  automationWorkerHandle.pause();
                },
                resume: () => {
                  const automationWorkerHandle = activeAutomationWorker;
                  automationWorkerHandle.resume();
                },
              },
            ]
          : []),
        ...(connectedServiceQuotasLoopHandle
          ? [
              {
                name: 'connectedServiceQuotasLoop',
                pause: () => connectedServiceQuotasLoopHandle.pause(),
                resume: () => connectedServiceQuotasLoopHandle.resume(),
              },
            ]
          : []),
        ...(connectedServiceRefreshLoopHandle
          ? [
              {
                name: 'connectedServiceRefreshLoop',
                pause: () => connectedServiceRefreshLoopHandle.pause(),
                resume: () => connectedServiceRefreshLoopHandle.resume(),
              },
            ]
          : []),
      ],
    });

    const cleanupPluginConnectionStateSource = bindPluginDaemonConnectionStateSource(connectedApiMachine);
    const cleanupDaemonConnectivityState = connectedApiMachine.onConnectionStateChange((state) => {
      if (params.isShuttingDown()) return;

      const online = state.phase === 'online';
      params.setDaemonServerWorkOnline?.(online);
      if (online) {
        void (async () => {
          try {
            await usageLimitRecoveryMutationCustody?.bindRecoveredJournals([]);
            if (params.isShuttingDown()) return;
            await params.onMachineConnectionOnline?.();
          } finally {
            if (!params.isShuttingDown()) {
              await triggerProviderLegacyProfileMigration();
            }
          }
        })().catch((error) => {
          logger.warn('[DAEMON RUN] Failed to refresh reconnect-owned daemon work', error);
        });
      }
      void daemonConnectivityCoordinator!.applyState(state).catch((error) => {
        logger.warn('[DAEMON RUN] Failed to apply daemon connectivity state', error);
      });
    });
    let didCleanupMachineConnectionState = false;
    let stopWatchingCliUpdateRecord: (() => void) | null = null;
    const cleanupManagedSessionDirectoryRemoval = machineConnectionStateCleanup;
    machineConnectionStateCleanup = () => {
      if (didCleanupMachineConnectionState) {
        return;
      }
      didCleanupMachineConnectionState = true;
      cleanupManagedSessionDirectoryRemoval?.();
      stopWatchingCliUpdateRecord?.();
      stopWatchingCliUpdateRecord = null;
      cleanupDaemonConnectivityState();
      unsubscribePendingResetQuotaTick?.();
      cleanupPluginConnectionStateSource();
      cleanupMachineLiveStreamRelay?.();
      cleanupPeerTcpTunnelRelay?.();
    };

    let didRefreshMachineMetadata = false;
    let publishedCliUpdateFacts: string | null = null;
    let machineMetadataRefreshInFlight: Promise<void> | null = null;
    const refreshMachineMetadataPublication = async (): Promise<void> => {
      if (params.isShuttingDown() || didRefreshMachineMetadata) return;
      if (machineMetadataRefreshInFlight) {
        await machineMetadataRefreshInFlight;
        if (!params.isShuttingDown() && !didRefreshMachineMetadata) {
          await refreshMachineMetadataPublication();
        }
        return;
      }

      const operation = (async () => {
        try {
          const cliUpdate = params.readCliUpdateFacts?.();
          let devcontainerChild: MachineMetadata['devcontainerChild'] | null = undefined;
          if (params.machine.metadata?.devcontainerChild && params.credentials) {
            const origin = await params.resolveCurrentMachineExecutionOriginContext?.();
            if (!origin || origin.machineId !== params.machineId) {
              throw new Error('Current Home identity is unavailable for admitted child metadata.');
            }
            devcontainerChild = await readCurrentManagedChildMachineMetadata({ current: params.machine.metadata,
              credentials: params.credentials, homeId: origin.serverIdentityId, machineId: origin.machineId,
              serverHttpBaseUrl: resolveServerHttpBaseUrl() });
          }
          const outcome = await connectedApiMachine.updateMachineMetadata((metadata) => {
            const base = (metadata ?? params.machine.metadata ?? {}) as Partial<MachineMetadata>;
            return refreshMachineMetadataForCurrentDaemon(base, {
              host: params.preferredHost,
              platform: readLocalHostIdentity().platform,
              happyCliVersion: params.cliVersion,
              homeDir: os.homedir(),
              happyHomeDir: params.happyHomeDir,
              happyLibDir: params.happyLibDir,
              ...(cliUpdate ? { cliUpdate } : {}),
              ...(devcontainerChild !== undefined ? { devcontainerChild } : {}),
            });
          });
          if (outcome !== 'suppressed') {
            didRefreshMachineMetadata = true;
            publishedCliUpdateFacts = JSON.stringify(cliUpdate ?? null);
          }
        } catch (error) {
          logger.warn('[DAEMON RUN] Failed to refresh machine metadata on reconnect', error);
        }
      })();
      machineMetadataRefreshInFlight = operation;
      try {
        await operation;
      } finally {
        if (machineMetadataRefreshInFlight === operation) {
          machineMetadataRefreshInFlight = null;
        }
        // A result recorded while this publication was in flight runs now, as one trailing publish.
        if (cliUpdateRepublishPending) void republishCliUpdateFactsIfChanged();
      }
    };
    // K5: an update attempt that recorded its end republishes the facts (only when they changed).
    // A change that arrives while a publication is in flight — or before the first one — stays
    // pending and is published when that publication settles (the 0.2 publisher's behaviour).
    let cliUpdateRepublishPending = false;
    const republishCliUpdateFactsIfChanged = async (): Promise<void> => {
      if (params.isShuttingDown() || !params.readCliUpdateFacts) return;
      if (machineMetadataRefreshInFlight || publishedCliUpdateFacts === null) return;
      cliUpdateRepublishPending = false;
      if (JSON.stringify(params.readCliUpdateFacts()) === publishedCliUpdateFacts) return;
      didRefreshMachineMetadata = false;
      await refreshMachineMetadataPublication();
    };
    stopWatchingCliUpdateRecord = params.watchCliUpdateRecord?.(() => {
      cliUpdateRepublishPending = true;
      void republishCliUpdateFactsIfChanged();
    }) ?? null;
    let hasPendingMachineConnectionPublications = false;
    let machineConnectionPublicationsInFlight: Promise<void> | null = null;
    const refreshMachineConnectionPublications = async (): Promise<void> => {
      hasPendingMachineConnectionPublications = true;
      if (params.isShuttingDown()) return;
      if (machineConnectionPublicationsInFlight) {
        await machineConnectionPublicationsInFlight;
        if (hasPendingMachineConnectionPublications && !params.isShuttingDown()) {
          await refreshMachineConnectionPublications();
        }
        return;
      }

      const operation = (async () => {
        // Incident Jun-11 H-A / FIX-1a: best-effort snapshot warm on every machine (re)connect.
        // The changes catch-up only emits a hint when account changes exist past the persisted
        // cursor, so a freshly restarted daemon can connect and still hold a NULL snapshot.
        if (params.credentials) {
          void warmActiveAccountSettingsSnapshotBestEffort({
            credentials: params.credentials,
            logger,
          });
        }

        const activePeerMediationLoopback = peerMediationLoopback;
        if (activePeerMediationLoopback || needsPersistedIrohEndpointWithdrawal || params.machine.daemonState?.peerMediation?.iroh) {
          const outcome = await connectedApiMachine
            .updateDaemonState((state) => reconcileMachineIrohEndpoint(
              activePeerMediationLoopback
                ? mergePeerMediationLoopbackEndpoint(
                    state,
                    activePeerMediationLoopback.endpoint,
                    activePeerMediationLoopback.activeFlows,
                  )
                : state ?? { status: 'running' },
              activeMachineIrohRuntime,
            ))
            .catch((error) => {
              logger.warn('[DAEMON RUN] Failed to reconcile peer mediation endpoints', error);
              return null;
            });
          if (outcome === 'suppressed' || params.isShuttingDown()) return;
          if (outcome === 'published') needsPersistedIrohEndpointWithdrawal = false;
        }

        if (activeAutomationWorker) {
          const automationWorkerHandle = activeAutomationWorker;
          await automationWorkerHandle.refreshAssignments().catch((error) => {
            logger.warn('[DAEMON RUN] Failed to refresh automation assignments on machine reconnect', error);
          });
          if (params.isShuttingDown()) return;
        }

        await refreshMachineMetadataPublication();
        if (params.isShuttingDown() || !didRefreshMachineMetadata) return;
        hasPendingMachineConnectionPublications = false;
      })();
      machineConnectionPublicationsInFlight = operation;
      try {
        await operation;
      } finally {
        if (machineConnectionPublicationsInFlight === operation) {
          machineConnectionPublicationsInFlight = null;
        }
      }
    };
    resumeMachineConnectionPublications = async () => {
      await refreshMachineConnectionPublications();
      if (params.isShuttingDown()) return;
      await workflowRecoveryTriggers?.onResumed().catch((error) => {
        logger.warn('[DAEMON RUN] Workflow custody resume recovery failed; pending custody retained', error);
      });
    };
    const handleMachineConnected = async (): Promise<void> => {
      await refreshMachineConnectionPublications();
      if (params.isShuttingDown()) return;
      await recoverPendingSessionActivationsAfterConnect().catch((error) => {
        logger.warn('[DAEMON RUN] Pending session activation reconnect scan failed; waiting custody retained', error);
      });
      if (params.isShuttingDown()) return;
      await workflowRecoveryTriggers?.onConnected().catch((error) => {
        logger.warn('[DAEMON RUN] Workflow custody startup/reconnect recovery failed; pending custody retained', error);
      });
    };
    connectedApiMachine.connect({
      takeover: params.takeoverRequested,
      ...(params.prepareServerTransportForReconnect
        ? { prepareServerTransportForReconnect: params.prepareServerTransportForReconnect }
        : {}),
      onConnect: handleMachineConnected,
      onOwnershipConflict: (conflict) => {
        logger.warn('[DAEMON RUN] Relay ownership conflict prevented machine connection', conflict);
        params.requestShutdown('happier-app', 'machine-owner-conflict');
      },
      onMachineReplaced: (event) => {
        logger.warn('[DAEMON RUN] Machine was replaced by the server; shutting down stale daemon connection', event);
        params.requestShutdown('happier-app', 'machine-replaced');
      },
    });
  } else {
    logger.warn('[DAEMON RUN] Machine sync client unavailable; machine-bound workers were not started');
  }

  return {
    ...(sessionSpawnDirectTargetTransport
      ? { sessionSpawnDirectTargetTransport }
      : {}),
    ...(externalSessionHostActionExecutor
      ? { externalSessionHostActionExecutor }
      : {}),
    ...(externalSessionPluginAdmissionOwner
      ? {
          externalSessionPluginAdmissionOwner,
        }
      : {}),
    apiMachine: connectedApiMachine,
    apiMachineForSessions: connectedApiMachine,
    automationWorker,
    memoryWorker,
    voiceInferenceWorker,
    daemonConnectivityCoordinator,
    machineConnectionStateCleanup,
    stopPeerMediationLoopbackServer,
    stopMachineIrohAcceptor,
    resumeMachineConnectionPublications,
    daemonSessionMutationCustody: usageLimitRecoveryMutationCustody,
    cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop: async ({ sessionId }) =>
      await inactiveUsageLimitRecoveryCheckOwner.cancelSession({
        sessionId,
        scheduler: inactiveUsageLimitRecoveryScheduler,
      }),
    disposeInactiveSessionUsageLimitRecovery: () => inactiveUsageLimitRecoveryScheduler.dispose(),
    providerOperationsProducer,
  };
  } catch (error) {
    await retireMachineSyncRuntimeAttempt(getAttemptResources());
    throw error;
  }
}
