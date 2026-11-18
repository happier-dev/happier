import fs from 'fs/promises';
import { reconcileSessionManagerNotice } from '../sessions/sessionManagerNotice';
import { fetchAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentness';
import { projectDeploymentReceiptInvalidationsForHost } from '@/deployments/receiptEventInvalidation';
import { projectAccountEntitiesInvalidationForHost } from '@/daemon/events/accountEntityInvalidation';
import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import type { PendingSessionResumePort } from '../sessions/activatePendingInactiveSession';
import type { DaemonShutdownSource } from '../lifecycle/shutdown';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { readLocalHostIdentity } from '@happier-dev/cli-common/process';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';

import type { ApiMachineClient } from '@/api/apiMachine';
import { rotateMachineIdForActiveServer } from '@/api/machine/ensureMachineRegistered';
import type { MachineRpcHandlerDeps } from '@/api/machine/rpcHandlers';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';
import type { CliUpdateFacts } from '@happier-dev/protocol';
import type { DaemonState, Machine, MachineMetadata } from '@/api/types';
import { StoredMachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { SessionHandoffDirectPeerTransferHandle } from '@/api/machine/sessionHandoff/handlers';
import { createFileTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { readDaemonPluginUiArtifactBytes } from '@/rpc/handlers/daemonContributionRegistryProjection';
import type { DirectTransferExportPrepareRequest } from '@/api/machine/rpcHandlers.directTransferExports';
import type { DirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import type { PreparedFilesystemTransferScope } from '@/machines/transfer/preparedFilesystemTransferScope';
import { prepareFoundSkillExport } from '@/machines/transfer/prepareFoundSkillExport';
import { resolveRegistryItemDownloadSource } from '@/registries/registryTransferPayload';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { prepareWorkspaceFileExport } from '@/machines/transfer/prepareWorkspaceFileExport';
import { resolveDirectPeerServerEnabled } from '@/machines/transfer/transferRuntimeConfig';
import { prepareWorkspaceSyncSeedExport } from '@/machines/transfer/prepareWorkspaceSyncSeedExport';
import { resolveComposerMediaStageDownloadSource } from '@/transfers/targets/resolveComposerMediaStageDownloadSource';
import { createActiveDaemonComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';
import type {
  ComposerContentHandleV1,
  MachineLiveStreamControlLeaseV1,
} from '@happier-dev/protocol';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import {
  HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1,
  HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
  HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
} from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import { HAPPIER_DISCUSSION_INVALIDATED_HOST_EVENT_ID_V1, parseHostEventPayloadV1, type HostEventEnvelopeV1 } from '@happier-dev/protocol/plugins/events/hostV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import { activatePendingInactiveSession, type PendingInactiveSessionActivationRejected } from '@/daemon/sessions/activatePendingInactiveSession';
import { fetchInactiveSessionFollowObservations } from '@/session/transport/http/sessionFollowInactiveObservationsHttp';
import { createDiscussionFollowInputIntake } from '@/agent/runtime/session/follow/discussionFollowInput';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { SessionFollowSessionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import {
  createPendingSessionActivationRecovery,
  activateRequesterPendingSession,
  type PendingSessionActivationInput,
} from '@/daemon/sessions/pendingSessionActivationRecovery';
import type { RequesterSessionRuntimeContext, ResolveRequesterSessionRuntimeContext, RequesterSessionCredentialBindingsResult,
  RequesterSessionCredentialBinding } from '../sessionEncryption/requesterSessionCredentials';
import { activateInactiveUsageLimitResume } from '@/daemon/sessions/activateInactiveUsageLimitResume';
import { publishOrphanedStartupSessionEnds } from '@/daemon/sessions/publishOrphanedStartupSessionEnds';
import { readOrphanedDeadPlainRunnerMarkers, type OrphanedDeadDaemonSession } from '@/daemon/sessions/reattachFromMarkers';
import { retireOrphanedTerminalControlServiceability } from '@/daemon/sessions/retireOrphanedTerminalControlServiceability';
import { captureServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import { createMachineRoleActivationRuntime, type MachineRoleActivationRuntime, type MachineRoleContexts } from '../roles/machineRoleActivation';
import type { MachineRolesRuntime } from '../roles/machineRolesRuntime';
import { subscribeManagedSessionDirectoryRemoval } from '../sessions/subscribeManagedSessionDirectoryRemoval';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import type { VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import type { DaemonServerWorkScheduler } from '../serverWork';
import { createDaemonConnectivityCoordinator } from '../connection/createDaemonConnectivityCoordinator';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { logger } from '@/ui/logger';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { bindPluginDaemonConnectionStateSource } from '@/agent/runtime/registry/pluginConnectionStateSource';
import { publishDaemonHostEvent } from '@/daemon/events/publishDaemonHostEvent';
import type { Credentials, StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { normalizeAccountSettingsVersionHint } from '@/settings/accountSettings/accountSettingsVersion';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { createProviderAccountSettingsController } from '@/daemon/lifecycle/providerAccountSettings';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { createRuntimeProviderModelManagementServices, createProviderAccountOperationScope, type RuntimeProviderAccountModelProjectionContext } from '@/providers/modelManagement/runtimeServices';
import { createAccountScopedProviderModelProjectionReader } from '@/providers/modelManagement/remoteProjection';
import type { ProviderRuntimeModelProjectionReader } from '@/providers/spawn/runtimeCatalog';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken, subscribeActiveAccountSettingsKeys } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { createMachineSharedProviderGatewayResolver } from '@/providers/lifecycle/sharedGatewayIdentity';
export { createMachineSharedProviderGatewayResolver } from '@/providers/lifecycle/sharedGatewayIdentity';
import { readCurrentManagedChildMachineMetadata, refreshMachineMetadataForCurrentDaemon } from './metadata';
import { detectCliSnapshotOnDaemonPath } from '@/capabilities/snapshots/cliSnapshot';
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
import { createProviderLocalCatalogFallbackRunner, type ProviderLocalCommandRunner } from '@/providers/probe/localCommand';
import type { createAgentProviderCatalogObservationService } from '@/providers/probe/agentCatalogObservation';
import { resolveDaemonSpawnSessionByNonce } from '../controlClient';
import {
  UsageLimitRecoveryScheduler,
  type UsageLimitRecoveryIntent,
} from '../connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { createInactiveUsageLimitRecoveryCheckOwner } from '../connectedServices/usageLimitRecovery/inactiveUsageLimitRecoveryCheckOwner';
import { resolveInactiveUsageLimitRecoverySchedulerResult } from '../connectedServices/usageLimitRecovery/resolveInactiveUsageLimitRecoverySchedulerResult';
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
import { runMachineReconnectPhase } from './reconnectPhase';
import { recoverPendingFollowReceivers } from './recoverPendingFollowReceivers';

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
  publishDaemonHostEvent({
    eventId: HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
    scope: { kind: 'account' },
    payload,
  }, isShuttingDown);
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

async function resolvePeerMediationMachineRpcServerFeatures(
  config: PeerMediationMachineRpcBootstrapConfig | undefined,
): Promise<FeaturesResponse | null> {
  if (config?.serverFeatures !== undefined) {
    return config.serverFeatures;
  }
  const snapshot = await fetchServerFeaturesSnapshot({
    serverUrl: resolveServerHttpBaseUrl(),
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
  if (!runtime && !base.peerMediation?.iroh) return base;
  return {
    ...base,
    peerMediation: {
      ...base.peerMediation,
      iroh: runtime ? { endpoint: runtime.endpoint } : undefined,
    },
  };
}

function removePeerMediationLoopbackEndpoint(state: DaemonState | null): DaemonState {
  const base: DaemonState = state ?? { status: 'running' };
  if (!base.peerMediation?.loopback) return base;
  return { ...base, peerMediation: { ...base.peerMediation, loopback: undefined } };
}

function removeMachineIrohEndpoint(state: DaemonState | null): DaemonState {
  if (!state) throw new Error('Cannot remove an Iroh endpoint from an unpublished daemon state');
  return reconcileMachineIrohEndpoint(state, undefined);
}

export async function maybeStartPeerMediationLoopback(params: Readonly<{
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
  resolveServiceExport?: BootstrapMachineSyncRuntimeParams['resolveServiceExport'];
  onServiceExportTunnelsReady?: BootstrapMachineSyncRuntimeParams['onServiceExportTunnelsReady'];
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
      ...(params.onServiceExportTunnelsReady ? { onServiceExportTunnelsReady: params.onServiceExportTunnelsReady } : {}),
      ...(params.resolveServiceExport ? { resolveServiceExport: params.resolveServiceExport } : {}),
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
            if (!resolveDirectPeerServerEnabled()) return null;
            return params.directPeerServerLifecycle
              ? { port: await params.directPeerServerLifecycle.ensureListening() }
              : null;
          }
          if (handshake.flow !== 'workspace_sync') return null;
          if (!params.acquireWorkspaceSyncMachineIngress) return null;
          if (handshake.initiator.kind !== 'machine') return null;
          const ingress = await params.acquireWorkspaceSyncMachineIngress({
            actorAccountId: handshake.accountId,
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
  /** Split Machine roles (memory, voice) running for this attempt; owns their workers and RPC families. */
  roleActivations: MachineRoleActivationRuntime | null;
  daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null;
  machineConnectionStateCleanup: (() => void) | null;
  stopProviderAccountSettings?: () => Promise<void>;
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
    | 'roleActivations'
    | 'machineConnectionStateCleanup'
    | 'stopProviderAccountSettings'
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
    await params.stopProviderAccountSettings?.();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to retire Agent Account settings after machine-sync attempt failure', error);
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
    await params.roleActivations?.stop();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to stop Machine roles after machine-sync attempt failure', error);
  }
  try {
    await params.apiMachine?.shutdown();
  } catch (error) {
    logger.warn('[DAEMON RUN] Failed to shut down machine client after machine-sync attempt failure', error);
  }
}

export type BootstrapMachineSyncRuntimeParams = Readonly<{
  secretSources?: MachineRpcHandlerDeps['secretSources'];
  savedSecretOperationContext?: MachineRpcHandlerDeps['savedSecretOperationContext'];
  mcpServers?: MachineRpcHandlerDeps['mcpServers'];
  cliVersion: string;
  machineId: string;
  machine: Machine;
  credentials?: StoredCredentials;
  providerAccountSettings?: Pick<Parameters<typeof createProviderAccountSettingsController>[0],
    'scopeKey' | 'processEnv' | 'materializationBaseDir' | 'activeServerDir'>;
  requesterServerId?: string;
  resolveCurrentMachineExecutionOriginContext?: () => Promise<CurrentMachineExecutionOriginContext | null>;
  resolveRequesterSessionRuntimeContext?: ResolveRequesterSessionRuntimeContext;
  readRequesterSessionCredentialBindings?: () => Promise<RequesterSessionCredentialBindingsResult>;
  releaseRequesterSessionRuntimeContext?: (context: RequesterSessionRuntimeContext) => Promise<void>;
  dispatchSessionFollowOccurrence?: (request: import('@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher').SessionFollowOccurrenceDispatch) => Promise<import('@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher').SessionFollowReceiverRangeResult | import('@/daemon/sessions/sessionActivityChangedContract').SessionActivityChangedResult | void>;
  daemonSessionMutationCustody?: DaemonSessionMutationCustody;
  orphanedDeadDaemonSessions?: ReadonlyArray<OrphanedDeadDaemonSession>;
  isPublicationQuiescing?: () => boolean;
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
  startAutomationWorkerForMachine: (machineId: string) => AutomationWorkerHandle | null | Promise<AutomationWorkerHandle | null>;
  startMemoryWorkerForMachine: (machineId: string) => Promise<MemoryWorkerHandle | null>;
  /** The Machine's role set (P03-ROLES-POLICY); split roles activate and stop with it. Missing = every core role. */
  machineRoles?: Pick<MachineRolesRuntime, 'activeRoles' | 'subscribe'>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  spawnSessionForInternalResume: PendingSessionResumePort;
  onActivationRejected?: (event: PendingInactiveSessionActivationRejected) => Promise<void>;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  purgeBrowserStorageForSessionDeleted?: (sessionId: string) => Promise<void>;
  sessionRunnerStatus?: MachineRpcHandlerDeps['sessionRunnerStatus'];
  awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
  prestartSessionHost?: MachineRpcHandlerDeps['prestartSessionHost'];
  isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
  /** Orphan settlement leaves a Session the respawn owner holds to it. */
  isSessionRespawnPending?: (sessionId: string) => boolean;
  loadLocalSessionMetadataForHandoff: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  beforeShutdown: () => Promise<void>;
  requestShutdown: (source: DaemonShutdownSource, errorMessage?: string) => void;
  directPeerServerLifecycle: DirectTransferServerLifecycle | null;
  prepareWorkspaceSyncSeedExport?: NonNullable<import('@/api/machine/rpcHandlers.workspaceSync').MachineWorkspaceSyncRpcService['prepareSourceSeedExport']>;
  prepareWorkspaceSyncResolutionExport?: NonNullable<import('@/api/machine/rpcHandlers.workspaceSync').MachineWorkspaceSyncRpcService['prepareConflictResolutionExport']>;
  machineIrohRuntime?: DaemonMachineIrohRuntime;
  acquireLocalServicePreviewApplication?: import('../local/services/preview/routes').LocalServicePreviewRoutes['acquireNativeApplication'];
  resolveServiceExport?: import('../peer/mediation/tunnel/open').OpenPeerTcpTunnelInput['resolveServiceExport'];
  onServiceExportTunnelsReady?: import('../peer/mediation/tunnel/registerRoutes').RegisterPeerTcpTunnelLoopbackRoutesOptions['onServiceExportTunnelsReady'];
  resolveLocalServicePreviewApplication?: import('../local/services/preview/routes').LocalServicePreviewRoutes['resolveApplication'];
  prepareServerTransportForReconnect?: () => Promise<ReadinessProbeResult>;
  acquireWorkspaceSyncMachineIngress?: (
    input: import('@/workspaces/sync/workspaceSyncTargetAuthority').AcquireWorkspaceSyncMachineIngressRequest,
  ) => Promise<Readonly<{
    port: number;
    localCapability: string;
    close(): Promise<void>;
  }>>;
  directTransferRegistryHost: ReturnType<typeof createCliRegistryHostV1>;
  connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle | null;
  connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null;
  publicProfileRefreshHandle?: import('../lifecycle/singleFlightIntervalLoop').SingleFlightIntervalLoopHandle | null;
  daemonServerWorkScheduler: DaemonServerWorkScheduler;
  retryTemporaryThrottleNow?: (input: Readonly<{ sessionId: string }>) => Promise<unknown> | unknown;
  readTemporaryThrottleRecovery?: (sessionId: string) => Readonly<{ issueFingerprint: string; armedAtMs: number }> | null;
  cancelTemporaryThrottleRecovery?: (input: Readonly<{ sessionId: string; issueFingerprint?: string; armedAtMs?: number }>) => Promise<unknown> | unknown;
  cancelConnectedServiceRuntimeAuthRecovery?: (input: Readonly<{
    sessionId: string;
    attemptId: string;
  }>) => Promise<unknown> | unknown;
  checkRuntimeAuthUsageLimitRecovery?: import('@/session/usageLimitRecoveryControls/runtimeAuthUsageLimitRecoveryControl').CheckRuntimeAuthUsageLimitRecovery;
  wakeRuntimeAuthRecoveryPresentation?: (sessionId?: string) => void;
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
  resolveManagedPurposeBindingIntent?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['resolveManagedPurposeBindingIntent'];
  resolveManagedPurposeBindingIntentSelection?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['resolveManagedPurposeBindingIntentSelection'];
  openTeamDirect?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['openTeamDirect'];
  teamCredentialNativeSource?: import('@/providers/modelManagement/nativeProviderSource').TeamCredentialNativeSourceContext;
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
  readMaterializedStateObservationBinding?: MachineRpcHandlerDeps['readMaterializedStateObservationBinding'];
  resolveExecutionRunLiveBrokerAuthority?: MachineRpcHandlerDeps['resolveExecutionRunLiveBrokerAuthority'];
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
      roleActivations: null,
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

  // The Machine client owns persisted-endpoint withdrawal as well as write ordering.
  const connectedApiMachine = await timeWebLatencyPhase('machine.bootstrap.connectedClient',
    () => params.createConnectedApiMachine(params.machine));
  const workflowRecoveryTriggers = params.recoverWorkflowRuns
    ? createWorkflowRecoveryTriggers(params.recoverWorkflowRuns)
    : null;
  let automationWorker: AutomationWorkerHandle | null = null;
  let externalSessionPluginAdmissionOwner:
    ExternalSessionPluginAdmissionOwner | undefined;
  let externalSessionHostActionExecutor: RpcActionExecutor | undefined;
  let sessionSpawnDirectTargetTransport: SessionSpawnDirectTargetTransport | undefined;
  let providerOperationsProducer: RuntimeProviderOperationsProducer | null = null;
  let roleActivations: MachineRoleActivationRuntime | null = null;
  let voiceBinaryAppendConsumer: PeerTcpTunnelVoiceBinaryAppendConsumer | undefined;
  let voiceBinaryTerminalConsumer: PeerTcpTunnelVoiceBinaryTerminalConsumer | undefined;
  let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
  let machineConnectionStateCleanup: (() => void) | null = null;
  let providerAccountSettingsController: ReturnType<typeof createProviderAccountSettingsController> | null = null;
  const stopProviderAccountSettings = async () => {
    await providerAccountSettingsController?.stop();
    providerAccountSettingsController = null;
  };
  let peerMediationLoopback: StartedPeerMediationLoopback | null = null;
  let activeMachineIrohRuntime: DaemonMachineIrohRuntime | undefined;
  let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
  let stopMachineIrohAcceptor: () => Promise<void> = async () => {};
  let cleanupMachineLiveStreamRelay: (() => void) | null = null;
  let cleanupPeerTcpTunnelRelay: (() => void) | null = null;
  let resumeMachineConnectionPublications = async (): Promise<void> => {};
  let disposeInactiveSessionUsageLimitRecovery: (() => void) | null = null;
  const refreshPeerMediationEndpointPublication = async () => {
    // The Machine client owns publication quiescence. General admission drains
    // must not suppress the endpoint needed by already-admitted broker work.
    if (!connectedApiMachine) return 'suppressed' as const;
    try {
      return await runMachineReconnectPhase('endpoint-publication', () => connectedApiMachine!.updateDaemonState((state) => {
        // The canonical Machine drain owns ordering and conflict reconciliation.
        // Always read the live listener when this reducer actually runs.
        const loopback = peerMediationLoopback;
        const endpoint = loopback?.readEndpoint();
        return reconcileMachineIrohEndpoint(
          loopback && endpoint
            ? mergePeerMediationLoopbackEndpoint(state, endpoint, loopback.activeFlows)
            : removePeerMediationLoopbackEndpoint(state),
          activeMachineIrohRuntime,
        );
      }));
    } catch (error) {
      // The existing connect/resume wake re-reads the live owner, including a
      // failed withdrawal after its listener has stopped. No timed retry.
      logger.warn('[DAEMON RUN] Failed to reconcile peer mediation endpoints', error);
      return null;
    }
  };

  const getAttemptResources = (): MachineSyncRuntimeAttemptResources => ({
    apiMachine: connectedApiMachine,
    automationWorker,
    roleActivations,
    machineConnectionStateCleanup,
    stopProviderAccountSettings,
    stopPeerMediationLoopbackServer,
    stopMachineIrohAcceptor,
    cleanupMachineLiveStreamRelay,
    cleanupPeerTcpTunnelRelay,
    disposeInactiveSessionUsageLimitRecovery,
  });

  if (connectedApiMachine) {
    try {
      if (params.reconcileConnectedServicesProjection) {
        connectedApiMachine.onConnectedServicesProjection(params.reconcileConnectedServicesProjection);
      }
    } catch (error) {
      await retireMachineSyncRuntimeAttempt(getAttemptResources());
      throw error;
    }
  }

  try {
  if (connectedApiMachine && params.providerAccountSettings) {
    try {
      providerAccountSettingsController = createProviderAccountSettingsController({
        ...params.providerAccountSettings,
        apiMachine: connectedApiMachine,
        onError: error => logger.warn('[DAEMON RUN] Agent Account settings application failed', error),
      });
      void providerAccountSettingsController.refresh().catch(error => {
        logger.warn('[DAEMON RUN] Agent Account settings startup application failed', error);
      });
    } catch (error) {
      logger.warn('[DAEMON RUN] Agent Account settings startup is unavailable', error);
    }
  }
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
          input: DirectTransferExportPrepareRequest,
          filesystemScope?: PreparedFilesystemTransferScope,
          context?: RpcHandlerContext,
        ) => {
          if (input.t === 'plugin_ui_artifact_download_v1') {
            context?.signal?.throwIfAborted();
            const response = await readDaemonPluginUiArtifactBytes(input.request);
            context?.signal?.throwIfAborted();
            const body = JSON.stringify(response);
            const directory = createHappierTempDir({ purpose: 'plugin-ui-artifact-download' });
            const name = 'plugin-ui-artifact.json';
            const filePath = join(directory, name);
            const sizeBytes = Buffer.byteLength(body, 'utf8');
            try {
              await fs.writeFile(filePath, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
              context?.signal?.throwIfAborted();
              const payloadSource = createFileTransferPayloadSource({ filePath, sizeBytes, name,
                dispose: async () => { await removeHappierTempDirAsync(directory); } });
              const published = await directPeerServerLifecycle.publishTransferWhenReady({
                transferId: `plugin-ui-artifact:${randomUUID()}`, payloadSource,
              });
              if (context?.signal?.aborted) {
                directPeerServerLifecycle.clearPublishedTransfer(published.transferId);
                context.signal.throwIfAborted();
              }
              return { transferId: published.transferId, endpointCandidates: published.endpointCandidates,
                expiresAt: published.expiresAt, name, sizeBytes };
            } catch (error) {
              await removeHappierTempDirAsync(directory);
              throw error;
            }
          }
          if (input.t === 'prompt_asset_download_v1') {
            return await prepareFoundSkillExport({
              lifecycle: directPeerServerLifecycle,
              request: { path: input.path },
              ...(context ? { signal: context.signal } : {}),
            });
          }
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
            input.t === 'prompt_registry_download_v1'
              ? await resolveRegistryItemDownloadSource({
                    host: context?.machineAdmission
                      ? createCliRegistryHostV1({credentials:params.credentials,signal:context.signal,machineAdmission:context.machineAdmission})
                      : params.directTransferRegistryHost,
                    request: {
                      kind: input.kind,
                      sourceId: input.sourceId,
                      itemId: input.itemId,
                      version: input.version,
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
            throw Object.assign(new Error(resolvedSource.error), {
              ...('code' in resolvedSource ? { code: resolvedSource.code } : {}),
            });
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
            input.t === 'prompt_registry_download_v1'
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
          nextCheckAtMs: null,
          lastProbeError: 'usage_limit_recovery_runner_unavailable',
        };
      }
      const result = await inactiveUsageLimitRecoveryCheckOwner.run(context.sessionId);
      return resolveInactiveUsageLimitRecoverySchedulerResult({
        result,
      });
    },
  });
  disposeInactiveSessionUsageLimitRecovery = () => inactiveUsageLimitRecoveryScheduler.dispose();
  inactiveUsageLimitRecoveryScheduler.hydratePassive();

  if (connectedApiMachine) {
    if (storedCredentials) {
      machineConnectionStateCleanup = await timeWebLatencyPhase('machine.bootstrap.sessionRemoval', () => subscribeManagedSessionDirectoryRemoval({
        directories: createManagedSessionDirectories(),
        token: storedCredentials.token,
        stopSession: params.stopSession,
        purgeBrowserStorageForSessionDeleted: params.purgeBrowserStorageForSessionDeleted,
        onSessionDeletedChange: (listener) => connectedApiMachine.onSessionDeletedChange(listener),
        onSessionAccessReset: (listener) => connectedApiMachine.onSessionAccessReset(listener),
        requesterCustody: {
          happyHomeDir: configuration.happyHomeDir,
          serverId: params.requesterServerId ?? configuration.activeServerId,
        },
      }));
    }
    automationWorker = await timeWebLatencyPhase('machine.bootstrap.automation',
      () => params.startAutomationWorkerForMachine(params.machineId));
    const activeAutomationWorker = automationWorker;
    // Role activation is the code-loading boundary: each active split role's entry loads by
    // import() here, before the changes carrier connects and before core RPC registration.
    // The role set's owner (P03-ROLES-POLICY) reconciles the same runtime on metadata changes.
    const machineConnectionRoleContext = {
        machineId: params.machineId,
        accountId: normalizeNonEmptyString(params.peerMediationMachineRpc?.accountId)
          ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null),
        startMemoryWorkerForMachine: params.startMemoryWorkerForMachine,
        startVoiceInferenceWorkerForMachine: params.startVoiceInferenceWorkerForMachine,
        memorySessionEvents: {
          onSessionChanged: (listener) => connectedApiMachine.onSessionChanged(listener),
          onSessionTranscriptRevised: (listener) => connectedApiMachine.onSessionTranscriptRevised(listener),
          onSessionDeletedChange: (listener) => connectedApiMachine.onSessionDeletedChange(listener),
          onSessionAccessRevoked: (listener) => connectedApiMachine.onSessionAccessRevoked(listener),
          onSessionAccessReset: (listener) => connectedApiMachine.onSessionAccessReset(listener),
          onSessionArchivedStateChange: (listener) =>
            connectedApiMachine.onSessionArchivedStateChange(listener),
        },
    } satisfies MachineRoleContexts['memory'] & MachineRoleContexts['voice'];
    const roleRuntime = createMachineRoleActivationRuntime({
      rpcHandlerManager: connectedApiMachine.getMachineRoleRpcHandlerManager(),
      ...(params.machineRoles ? { roles: params.machineRoles } : {}),
      // Roles bound to this Machine connection; `sessions` is provided once the RPC composition below exists; `devices` follows the daemon (session control runtime).
      contexts: { memory: machineConnectionRoleContext, voice: machineConnectionRoleContext },
    });
    roleActivations = roleRuntime;
    await roleRuntime.start(connectedApiMachine.getMachineMetadataSnapshot());
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
    const providerLocalToolContext = {
      ...createDaemonSpawnToolResolutionContext({ processEnv: process.env }),
      runSystemTool: ({ signal, ...request }: Parameters<ProviderLocalCommandRunner['runSystemTool']>[0]) =>
        createDaemonSpawnToolResolutionContext({ processEnv: process.env, signal }).runSystemTool(request),
    };
    const resolveSharedGateway = createMachineSharedProviderGatewayResolver({
      machineId: params.machineId,
      readAccountId: () => normalizeNonEmptyString(params.peerMediationMachineRpc?.accountId)
        ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null),
      readOrigin: async () => await params.resolveCurrentMachineExecutionOriginContext?.() ?? null,
    });
    let providerRuntimeServices!: ReturnType<typeof createRuntimeProviderModelManagementServices>;
    let providerLocalInstallationReader!: ReturnType<typeof createProviderLocalInstallationReader>;
    const createConnectionRuntimeServices = (accountContext?: RuntimeProviderAccountModelProjectionContext) => {
      const credentials = accountContext ? accountContext.savedSecretOperationContext?.credentials : params.credentials;
      if (!credentials) return null;
      return createRuntimeProviderConnectionServices({
          machineId: params.machineId,
          credentials,
          ...(accountContext?.savedSecretOperationContext ? { operationContext: accountContext.savedSecretOperationContext } : {}),
          happyHomeDir: configuration.happyHomeDir,
          featureGate: providerFeatureGate,
          ...(accountContext ? accountContext.managedRuntimeAccount
            ? { resolveSharedGateway: accountContext.managedRuntimeAccount.resolveSharedGateway } : {} : { resolveSharedGateway }),
          runtimeSummary: (input) => providerRuntimeServices.summary(input,
            accountContext ? createProviderAccountOperationScope(accountContext) : undefined),
          refreshOnEnable: (input) => providerRuntimeServices.probe(input),
          ...(accountContext ? { resolveManagedPurposeBindingIntent: accountContext.resolveManagedPurposeBindingIntent } : params.resolveManagedPurposeBindingIntent
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
        });
    };
    const providerConnectionRuntimeServices = createConnectionRuntimeServices();
    const providerConnectionUnavailable = async (request: Readonly<{ connectionId?: string; machineId: string }>) => ({
      status: 'error' as const,
      error: createProviderErrorV1('provider_feature_disabled', {
        ...(request.connectionId ? { connectionId: request.connectionId } : {}),
        machineId: request.machineId,
      }),
    });
    const readProviderHomeServerUrl = captureServerHttpBaseUrl();
    const readProviderModelProjection: ProviderRuntimeModelProjectionReader | undefined = storedCredentials
      ? (request, signal) => {
          const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
          return createAccountScopedProviderModelProjectionReader({
            serverUrl: readProviderHomeServerUrl(),
            readCredentials: async () => storedCredentials,
            readAccountSettingsSnapshot: async () => getActiveAccountSettingsSnapshot(),
            isCurrent: () => !params.isShuttingDown()
              && getActiveAccountSettingsSnapshotLifetimeToken() === lifetimeToken
              && getActiveAccountSettingsSnapshot()?.scopeKey === resolveAccountSettingsScopeKey(storedCredentials),
          })(request, signal);
        }
      : undefined;
    providerRuntimeServices = createRuntimeProviderModelManagementServices({
      secretSources: params.secretSources,
      machineId: params.machineId,
      happyHomeDir: configuration.happyHomeDir,
      featureGate: providerFeatureGate,
      ...(params.createAgentCatalogObservation ? { observeConnectedAccountSourceModels: request =>
        agentCatalogObservation!.observe(request) } : {}),
      ...(connectedApiMachine ? { invokeConnectedAccountNativeModels: (request, signal) =>
        // The custodian observes its own explicit source. Requester RPC admission
        // remains at ingress; it cannot lend custody to this host-owned read.
        machineRpcLifecycleRegistration.hostCapabilities.invoke(request, { signal }) } : {}),
      resolveSharedGateway,
      ...(params.resolveManagedPurposeBindingIntentSelection
        ? { resolveManagedPurposeBindingIntentSelection: params.resolveManagedPurposeBindingIntentSelection }
        : {}),
      ...(readProviderModelProjection ? { readModelProjection: readProviderModelProjection } : {}),
      modelSettingsMutation: providerConnectionRuntimeServices?.service.mutateModelSettings
        ?? providerConnectionUnavailable,
      localCatalogFallback: createProviderLocalCatalogFallbackRunner({
        runner: { runSystemTool: ({ signal, ...request }) => createDaemonSpawnToolResolutionContext({
          processEnv: process.env, signal,
        }).runSystemTool(request) },
      }),
      ...(params.resolveManagedPurposeBindingIntent
        ? {
            resolveManagedPurposeBindingIntent:
              params.resolveManagedPurposeBindingIntent,
          }
        : {}),
      ...(params.openTeamDirect ? { openTeamDirect: params.openTeamDirect } : {}),
      ...(params.teamCredentialNativeSource ? { teamCredentialNativeSource: params.teamCredentialNativeSource } : {}),
    });
    providerLocalInstallationReader = createProviderLocalInstallationReader({
      ...providerLocalToolContext,
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
      readForAccount: async (request, context) => {
        if (request.actionId === 'providers.models.list' || request.actionId === 'providers.models.refresh') {
          return await providerRuntimeServices.models({ ...request.input, machineId: params.machineId }, context.signal,
            { ...createProviderAccountOperationScope(context), ...(request.actionId === 'providers.models.refresh' ? { forceRefresh: true } : {}) });
        }
        const services = createConnectionRuntimeServices(context);
        // Account-scoped operands may omit machineId; this daemon answers for its own Machine, as models does above.
        return services ? await services.describeConnections({ ...request.input, machineId: request.input.machineId ?? params.machineId }, context.signal)
          : { status: 'error', error: createProviderErrorV1('provider_authorization_changed', { machineId: params.machineId }) };
      },
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
        memory: roleRuntime.memoryExternalObservation,
        daemonServerWorkScheduler: params.daemonServerWorkScheduler,
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
              preparedMachineTransfer: { request: directPeerServerLifecycle.requestPreparedTransfer },
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
        secretSources: params.secretSources,
        savedSecretOperationContext: params.savedSecretOperationContext,
        createRegistryHost:(signal,context)=>createCliRegistryHostV1({credentials:params.credentials,signal,
          secretSources:params.secretSources,operationContext:params.savedSecretOperationContext,machineAdmission:context?.machineAdmission}),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
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
        readMaterializedStateObservationBinding:
          params.readMaterializedStateObservationBinding,
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
        ...(params.resolveExecutionRunLiveBrokerAuthority
          ? { resolveExecutionRunLiveBrokerAuthority: params.resolveExecutionRunLiveBrokerAuthority }
          : {}),
        ...(params.externalActionIngressOwner
          ? { externalActionIngressOwner: params.externalActionIngressOwner }
          : {}),
        ...(params.awaitAgentSessionOpen
          ? { awaitAgentSessionOpen: params.awaitAgentSessionOpen }
          : {}),
        ...(params.prestartSessionHost ? { prestartSessionHost: params.prestartSessionHost } : {}),
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
        resumeInactiveSessionWhenUsageLimitReady: async ({ sessionId, rawSession, metadata, readiness }) =>
          storedCredentials ? await activateInactiveUsageLimitResume({
            credentials: storedCredentials,
            sessionId,
            rawSession,
            metadata,
            readiness,
            customResumePrompt: getActiveAccountSettingsSnapshot()?.settings.usageLimitRecoverySettingsV1?.customResumePrompt ?? null,
          }) : false,
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
        ...(params.checkRuntimeAuthUsageLimitRecovery
          ? { checkRuntimeAuthUsageLimitRecovery: params.checkRuntimeAuthUsageLimitRecovery }
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
    // The `sessions` role registers the new-Session family composed above (inactive: never
    // registered, so those methods answer machine_role_inactive). The Machine client always
    // composes it; Machine-client fakes without an RPC composition leave the role with nothing to register.
    const sessionsRoleFamily = machineRpcLifecycleRegistration.sessionsRoleFamily;
    if (sessionsRoleFamily) await roleRuntime.provide('sessions', { family: sessionsRoleFamily });
    sessionSpawnDirectTargetTransport = roleRuntime.get('sessions')?.sessionSpawnDirectTargetTransport;
    // Stable consumers follow live voice role toggles; they refuse typed while voice is off.
    voiceBinaryAppendConsumer = roleRuntime.voiceBinaryConsumers.append;
    voiceBinaryTerminalConsumer = roleRuntime.voiceBinaryConsumers.terminal;

    // PMS-9 (finding #49) + PMS-WIRE: supply ONE observability emitter to the DIRECT loopback routes
    // AND both relay terminators. In production startup hands in the shared emitter
    // (`params.peerMediationMachineRpc.observability`) whose store is also published onto the Api
    // provider bridge for the read-path executor, so the write-path and read-path bind to the SAME
    // store. Narrow callers without that shared runtime do not collect into an unread fallback.
    const peerMediationObservabilityEmitter = params.peerMediationMachineRpc?.observability;

    peerMediationLoopback = await timeWebLatencyPhase('machine.bootstrap.peerLoopback', () => maybeStartPeerMediationLoopback({
      config: params.peerMediationMachineRpc,
      observability: peerMediationObservabilityEmitter,
      connectedApiMachine,
      credentials: params.credentials,
      machine: params.machine,
      machineId: params.machineId,
      ...(params.machineIrohRuntime ? { machineIrohRuntime: params.machineIrohRuntime } : {}),
      directPeerServerLifecycle: params.directPeerServerLifecycle,
      ...(params.acquireLocalServicePreviewApplication ? { acquireLocalServicePreviewApplication: params.acquireLocalServicePreviewApplication } : {}),
      ...(params.resolveServiceExport ? { resolveServiceExport: params.resolveServiceExport } : {}),
      ...(params.onServiceExportTunnelsReady ? { onServiceExportTunnelsReady: params.onServiceExportTunnelsReady } : {}),
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
    })).catch((error) => {
      logger.warn('[DAEMON RUN] Failed to start peer mediation loopback route', error);
      return null;
    });
    if (peerMediationLoopback) {
      const startedPeerMediationLoopback = peerMediationLoopback;
      const unsubscribeEndpointChanges = startedPeerMediationLoopback.subscribeEndpointChanges(() => {
        void refreshPeerMediationEndpointPublication();
      });
      const hasNativePreviewApplication = Boolean(
        params.acquireLocalServicePreviewApplication && peerMediationLoopback.activeFlows.tcp_tunnel,
      );
      stopPeerMediationLoopbackServer = async () => {
        if (peerMediationLoopback !== startedPeerMediationLoopback) return;
        peerMediationLoopback = null;
        unsubscribeEndpointChanges();
        if (hasNativePreviewApplication) {
          await connectedApiMachine.setLocalServicePreviewNativeAccessLive(false).catch((error) => {
            logger.warn('[DAEMON RUN] Failed to withdraw native preview capability', error);
          });
        }
        try {
          await startedPeerMediationLoopback.stop();
        } finally {
          // The Machine drain orders this withdrawal after any older write;
          // pending live-owner reducers already see the retired listener.
          await connectedApiMachine.updateDaemonState(removePeerMediationLoopbackEndpoint, {
            allowWhileQuiescing: true,
          }).catch((error) => {
            logger.warn('[DAEMON RUN] Failed to withdraw peer mediation loopback endpoint', error);
          });
        }
      };
      if (params.machineIrohRuntime) {
        const admissionPort = Number(new URL(peerMediationLoopback.endpoint.url).port);
        try {
          await timeWebLatencyPhase('machine.bootstrap.irohAcceptor',
            () => params.machineIrohRuntime!.startAttemptAcceptor({ admissionPort }));
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
          await timeWebLatencyPhase('machine.bootstrap.nativePreview',
            () => connectedApiMachine.setLocalServicePreviewNativeAccessLive(true)).catch((error) => {
            logger.warn('[DAEMON RUN] Failed to publish native preview capability', error);
          });
        }
      }
    }

    const peerTcpTunnelRelayContext = await timeWebLatencyPhase('machine.bootstrap.peerRelay', () => resolvePeerTcpTunnelRelayBootstrapContext({
      config: params.peerMediationMachineRpc,
      credentials: params.credentials,
    })).catch((error) => {
      logger.warn('[DAEMON RUN] Failed to resolve peer TCP tunnel relay context', error);
      return null;
    });
    if (peerTcpTunnelRelayContext) {
      const nowMs = params.peerMediationMachineRpc?.nowMs ?? (() => Date.now());
      const relayRuntime = registerMachinePeerTcpTunnelRelayRuntime({
          accountId: peerTcpTunnelRelayContext.accountId,
          machineId: params.machineId,
          serverFeatures: peerTcpTunnelRelayContext.serverFeatures,
          resolvePreviewApplication: params.resolveLocalServicePreviewApplication,
          nowMs,
          eventPort: {
            subscribe: (listener) => connectedApiMachine.onPeerTcpTunnelRelayEnvelope(listener),
            emit: (payload) => connectedApiMachine.sendPeerTcpTunnelRelayEnvelope(payload),
          },
          observability: peerMediationObservabilityEmitter,
          // The role runtime always supplies stable voice consumers; they refuse typed while voice is off.
          voiceBinaryAppendConsumer, voiceBinaryTerminalConsumer,
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
        accountId: normalizeNonEmptyString(params.peerMediationMachineRpc?.accountId)
          ?? (params.credentials ? readAccountIdFromToken(params.credentials.token) : null),
        sourceMachineInstallationId: readInstallationIdentityIfExistsSync()?.installationId,
        resolveRelayAuthorizationTrustRoots: params.resolvePeerMediationTrustRoots,
        captureAdapter: liveStreamCaptureAdapter,
        nowMs: params.peerMediationMachineRpc?.nowMs ?? (() => Date.now()),
        emitEnvelope: (payload) => connectedApiMachine.sendMachineLiveStreamRelayEnvelope(payload),
        getFramePayloadByteLimit: (envelope, maxFrameBytes) => connectedApiMachine.getMachineLiveStreamFramePayloadByteLimit(envelope, maxFrameBytes),
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
        start: (startRequest, callerAuthority, content) => liveStreamRelayTerminator.start(startRequest, callerAuthority, content),
        getContentCodec: streamId => liveStreamRelayTerminator.getContentCodec(streamId),
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
      const stopProjectRowsRefresh = connectedApiMachine.onAccountProjectRowsChanged(async ({ signal, keys }) => {
        await readProjectAccountRows({ credentials, signal, publication: 'installed', changedKeys: keys });
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

    let recoverPendingSessionActivationsAfterConnect = async (_retryAfterEndpointPublication?: Promise<boolean>): Promise<void> => {};
    if (storedCredentials) {
      const credentials = storedCredentials;
      const followMachine = connectedApiMachine;
      const readFollowHomeServerUrl = captureServerHttpBaseUrl();
      const followHome = { serverId: params.requesterServerId ?? configuration.activeServerId,
        get serverUrl() { return readFollowHomeServerUrl(); } };
      const followAccountId = readAccountIdFromToken(credentials.token);
      const followLifetime = new AbortController();
      const reconcileManagerNoticeAtHome = async (sessionId: string, context?: RequesterSessionRuntimeContext): Promise<void> => {
        const home = context?.bootstrap.serverHttpBaseUrl ?? followHome.serverUrl;
        await runWithServerHttpBaseUrl(home, () => reconcileSessionManagerNotice({
          credentials: context?.bootstrap.credentials ?? credentials, sessionId, machineId: params.machineId,
          signal: followLifetime.signal,
          machineAdmissionTransport: (request, options) => followMachine.enqueueSessionPendingByMachine(request, options),
        })).catch(error => logger.warn('[DAEMON RUN] Manager notice remains unconfirmed', {
          sessionId, error: serializeAxiosErrorForLog(error),
        }));
      };
      const reconcileFollowReceiverAtHome = async (sessionId: string, context?: RequesterSessionRuntimeContext, sourceSessionId?: string): Promise<void> => {
        // The Account daemon owns resource material even when a restricted
        // native host is alive. Shared receiver admission chooses next-turn;
        // process presence is not a second source or delivery policy.
        const isCurrent = async () => !followLifetime.signal.aborted && !params.isShuttingDown()
          && (!context || await context.isCurrent());
        if (!await isCurrent()) return;
        context?.bindSessionFollowSourceReconciliation(async source => {
          if (await isCurrent()) await reconcileFollowReceiverAtHome(sessionId, context, source ?? undefined);
        }, followLifetime.signal);
        if (context && sourceSessionId) {
          // Requester source hints use their retained Account's same rule
          // predicate owner. Their own destination/reconnect recovery stays broad.
          const selected = await params.dispatchSessionFollowOccurrence?.({ sourceSessionIdChanged: sourceSessionId,
            contextSessionId: sessionId });
          if (!selected || !('receiverSessionIds' in selected) || !selected.receiverSessionIds.includes(sessionId)
            || !await isCurrent()) return;
        }
        if (sourceSessionId) {
          // Private-rule discovery already named this source and receiver.
          // The range owner refreshes its rules and proves each original's
          // admission; a receiver-wide observation cannot add source authority.
          await params.dispatchSessionFollowOccurrence?.({ destinationSessionId: sessionId,
            sourceSessionId, observations: [] });
          return;
        }
        await reconcileManagerNoticeAtHome(sessionId, context);
        const installation = readInstallationIdentityIfExistsSync();
        if (!installation) return;
        const credentials = context?.bootstrap.credentials ?? storedCredentials;
        const home = context ? { serverId: context.bootstrap.attribution.serverId, serverUrl: context.bootstrap.serverHttpBaseUrl } : followHome;
        const resolveOrigin = context
          ? createCurrentMachineExecutionOriginContextResolver({ serverUrl: home.serverUrl, resolveCurrentMachineId: () => params.machineId })
          : params.resolveCurrentMachineExecutionOriginContext;
        const spawnSession: typeof params.spawnSession = context
          ? options => params.spawnSessionForInternalResume({ ...options, requesterSessionBootstrap: context.bootstrap, requesterSessionRuntimeContext: context })
          : params.spawnSessionForInternalResume;
        await runWithServerHttpBaseUrl(home.serverUrl, async () => {
            const readObservations = async () => {
              const origin = await resolveOrigin?.(followLifetime.signal);
              if (!origin || origin.machineId !== params.machineId || !await isCurrent()) return null;
              const observed = await fetchInactiveSessionFollowObservations({ token: credentials.token, destinationSessionId: sessionId,
                machineId: params.machineId, installationId: installation.installationId, reason: 'receiver-recovery', signal: followLifetime.signal });
              if (observed && 'failure' in observed) {
                logger.warn('[DAEMON RUN] Follow observation unavailable; waiting for the next receiver hint or reconnect', {
                  sessionId, failure: observed.failure, diagnostic: observed.diagnostic,
                });
              }
              if (!observed?.ok || observed.target.homeId !== origin.serverIdentityId
                || observed.target.accountId !== readAccountIdFromToken(credentials.token)
                || observed.target.sessionId !== sessionId || observed.target.machineId !== params.machineId
                || observed.target.installationId !== installation.installationId || !await isCurrent()) return null;
              return observed;
            };
            const observed = await readObservations();
            if (!observed) return;
            const session = {
              sessionId, getServerBinding: () => home, getServerFeaturesSnapshot: () => params.getServerFeaturesSnapshot?.(),
              getMachineAdmissionTransport: () => (request, options) => followMachine.enqueueSessionPendingByMachine(request, options),
              runSessionFollowSourceRequest: <T>({ credentials: requested, request }: Readonly<{
                credentials: Pick<StoredCredentials, 'token'>; request: () => T;
              }>): T => {
                if (requested.token !== credentials.token) throw new Error('Follow credentials do not belong to the observed Home');
                return runWithServerHttpBaseUrl(home.serverUrl, request);
              },
            } satisfies Parameters<typeof createDiscussionFollowInputIntake>[0]['session'];
            const intake = createDiscussionFollowInputIntake({ credentials, spawnSession, session });
            for (const observation of observed.observations) {
              if ('source' in observation && await isCurrent()) {
                await intake({ observation, signal: followLifetime.signal });
              }
            }
            const sessionObservations = observed.observations.filter((observation): observation is SessionFollowSessionPendingObservationV1 =>
              'sourceSessionId' in observation && !('kind' in observation)
              && (sourceSessionId === undefined || observation.sourceSessionId === sourceSessionId));
            await params.dispatchSessionFollowOccurrence?.({ destinationSessionId: sessionId, observations: sessionObservations,
              ...(sourceSessionId ? { sourceSessionId } : {}) });
          });
      };
      const reconcileFollowReceiver = async (sessionId: string, sourceSessionId?: string): Promise<void> => {
        const discovery = await params.readRequesterSessionCredentialBindings?.();
        if (discovery && discovery.status !== 'ready') return;
        const binding = discovery?.bindings.find(binding => binding.sessionId === sessionId);
        if (!binding) return reconcileFollowReceiverAtHome(sessionId, undefined, sourceSessionId);
        // A known requester never falls back to the Machine custodian's Account.
        if (binding.attribution.machineId !== params.machineId || !params.resolveRequesterSessionRuntimeContext
          || !params.releaseRequesterSessionRuntimeContext) return;
        const context = await params.resolveRequesterSessionRuntimeContext(sessionId, binding.attribution);
        if (!context) return;
        try { await reconcileFollowReceiverAtHome(sessionId, context, sourceSessionId); }
        finally { await params.releaseRequesterSessionRuntimeContext(context); }
      };
      const recoverFollowReceivers = async (context?: RequesterSessionRuntimeContext, receivers?: ReadonlySet<string>): Promise<void> => {
        const installation = readInstallationIdentityIfExistsSync();
        if (!installation || followLifetime.signal.aborted || params.isShuttingDown()
          || context && !await context.isCurrent()) return;
        const serverUrl = context?.bootstrap.serverHttpBaseUrl ?? followHome.serverUrl;
        await runWithServerHttpBaseUrl(serverUrl, () => recoverPendingFollowReceivers({
          token: (context?.bootstrap.credentials ?? credentials).token, machineId: params.machineId,
          installationId: installation.installationId, signal: followLifetime.signal,
          reconcileReceiver: async sessionId => {
            if (!receivers || receivers.has(sessionId)) await reconcileFollowReceiver(sessionId);
          },
        }));
      };
      // The same exact-Session feed callback and reconnect visitor own absent
      // receiver discovery. Pending acceptance, not launch, ACKs Discussion C1.
      const stopFollowSessionChanges = connectedApiMachine.onSessionChanged(async change => {
        if (!params.isShuttingDown() && !change.removed && change.followReceiverAvailabilityChanged === true) {
          params.wakeRuntimeAuthRecoveryPresentation?.(change.sessionId);
        }
        if (change.removed || change.followSourceChanged === false && change.followReceiverAvailabilityChanged === false) return;
        // A new rule has no ordinary edge to invalidate its destination. Read
        // receiver identities from the installed Account's existing cache;
        // every destination still proves its exact Home/Machine admission.
        const rules = await params.dispatchSessionFollowOccurrence?.({ sourceSessionIdChanged: change.sessionId,
          ...(change.followSourceChanged === false ? { followSourceChanged: false } : {}),
          ...(change.followReceiverAvailabilityChanged === undefined ? {} : {
            followReceiverAvailabilityChanged: change.followReceiverAvailabilityChanged }) });
        const receivers = [...new Set(rules && 'receiverSessionIds' in rules ? rules.receiverSessionIds : [])];
        const results = await Promise.allSettled(receivers.map(sessionId => reconcileFollowReceiver(sessionId,
          sessionId === change.sessionId ? undefined : change.sessionId)));
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
      });
      const stopFollowAccountChanges = connectedApiMachine.onSessionFollowRulesChanged(async change => {
        if (!change || followLifetime.signal.aborted) return;
        // Follow's producer publishes exact receiver demand independently of
        // generic Session/Pending/metadata writes on the same Account feed.
        for (const sessionId of change.receiverSessionIds ?? []) await reconcileFollowReceiver(sessionId);
        if (change.full || change.workflowRunIds.length || change.discussionIds?.length) {
          await params.dispatchSessionFollowOccurrence?.({ accountFollowSourcesChanged: change.full ? { configurationChanged: true } : {
            workflowRunIds: change.workflowRunIds, discussionIds: change.discussionIds } });
        }
      });
      const priorFollowLifetimeCleanup = machineConnectionStateCleanup;
      machineConnectionStateCleanup = () => {
        followLifetime.abort();
        stopFollowSessionChanges();
        stopFollowAccountChanges();
        priorFollowLifetimeCleanup?.();
      };
      const activateRequesterSession = async (
        binding: Pick<RequesterSessionCredentialBinding, 'sessionId' | 'attribution'>,
        hint?: PendingSessionActivationInput,
        retryAfterEndpointPublication?: Promise<boolean>,
      ): Promise<void> => {
        if (!params.resolveRequesterSessionRuntimeContext || !params.releaseRequesterSessionRuntimeContext
          || !params.resolveCurrentMachineExecutionOriginContext
          || binding.attribution.machineId !== params.machineId) return;
        await activateRequesterPendingSession({ ...params, binding, hint, retryAfterEndpointPublication,
          resolveRequesterSessionRuntimeContext: params.resolveRequesterSessionRuntimeContext,
          releaseRequesterSessionRuntimeContext: params.releaseRequesterSessionRuntimeContext,
          resolveCurrentMachineExecutionOriginContext: params.resolveCurrentMachineExecutionOriginContext });
      };
      const activatePendingSession = async (hint: PendingSessionActivationInput, retryAfterEndpointPublication?: Promise<boolean>): Promise<void> => {
        if (hint.target) {
          const origin = await params.resolveCurrentMachineExecutionOriginContext?.();
          if (!params.requesterServerId || origin?.serverIdentityId !== hint.target.homeId
            || origin.machineId !== hint.target.machineId) return;
          await activateRequesterSession({ sessionId: hint.target.sessionId, attribution: {
            serverId: params.requesterServerId, accountId: hint.target.accountId,
            machineId: hint.target.machineId, installationId: hint.target.installationId,
          } }, hint, retryAfterEndpointPublication);
          return;
        }
        const result = await activatePendingInactiveSession({
          credentials,
          machineId: params.machineId,
          sessionId: hint.sessionId,
          requestId: hint.requestId,
          pendingVersion: hint.pendingVersion,
          retryAfterEndpointPublication,
          spawnSessionForInternalResume: params.spawnSessionForInternalResume,
          onActivationRejected: params.onActivationRejected,
        });
        if (result.status === 'rejected') {
          logger.warn('[DAEMON RUN] Exact inactive Pending activation was rejected; Pending custody retained', {
            sessionId: hint.sessionId,
            requestId: hint.requestId,
            source: hint.source,
            reason: result.reason,
            failureDetails: result.failureDetails,
          });
        }
      };
      const pendingSessionActivationRecovery = createPendingSessionActivationRecovery({
        token: credentials.token,
        activate: activatePendingSession,
        visitOwnedSessions: async sessions => {
          if (sessions.length) {
            try {
              const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({ credentials,
                token: credentials.token, signal: followLifetime.signal });
              await Promise.all(sessions.map(rawSession => reconcileSessionManagerNotice({ credentials,
                sessionId: rawSession.id, observation: { rawSession, accountEncryptionCurrentness },
                machineId: params.machineId, signal: followLifetime.signal,
                machineAdmissionTransport: (request, options) => followMachine.enqueueSessionPendingByMachine(request, options),
              }).catch(error => logger.warn('[DAEMON RUN] Reconnect manager notice remains unconfirmed', {
                sessionId: rawSession.id, error: serializeAxiosErrorForLog(error),
              }))));
            } catch (error) {
              logger.warn('[DAEMON RUN] Reconnect manager observation unavailable', serializeAxiosErrorForLog(error));
            }
          }
          await recoverFollowReceivers();
          await inactiveUsageLimitRecoveryCheckOwner.restoreSessions({
            sessions,
            credentials,
            machineId: params.machineId,
            currentMachineHost: params.preferredHost ?? os.hostname(),
            currentMachineHomeDir: os.homedir(),
            scheduler: inactiveUsageLimitRecoveryScheduler,
            getServerFeaturesSnapshot: () => params.getServerFeaturesSnapshot?.(),
            isCurrent: () => !params.isShuttingDown(),
            runCheckNow: machineRpcLifecycleRegistration.probeInactiveUsageLimitRecovery,
          }).catch(error => logger.warn('[DAEMON RUN] Usage-limit reconnect recovery remains pending', error));
        },
        visitOwnedSession: async (sessionId, session) => {
          if ((session.pendingCount ?? 0) > 0) await inactiveUsageLimitRecoveryScheduler.reconcilePendingResetStarts(sessionId)
            .catch(error => logger.warn('[DAEMON RUN] Pending reset reconnect demand remains held', error));
        },
        warn: (message, input, error) => logger.warn(`[DAEMON RUN] ${message}`, { input, error }),
        recoverRequesterSessions: async retryAfterEndpointPublication => {
          const discovery = await params.readRequesterSessionCredentialBindings?.();
          if (!discovery) return;
          if (discovery.status !== 'ready') {
            logger.warn('[DAEMON RUN] Requester pending recovery unavailable; protected custody retained', { reason: discovery.reason });
            return;
          }
          // Retained requester references select credential custody, not Follow
          // demand. Read each requester's Account/Home work set once as well.
          const groups = new Map<string, Array<Extract<RequesterSessionCredentialBindingsResult, { status: 'ready' }>['bindings'][number]>>();
          for (const binding of discovery.bindings) {
            // The owned Account read already covers these retained references.
            if (binding.attribution.serverId === followHome.serverId
              && binding.attribution.accountId === followAccountId) continue;
            const key = JSON.stringify([binding.attribution.serverId, binding.attribution.accountId]);
            const group = groups.get(key);
            if (group) group.push(binding);
            else groups.set(key, [binding]);
          }
          const followRecovery = Promise.all([...groups.values()].map(async bindings => {
            if (!params.resolveRequesterSessionRuntimeContext || !params.releaseRequesterSessionRuntimeContext) return;
            for (const binding of bindings) {
              if (binding.attribution.machineId !== params.machineId) continue;
              const context = await params.resolveRequesterSessionRuntimeContext(binding.sessionId, binding.attribution);
              if (!context) continue;
              try { await recoverFollowReceivers(context, new Set(bindings.map(binding => binding.sessionId))); }
              finally { await params.releaseRequesterSessionRuntimeContext(context); }
              return;
            }
          })).catch(error => logger.warn('[DAEMON RUN] Requester Follow recovery remains pending', serializeAxiosErrorForLog(error)));
          const pendingRecovery = Promise.all(discovery.bindings.map(async binding => {
            if (binding.attribution.machineId === params.machineId && params.resolveRequesterSessionRuntimeContext
              && params.releaseRequesterSessionRuntimeContext) {
              const context = await params.resolveRequesterSessionRuntimeContext(binding.sessionId, binding.attribution);
              if (context) {
                try { await reconcileManagerNoticeAtHome(binding.sessionId, context); }
                finally { await params.releaseRequesterSessionRuntimeContext(context); }
              }
            }
            await connectedApiMachine.requestSessionMessageReplyRecoveryForSession(binding.sessionId, { retryFailedPublications: true })
              .catch(error => logger.warn('[DAEMON RUN] Requester reply recovery remains in original custody', error));
            await inactiveUsageLimitRecoveryScheduler.reconcilePendingResetStarts(binding.sessionId)
              .catch(error => logger.warn('[DAEMON RUN] Requester Pending reset demand remains held', error));
            await activateRequesterSession(binding, undefined, retryAfterEndpointPublication).catch(error => logger.warn('[DAEMON RUN] Requester pending recovery item failed; custody retained', {
              sessionId: binding.sessionId, error: serializeAxiosErrorForLog(error),
            }));
          }));
          await Promise.all([followRecovery, pendingRecovery]);
        },
      });
      connectedApiMachine.onPendingSessionActivationHint(
        pendingSessionActivationRecovery.activateHint,
      );
      recoverPendingSessionActivationsAfterConnect =
        pendingSessionActivationRecovery.recoverAfterConnect;
    }

    connectedApiMachine.onAutomationWorkInvalidated(async () => {
      if (!params.isShuttingDown()) await activeAutomationWorker?.catchUp();
    });
    const cleanupHeartbeatReceipts = connectedApiMachine.onHealthCheckHeartbeatReceived(payload => {
      publishDaemonHostEvent({
        eventId: HAPPIER_HEALTH_CHECK_HEARTBEAT_RECEIVED_HOST_EVENT_ID_V1,
        scope: { kind: 'account' },
        payload,
      }, params.isShuttingDown);
    });
    const priorHeartbeatLifetimeCleanup = machineConnectionStateCleanup;
    const mcpCatalogScopeKey = storedCredentials ? resolveAccountSettingsScopeKey(storedCredentials) : undefined;
    const cleanupMcpCatalog = subscribeActiveAccountSettingsKeys({ facets: ['mcpServerCatalog'] }, (previous, next) => {
      if (!mcpCatalogScopeKey || next?.scopeKey !== mcpCatalogScopeKey) return;
      const event = projectAccountEntitiesInvalidationForHost({ t: 'account-change', entityIds: [MCP_SERVER_CATALOG_ACCOUNT_KEY_V1] }, {
        previous: previous?.scopeKey === mcpCatalogScopeKey ? previous.mcpServerCatalog : undefined,
        next: next.mcpServerCatalog,
      });
      if (event) publishDaemonHostEvent(event, params.isShuttingDown);
    });
    machineConnectionStateCleanup = () => {
      cleanupHeartbeatReceipts();
      cleanupMcpCatalog();
      priorHeartbeatLifetimeCleanup?.();
    };
    connectedApiMachine.onAutomationEventSourcesInvalidated(payload => {
      publishDaemonHostEvent({
        eventId: HAPPIER_AUTOMATION_EVENT_SOURCES_INVALIDATED_HOST_EVENT_ID_V1,
        scope: { kind: 'account' },
        payload,
      }, params.isShuttingDown);
    });
    connectedApiMachine.onSessionFollowRulesChanged(change => {
      for (const discussionId of new Set(change?.discussionIds ?? [])) {
        publishDaemonHostEvent({
          eventId: HAPPIER_DISCUSSION_INVALIDATED_HOST_EVENT_ID_V1,
          scope: { kind: 'account' },
          payload: { discussionId },
        }, params.isShuttingDown);
      }
    });
    connectedApiMachine.onUpdate((update) => {
      const body = UpdateBodySchema.safeParse(update?.body);
      if (body.success && body.data.t === 'account-change' && !params.isShuttingDown()) {
        const receiptChange = body.data;
        const resolveReceiptOrigin = params.resolveCurrentMachineExecutionOriginContext
          ?? createCurrentMachineExecutionOriginContextResolver({ serverUrl: resolveServerHttpBaseUrl(),
            resolveCurrentMachineId: () => params.machineId });
        void projectDeploymentReceiptInvalidationsForHost(receiptChange, async () => {
          const origin = await resolveReceiptOrigin();
          if (!origin) throw new Error('Current Home identity is unavailable for deployment receipt Events.');
          return origin.serverIdentityId;
        }).then(events => {
          for (const event of events) {
            publishDaemonHostEvent(event, params.isShuttingDown);
          }
        }).catch(error => logger.warn('[DAEMON RUN] Deployment receipt Event unavailable', error));
      }
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
    const publicProfileRefreshHandle = params.publicProfileRefreshHandle;
    const unsubscribePendingResetQuotaTick = connectedServiceQuotasLoopHandle?.subscribeAfterTick(async signal => {
      if (params.isShuttingDown()) return;
      await inactiveUsageLimitRecoveryScheduler.reconcilePendingResetStartsForTrackedSessions(signal)
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
        ...(publicProfileRefreshHandle ? [{
          name: 'publicProfileRefresh',
          pause: () => publicProfileRefreshHandle.pause(),
          resume: () => publicProfileRefreshHandle.resume(),
        }] : []),
      ],
    });

    const cleanupPluginConnectionStateSource = bindPluginDaemonConnectionStateSource(connectedApiMachine);
    let onlinePreparation: Promise<void> | null = null;
    const cleanupDaemonConnectivityState = connectedApiMachine.onConnectionStateChange((state) => {
      if (params.isShuttingDown()) return;

      const online = state.phase === 'online';
      params.setDaemonServerWorkOnline?.(online);
      if (online) {
        params.wakeRuntimeAuthRecoveryPresentation?.();
        onlinePreparation = (async () => {
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
      } else onlinePreparation = null;
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

      const operation = runMachineReconnectPhase('metadata-publication', async () => {
        const cliUpdate = params.readCliUpdateFacts?.();
        const cliSnapshot = await detectCliSnapshotOnDaemonPath({});
        const agentInventoryCheckedAt = Date.now();
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
            arch: os.arch(),
            happyCliVersion: params.cliVersion,
            homeDir: os.homedir(),
            happyHomeDir: params.happyHomeDir,
            happyLibDir: params.happyLibDir,
            ...(cliUpdate ? { cliUpdate } : {}),
            ...(devcontainerChild !== undefined ? { devcontainerChild } : {}),
          });
        }, { agentInventoryObservation: { snapshot: cliSnapshot, checkedAt: agentInventoryCheckedAt } });
        if (outcome !== 'suppressed') {
          didRefreshMachineMetadata = true;
          publishedCliUpdateFacts = JSON.stringify(cliUpdate ?? null);
        }
      }).catch((error) => {
        logger.warn('[DAEMON RUN] Failed to refresh machine metadata on reconnect', error);
      });
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
    let pendingOrphanedSessions = params.orphanedDeadDaemonSessions ?? [];
    const refreshMachineConnectionPublications = async (): Promise<void> => {
      hasPendingMachineConnectionPublications = true;
      if (params.isShuttingDown()) return;
      if (machineConnectionPublicationsInFlight) {
        await machineConnectionPublicationsInFlight;
        if (hasPendingMachineConnectionPublications && !params.isShuttingDown()) {
          return refreshMachineConnectionPublications();
        }
        return;
      }

      const operation = (async () => {
        // Registration retains incumbent state. Publish this daemon's lazy
        // transfer declaration only once the Machine transport is connected.
        await runMachineReconnectPhase('transfer-publication', () => params.attachTransferRuntimeStatePublisher(connectedApiMachine));
        if (params.isShuttingDown()) return;
        await runMachineReconnectPhase('orphan-settlement', async () => {
          // connect() starts the transport asynchronously. Settle dead markers only
          // on this connected edge; retain failures for reconnect or handoff resume.
          if (params.credentials) {
            const discovered = await readOrphanedDeadPlainRunnerMarkers();
            const knownPids = new Set(pendingOrphanedSessions.map(marker => marker.pid));
            pendingOrphanedSessions = [...pendingOrphanedSessions, ...discovered.filter(marker => !knownPids.has(marker.pid))];
          }
          if (pendingOrphanedSessions.length > 0) {
            pendingOrphanedSessions = await publishOrphanedStartupSessionEnds({
              serverId: params.requesterServerId ?? configuration.activeServerId,
              apiMachine: connectedApiMachine,
              orphanedDeadDaemonSessions: pendingOrphanedSessions,
              isSessionAlreadyRunning: params.isSessionAlreadyRunning,
              ...(params.isSessionRespawnPending ? { isSessionRespawnPending: params.isSessionRespawnPending } : {}),
              isShuttingDown: params.isPublicationQuiescing ?? params.isShuttingDown,
              ...(params.credentials ? { retireTerminalControlServiceability: async (marker: OrphanedDeadDaemonSession) => {
                await retireOrphanedTerminalControlServiceability({ marker, credentials: params.credentials!,
                  resolveRequesterSessionRuntimeContext: params.resolveRequesterSessionRuntimeContext,
                  releaseRequesterSessionRuntimeContext: params.releaseRequesterSessionRuntimeContext });
              } } : {}),
            });
          }
        });
        if (params.isShuttingDown()) return;
        hasPendingMachineConnectionPublications = false;
      })();
      machineConnectionPublicationsInFlight = operation;
      try {
        return await operation;
      } finally {
        if (machineConnectionPublicationsInFlight === operation) {
          machineConnectionPublicationsInFlight = null;
        }
      }
    };
    const refreshAccountSettingsAfterConnect = async (): Promise<void> => {
      if (params.isShuttingDown()) return;
      try {
        // Reconnect can be the first live Account snapshot after an offline start.
        // Keep optional plugin settings independent of Machine publication/readiness.
        if (params.credentials) {
          await warmActiveAccountSettingsSnapshotBestEffort({ credentials: params.credentials, logger });
        }
        if (!params.isShuttingDown()) await providerAccountSettingsController?.refresh();
      } catch (error) {
        logger.warn('[DAEMON RUN] Agent Account settings reconnect application failed', error);
      }
    };
    const catchUpAutomationWorkAfterConnect = async (): Promise<void> => {
      if (params.isShuttingDown()) return;
      await runMachineReconnectPhase('automation-catch-up', () => activeAutomationWorker?.catchUp()).catch((error) => {
        logger.warn('[DAEMON RUN] Failed to catch up automation work on machine reconnect', error);
      });
    };
    const recoverPendingWithEndpointRetry = (endpointPublication: ReturnType<typeof refreshPeerMediationEndpointPublication>) =>
      runMachineReconnectPhase('pending-recovery', () => recoverPendingSessionActivationsAfterConnect(
        endpointPublication.then(outcome => (outcome === 'published' || outcome === 'unchanged') && !params.isShuttingDown()),
      )).catch(error => {
        logger.warn('[DAEMON RUN] Pending session activation reconnect scan failed; waiting custody retained', error);
      });
    resumeMachineConnectionPublications = async () => {
      void refreshAccountSettingsAfterConnect();
      const endpointPublication = refreshPeerMediationEndpointPublication();
      const pendingRecovery = params.isShuttingDown() ? undefined : recoverPendingWithEndpointRetry(endpointPublication);
      await Promise.all([
        endpointPublication,
        (async () => {
          await catchUpAutomationWorkAfterConnect();
          await refreshMachineConnectionPublications();
        })(),
      ]);
      await refreshMachineMetadataPublication();
      if (params.isShuttingDown()) return;
      await Promise.all([
        pendingRecovery,
        (async () => {
          await onlinePreparation;
          await workflowRecoveryTriggers?.onResumed();
        })().catch((error) => {
          logger.warn('[DAEMON RUN] Workflow custody resume recovery failed; pending custody retained', error);
        }),
      ]);
    };
    const handleMachineConnected = async (): Promise<void> => {
      // Broker admission needs this connected Machine's endpoint. Enqueue it
      // before transfer writes; unrelated Automation and orphan settlement
      // work may wait on their own network acknowledgements.
      const endpointPublication = refreshPeerMediationEndpointPublication();
      if (params.isShuttingDown()) {
        await endpointPublication;
        return;
      }
      void refreshAccountSettingsAfterConnect();
      const pendingRecovery = recoverPendingWithEndpointRetry(endpointPublication);
      await Promise.all([
        // Local Pending admission owns target and runner readiness. Unrelated
        // Automation and Machine publications must not hold requester recovery.
        (async () => {
          await catchUpAutomationWorkAfterConnect();
          await refreshMachineConnectionPublications();
        })(),
        (async () => {
          await endpointPublication;
          await refreshMachineMetadataPublication();
        })(),
        pendingRecovery,
        params.dispatchSessionFollowOccurrence?.({ accountFollowSourcesChanged: {} }).catch(error => {
          logger.warn('[DAEMON RUN] Personal Run Follow reconnect read remains pending', serializeAxiosErrorForLog(error));
        }),
        (async () => {
          // Connection publication refreshes the existing server feature source.
          // Recovery must consume that decision after refresh, not a cold snapshot.
          await onlinePreparation;
          await workflowRecoveryTriggers?.onConnected();
        })().catch((error) => {
          logger.warn('[DAEMON RUN] Workflow custody startup/reconnect recovery failed; pending custody retained', error);
        }),
      ]);
    };
    connectedApiMachine.connect({
      takeover: params.takeoverRequested,
      ...(params.prepareServerTransportForReconnect
        ? { prepareServerTransportForReconnect: params.prepareServerTransportForReconnect }
        : {}),
      onConnect: handleMachineConnected,
      onOwnershipConflict: (conflict) => {
        logger.warn('[DAEMON RUN] Relay ownership conflict prevented machine connection', conflict);
        // A refused relay connection must let service managers retry after the incumbent retires.
        params.requestShutdown('exception', 'machine-owner-conflict');
      },
      onMachineReplaced: (event) => {
        if (event.reason === 'revoked') {
          logger.warn('[DAEMON RUN] Machine installation was displaced; rotating its registration before restart', event);
          void rotateMachineIdForActiveServer({ expectedCurrentMachineId: event.machineId, recordReplacementCandidate: false }).then(
            () => params.requestShutdown('exception', 'machine-revoked'),
            error => {
              logger.warn('[DAEMON RUN] Machine identity rotation failed; stopping the displaced daemon', serializeAxiosErrorForLog(error));
              params.requestShutdown('happier-app', 'machine-identity-rotation-failed');
            },
          );
          return;
        }
        logger.warn('[DAEMON RUN] Machine was replaced by the server; shutting down stale daemon connection', event);
        params.requestShutdown('happier-app', 'machine-replaced');
      },
    });
  } else {
    logger.warn('[DAEMON RUN] Machine sync client unavailable; machine-bound workers were not started');
  }

  // Machine registration is started after local daemon-state publication. Reconstruct early,
  // then arm the existing durable timer owner only after its recovery runners are installed.
  if (!params.isShuttingDown()) inactiveUsageLimitRecoveryScheduler.hydrate();

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
    roleActivations,
    daemonConnectivityCoordinator,
    machineConnectionStateCleanup,
    stopProviderAccountSettings,
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
