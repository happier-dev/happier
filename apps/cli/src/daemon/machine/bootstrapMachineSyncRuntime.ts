import fs from 'fs/promises';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { DaemonState, Machine, MachineMetadata } from '@/api/types';
import type { SessionHandoffDirectPeerTransferHandle } from '@/api/machine/sessionHandoff/handlers';
import { createFileTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { DirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { resolvePromptAssetDownloadSource } from '@/transfers/targets/resolvePromptAssetDownloadSource';
import { resolvePromptRegistryItemDownloadSource } from '@/transfers/targets/resolvePromptRegistryItemDownloadSource';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import type {
  MachineLiveStreamControlLeaseV1,
  PromptAssetReadRequest,
  PromptRegistryFetchItemRequestV1,
} from '@happier-dev/protocol';
import {
    createProviderErrorV1,
    HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1,
    parseHostEventPayloadV1,
    readServerEnabledBit,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
} from '@happier-dev/protocol';
import { UpdateBodySchema } from '@happier-dev/protocol/updates';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import { activatePendingInactiveSession } from '@/daemon/sessions/activatePendingInactiveSession';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
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
import { createRuntimeProviderConnectionServices } from '@/providers/connections/runtimeServices';
import { refreshMachineMetadataForCurrentDaemon } from './metadata';
import { createLegacyProfileMigrationRpcServices } from '@/providers/migrations/rpc';
import {
  createRuntimeProviderOperationsProducer,
  type RuntimeProviderOperationsProducer,
} from '@/providers/runtimeServices';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createNpmRegistryProfileProbe } from '@/plugins/distribution/npm/profiles/probe';
import { triggerLegacyProfileMigration as triggerLegacyProfileMigrationRuntime } from '@/providers/migrations/runtime';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import {
  PeerLoopbackEndpointCandidateV1Schema,
  type FeaturesResponse,
  type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';
import type { PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol';
import {
  startPeerMediationLoopback,
  type StartPeerMediationLoopbackInput,
  type StartedPeerMediationLoopback,
} from '../peer/mediation/rpc/startLoopback';
import { createMachineLiveStreamRelayTerminator } from '../peer/mediation/stream';
import { registerPeerTcpTunnelRelayTerminator } from '../peer/mediation/tunnel/relay';
import { createDaemonPeerMediationObservabilityRuntime } from './peerMediationObservabilityRuntime';
import type { DaemonPeerMediationObservabilityEmitter } from '../peer/mediation/observability/events';
import { connectPeerTcpTunnelTcp } from '../peer/mediation/tunnel/open';
import type {
  PeerTcpTunnelVoiceBinaryAppendConsumer,
  PeerTcpTunnelVoiceBinaryTerminalConsumer,
} from '../peer/mediation/tunnel/voiceBinaryAppend';
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
import {
  createDaemonSessionMutationCustody,
  type DaemonSessionMutationCustody,
} from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { buildInactiveUsageLimitResumeSpawnOptions } from '../sessions/runtimeSnapshot/buildInactiveUsageLimitResumeSpawnOptions';
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
  accountSigningSeed?: Uint8Array | null;
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
}>;

type PeerTcpTunnelRelayBootstrapContext = Readonly<{
  accountId: string;
  serverFeatures: FeaturesResponse;
}>;

type SavePreparedTargetLocalMetadataInput = Readonly<{
  remoteSessionId: string;
  exportMetadataOverlay: Record<string, unknown>;
}>;

const PEER_MEDIATION_MACHINE_RPC_FEATURES_TIMEOUT_MS = 1_500;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized ? normalized : null;
}

function resolveAccountIdFromCredentials(credentials: StoredCredentials | undefined): string | null {
  if (!credentials) return null;
  const payload = decodeJwtPayload(credentials.token);
  return typeof payload?.sub === 'string' ? normalizeNonEmptyString(payload.sub) : null;
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

function resolveAccountSigningSeed(params: Readonly<{
  config: PeerMediationMachineRpcBootstrapConfig | undefined;
  credentials: StoredCredentials | undefined;
  machine: Machine;
}>): Uint8Array | null {
  if (params.config?.accountSigningSeed && params.config.accountSigningSeed.length > 0) {
    return params.config.accountSigningSeed;
  }
  if (params.credentials?.encryption?.type === 'legacy') {
    return params.credentials.encryption.secret;
  }
  if (params.machine.encryptionVariant === 'legacy' && params.machine.encryptionKey.length > 0) {
    return params.machine.encryptionKey;
  }
  return null;
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
  const base: DaemonState = state ?? { status: 'running' };
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
}>): Promise<StartedPeerMediationLoopback | null> {
  const serverFeatures = await resolvePeerMediationMachineRpcServerFeatures(params.config);
  if (!serverFeatures) return null;
  const accountId = normalizeNonEmptyString(params.config?.accountId)
    ?? resolveAccountIdFromCredentials(params.credentials);
  if (!accountId) return null;
  const accountSigningSeed = resolveAccountSigningSeed({
    config: params.config,
    credentials: params.credentials,
    machine: params.machine,
  });
  return await startPeerMediationLoopback({
    accountId,
    machineId: params.machineId,
    ...(accountSigningSeed ? { accountSigningSeed } : {}),
    serverFeatures,
    rpcHandlerManager: params.connectedApiMachine.getPeerMediationMachineRpcHandlerManager(),
    tunnel: {
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
  });
}

async function resolvePeerTcpTunnelRelayBootstrapContext(params: Readonly<{
  config: PeerMediationMachineRpcBootstrapConfig | undefined;
  credentials: StoredCredentials | undefined;
}>): Promise<PeerTcpTunnelRelayBootstrapContext | null> {
  const serverFeatures = await resolvePeerMediationMachineRpcServerFeatures(params.config);
  if (!serverFeatures) return null;
  if (readServerEnabledBit(serverFeatures, 'machines.tunnel.serverRouted') !== true) return null;
  const accountId = normalizeNonEmptyString(params.config?.accountId)
    ?? resolveAccountIdFromCredentials(params.credentials);
  if (!accountId) return null;
  return { accountId, serverFeatures };
}

function resolvePeerTcpTunnelRelayTrustRoots(input: Readonly<{
  serverFeatures: FeaturesResponse;
  nowMs: number;
}>): Array<Readonly<{ keyId: string; publicKeyBase64Url: string }>> {
  return input.serverFeatures.capabilities.machines.peerMediation.grantSigningKeys
    .filter((key) => key.expiresAt == null || key.expiresAt > input.nowMs)
    .map((key) => ({
      keyId: key.keyId,
      publicKeyBase64Url: key.publicKey,
    }));
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
    params.memoryWorker?.stop();
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
  daemonSessionMutationCustody?: DaemonSessionMutationCustody;
  deviceLocalSecretStorage?: DeviceLocalSecretStorage;
  preferredHost: string;
  happyHomeDir: string;
  happyLibDir: string;
  filesystemAccessPolicy: FilesystemAccessPolicy;
  takeoverRequested: boolean;
  isShuttingDown: () => boolean;
  createConnectedApiMachine: (machine: Machine) => ApiMachineClient | null;
  attachTransferRuntimeStatePublisher: (apiMachine: ApiMachineClient) => Promise<void>;
  startAutomationWorkerForMachine: (machineId: string) => AutomationWorkerHandle | null;
  startMemoryWorkerForMachine: (machineId: string) => Promise<MemoryWorkerHandle | null>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => Promise<StopSessionResult | boolean>;
  awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
  isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadataForHandoff: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  savePreparedTargetLocalMetadata: (input: SavePreparedTargetLocalMetadataInput) => Promise<void>;
  beforeShutdown: () => Promise<void>;
  requestShutdown: (source: 'happier-app', errorMessage?: string) => void;
  directPeerServerLifecycle: DirectTransferServerLifecycle | null;
  directTransferPromptAssetAdapterRegistry: ReturnType<typeof createPromptAssetAdapterRegistry>;
  directTransferPromptRegistryRegistry: PromptRegistryRegistry;
  connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle | null;
  connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null;
  daemonServerWorkScheduler: DaemonServerWorkScheduler;
  retryTemporaryThrottleNow?: (input: Readonly<{ sessionId: string }>) => Promise<unknown> | unknown;
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
  peerMediationMachineRpc?: PeerMediationMachineRpcBootstrapConfig;
  inactiveUsageLimitRecoveryStore?: DurableBackoffRecoveryStore<UsageLimitRecoveryIntent>;
  readLocalServiceInventorySnapshot?: () => Promise<NormalizedLocalServiceInventorySnapshot | null>;
  managedCatalogRuntime?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['managedCatalogRuntime'];
  resolveManagedPurposeBindingIntent?: Parameters<
    typeof createRuntimeProviderModelManagementServices
  >[0]['resolveManagedPurposeBindingIntent'];
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
      resumeMachineConnectionPublications: async () => {},
      daemonSessionMutationCustody: null,
      cancelInactiveSessionUsageLimitRecoveryAfterExplicitStop: async () => null,
      disposeInactiveSessionUsageLimitRecovery: () => {},
      providerOperationsProducer: null,
    };
  }

  const connectedApiMachine = params.createConnectedApiMachine(params.machine);
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
  let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
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

  const directTransferExportHandlers = directPeerServerLifecycle
    ? {
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
              }>,
        ) => {
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
                : input.t === 'workspace_file_download_v1'
                  ? await resolveWorkspaceFileDownloadSource({
                      workingDirectory: input.workingDirectory,
                      path: input.path,
                      asZip: input.asZip,
                      accessPolicy: params.filesystemAccessPolicy,
                      sessionRpcTransferMaxBytes: null,
                    })
                  : { success: false as const, error: 'Unsupported direct transfer export request' };
          if (!resolvedSource.success) {
            throw new Error(resolvedSource.error);
          }
          const payloadSource = createFileTransferPayloadSource({
            filePath: resolvedSource.source.filePath,
            sizeBytes: resolvedSource.source.sizeBytes,
            name: resolvedSource.source.name,
            dispose: resolvedSource.source.deleteFileOnClose
              ? async () => {
                  await fs.rm(resolvedSource.source.filePath, { force: true }).catch(() => undefined);
                }
              : undefined,
          });

          const transferId = `${
            input.t === 'prompt_asset_download_v1'
              ? 'prompt-asset-download'
              : input.t === 'prompt_registry_download_v1'
                ? 'prompt-registry-download'
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
  const inactiveUsageLimitRecoveryScheduler = new UsageLimitRecoveryScheduler({
    nowMs: () => Date.now(),
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
    automationWorker = params.startAutomationWorkerForMachine(params.machineId);
    const activeAutomationWorker = automationWorker;
    memoryWorker = await params.startMemoryWorkerForMachine(params.machineId);
    voiceInferenceWorker = await params.startVoiceInferenceWorkerForMachine(
      params.machineId,
      normalizeNonEmptyString(params.peerMediationMachineRpc?.accountId)
        ?? resolveAccountIdFromCredentials(params.credentials),
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
      if (!encryptionCredentials) return;
      const triggerMigration = params.triggerLegacyProfileMigration ?? triggerLegacyProfileMigrationRuntime;
      try {
        const result = await triggerMigration({
          credentials: encryptionCredentials,
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
    let providerRuntimeServices!: ReturnType<typeof createRuntimeProviderModelManagementServices>;
    let providerLocalInstallationReader!: ReturnType<typeof createProviderLocalInstallationReader>;
    const providerConnectionRuntimeServices = params.credentials
      ? createRuntimeProviderConnectionServices({
          machineId: params.machineId,
          credentials: params.credentials,
          happyHomeDir: configuration.happyHomeDir,
          featureGate: providerFeatureGate,
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
    providerRuntimeServices = createRuntimeProviderModelManagementServices({
      machineId: params.machineId,
      happyHomeDir: configuration.happyHomeDir,
      featureGate: providerFeatureGate,
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
      sourceProfileId: string;
    }>) => ({
      status: 'error' as const,
      error: createProviderErrorV1('provider_feature_disabled', {
        machineId: request.machineId,
        sourceProfileId: request.sourceProfileId,
      }),
    });
    const providerProfileMigrationRpcServices = encryptionCredentials
      ? createLegacyProfileMigrationRpcServices({ credentials: encryptionCredentials })
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
        savePreparedTargetLocalMetadata: async ({ remoteSessionId, exportMetadataOverlay }) => {
          await params.savePreparedTargetLocalMetadata({
            remoteSessionId,
            exportMetadataOverlay,
          });
        },
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
            }
          : {}),
        resumeInactiveSessionWhenUsageLimitReady: async ({ sessionId, rawSession, metadata }) => {
          const options = buildInactiveUsageLimitResumeSpawnOptions({
            sessionId,
            fallbackMachineId: params.machineId,
            rawSession,
            metadata,
          });
          if (!options) return false;
          const result = await params.spawnSession(options);
          return result.type === 'success';
        },
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
    // store. Narrow callers without an injected emitter fall back to a self-owned store (read-path
    // stays empty, but the write-path still functions).
    const peerMediationObservabilityEmitter = params.peerMediationMachineRpc?.observability
      ?? createDaemonPeerMediationObservabilityRuntime({
        nowMs: params.peerMediationMachineRpc?.nowMs ?? (() => Date.now()),
      }).emitter;

    peerMediationLoopback = await maybeStartPeerMediationLoopback({
      config: params.peerMediationMachineRpc,
      observability: peerMediationObservabilityEmitter,
      connectedApiMachine,
      credentials: params.credentials,
      machine: params.machine,
      machineId: params.machineId,
      ...(voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer } : {}),
      ...(voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer } : {}),
    }).catch((error) => {
      logger.warn('[DAEMON RUN] Failed to start peer mediation loopback route', error);
      return null;
    });
    if (peerMediationLoopback) {
      stopPeerMediationLoopbackServer = peerMediationLoopback.stop;
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
      const serverRoutedCaps = peerTcpTunnelRelayContext.serverFeatures.capabilities.machines.tunnel.serverRouted;
      const relayAuthorizationTrustRoots = resolvePeerTcpTunnelRelayTrustRoots({
        serverFeatures: peerTcpTunnelRelayContext.serverFeatures,
        nowMs: nowMs(),
      });
      if (relayAuthorizationTrustRoots.length > 0) {
        let cleanupRelaySubscription: (() => void) | null = null;
        const relaySocket = {
          on: (_event: string, handler: (payload?: unknown) => void | Promise<void>) => (
            cleanupRelaySubscription = connectedApiMachine.onPeerTcpTunnelRelayEnvelope((payload) => {
              void Promise.resolve(handler(payload)).catch((error) => {
                logger.warn('[DAEMON RUN] Peer TCP tunnel relay handler failed', error);
              });
            })
          ),
          emit: (_event: string, payload: unknown) => {
            connectedApiMachine.sendPeerTcpTunnelRelayEnvelope(payload as PeerTcpTunnelRelayEnvelope);
          },
        };
        registerPeerTcpTunnelRelayTerminator({
          accountId: peerTcpTunnelRelayContext.accountId,
          machineId: params.machineId,
          socket: relaySocket,
          nowMs,
          relayAuthorizationTrustRoots,
          connectTcp: connectPeerTcpTunnelTcp,
          maxFrameBytes: serverRoutedCaps.maxFrameBytes,
          maxBinaryHeaderBytes: serverRoutedCaps.maxBinaryHeaderBytes,
          maxRawPayloadBytes: serverRoutedCaps.maxRawPayloadBytes,
          maxFramedMessageBytes: serverRoutedCaps.maxFramedMessageBytes,
          maxActiveTunnels: serverRoutedCaps.maxActiveTunnelsPerSocket,
          substreamCaps: serverRoutedCaps.substreams,
          observability: peerMediationObservabilityEmitter,
          ...(voiceBinaryAppendConsumer ? { voiceBinaryAppendConsumer } : {}),
          ...(voiceBinaryTerminalConsumer ? { voiceBinaryTerminalConsumer } : {}),
        });
        cleanupPeerTcpTunnelRelay = () => {
          cleanupRelaySubscription?.();
          cleanupRelaySubscription = null;
          cleanupPeerTcpTunnelRelay = null;
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
        start: (startRequest) => liveStreamRelayTerminator.start(startRequest),
      });
      const cleanupMachineLiveStreamRelaySubscription = connectedApiMachine.onMachineLiveStreamRelayEnvelope((payload) => {
        // Starts arrive exclusively over the machine RPC above (SIM-P0-1). The server never
        // forwards `start` envelopes into machine rooms, so no start branch exists here.
        if (payload.message.kind !== 'control' && payload.message.kind !== 'sideband_control') return;
        const result = liveStreamRelayTerminator.applyControl(payload);
        if (result.ok) return;
        logger.warn('[DAEMON RUN] Live-stream relay control denied', {
          reasonCode: result.reasonCode,
          streamId: payload.message.control.streamId,
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

    if (storedCredentials) {
      const credentials = storedCredentials;
      connectedApiMachine.onPendingSessionActivationHint(async (hint) => {
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
      });
    }

    connectedApiMachine.onUpdate((update) => {
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
    machineConnectionStateCleanup = () => {
      if (didCleanupMachineConnectionState) {
        return;
      }
      didCleanupMachineConnectionState = true;
      cleanupDaemonConnectivityState();
      cleanupPluginConnectionStateSource();
      cleanupMachineLiveStreamRelay?.();
      cleanupPeerTcpTunnelRelay?.();
    };

    let didRefreshMachineMetadata = false;
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
          const outcome = await connectedApiMachine.updateMachineMetadata((metadata) => {
            const base = (metadata ?? params.machine.metadata ?? {}) as Partial<MachineMetadata>;
            return refreshMachineMetadataForCurrentDaemon(base, {
              host: params.preferredHost,
              platform: os.platform(),
              happyCliVersion: params.cliVersion,
              homeDir: os.homedir(),
              happyHomeDir: params.happyHomeDir,
              happyLibDir: params.happyLibDir,
            });
          });
          if (outcome !== 'suppressed') {
            didRefreshMachineMetadata = true;
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
      }
    };
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
        if (activePeerMediationLoopback) {
          const outcome = await connectedApiMachine
            .updateDaemonState((state) => mergePeerMediationLoopbackEndpoint(
              state,
              activePeerMediationLoopback.endpoint,
              activePeerMediationLoopback.activeFlows,
            ))
            .catch((error) => {
              logger.warn('[DAEMON RUN] Failed to publish peer mediation loopback endpoint', error);
              return null;
            });
          if (outcome === 'suppressed' || params.isShuttingDown()) return;
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
    resumeMachineConnectionPublications = refreshMachineConnectionPublications;
    connectedApiMachine.connect({
      takeover: params.takeoverRequested,
      onConnect: refreshMachineConnectionPublications,
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
    logger.warn('[DAEMON RUN] Diagnostic gate enabled: machine sync disabled');
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
