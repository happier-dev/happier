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
  MachineLiveStreamStartRequestV1,
  PromptAssetReadRequest,
  PromptRegistryFetchItemRequestV1,
} from '@happier-dev/protocol';
import {
  readServerEnabledBit,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
} from '@happier-dev/protocol';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
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
import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { normalizeAccountSettingsVersionHint } from '@/settings/accountSettings/accountSettingsVersion';
import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';
import { warmActiveAccountSettingsSnapshotBestEffort } from '@/settings/accountSettings/warmActiveAccountSettingsSnapshot';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import type { FeaturesResponse, PeerLoopbackEndpointCandidateV1 } from '@happier-dev/protocol';
import type { PeerTcpTunnelRelayEnvelope } from '@happier-dev/protocol';
import {
  startPeerMediationLoopback,
  type StartPeerMediationLoopbackInput,
  type StartedPeerMediationLoopback,
} from '../peer/mediation/rpc/startLoopback';
import { createMachineLiveStreamRelayTerminator } from '../peer/mediation/stream';
import { registerPeerTcpTunnelRelayTerminator } from '../peer/mediation/tunnel/relay';
import { connectPeerTcpTunnelTcp } from '../peer/mediation/tunnel/open';
import { resolveDaemonSpawnSessionByNonce } from '../controlClient';
import {
  UsageLimitRecoveryScheduler,
  type UsageLimitRecoveryIntentStore,
} from '../connectedServices/usageLimitRecovery/UsageLimitRecoveryScheduler';
import { buildInactiveUsageLimitResumeSpawnOptions } from '../sessions/runtimeSnapshot/buildInactiveUsageLimitResumeSpawnOptions';
import { createRecoveryIntentFileStore } from '../connectedServices/recoveryScheduler/recoveryIntentFileStore';

function readAccountSettingsChangedHintVersion(update: unknown): number | null {
  if (!update || typeof update !== 'object') return null;
  const body = (update as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return null;
  if ((body as { t?: unknown }).t !== 'account-settings-changed') return null;
  return normalizeAccountSettingsVersionHint((body as { settingsVersion?: unknown }).settingsVersion);
}

async function refreshDaemonAccountSettingsForHint(params: Readonly<{
  credentials: Credentials;
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
  endpointFingerprint?: () => string;
  endpointTtlMs?: number;
  host?: string;
  port?: number;
  localPerPeerMaxConcurrentCalls?: number;
  stream?: StartPeerMediationLoopbackInput['stream'];
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

function resolveAccountIdFromCredentials(credentials: Credentials | undefined): string | null {
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
  credentials: Credentials | undefined;
  machine: Machine;
}>): Uint8Array | null {
  if (params.config?.accountSigningSeed && params.config.accountSigningSeed.length > 0) {
    return params.config.accountSigningSeed;
  }
  if (params.credentials?.encryption.type === 'legacy') {
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
  const base: DaemonState = state ?? { status: 'running' };
  return {
    ...base,
    peerMediation: {
      ...base.peerMediation,
      loopback: {
        ...base.peerMediation?.loopback,
        endpoint,
        flows: {
          ...base.peerMediation?.loopback?.flows,
          ...(activeFlows.machine_rpc ? { machine_rpc: { active: true } } : {}),
          ...(activeFlows.live_stream ? { live_stream: { active: true } } : {}),
          ...(activeFlows.tcp_tunnel ? { tcp_tunnel: { active: true } } : {}),
        },
      },
    },
  };
}

async function maybeStartPeerMediationLoopback(params: Readonly<{
  config: PeerMediationMachineRpcBootstrapConfig | undefined;
  connectedApiMachine: ApiMachineClient;
  credentials: Credentials | undefined;
  machine: Machine;
  machineId: string;
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
  if (!accountSigningSeed) return null;

  return await startPeerMediationLoopback({
    accountId,
    machineId: params.machineId,
    accountSigningSeed,
    serverFeatures,
    rpcHandlerManager: params.connectedApiMachine.getPeerMediationMachineRpcHandlerManager(),
    tunnel: {},
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
  credentials: Credentials | undefined;
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
  apiMachine: ApiMachineClient | null;
  apiMachineForSessions: ApiMachineClient | null;
  automationWorker: AutomationWorkerHandle | null;
  memoryWorker: MemoryWorkerHandle | null;
  voiceInferenceWorker: VoiceInferenceWorkerHandle | null;
  daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null;
  machineConnectionStateCleanup: (() => void) | null;
  stopPeerMediationLoopbackServer: () => Promise<void>;
}>;

export type BootstrapMachineSyncRuntimeParams = Readonly<{
  cliVersion: string;
  machineId: string;
  machine: Machine;
  credentials?: Credentials;
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
  stopSession: (sessionId: string) => Promise<boolean>;
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
  setDaemonServerWorkOnline?: (online: boolean) => void;
  onMachineConnectionOnline?: () => void | Promise<void>;
  startVoiceInferenceWorkerForMachine: (machineId: string) => Promise<VoiceInferenceWorkerHandle | null>;
  peerMediationMachineRpc?: PeerMediationMachineRpcBootstrapConfig;
  inactiveUsageLimitRecoveryStore?: UsageLimitRecoveryIntentStore;
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
    };
  }

  const connectedApiMachine = params.createConnectedApiMachine(params.machine);
  if (connectedApiMachine) {
    await params.attachTransferRuntimeStatePublisher(connectedApiMachine);
  }

  let automationWorker: AutomationWorkerHandle | null = null;
  let memoryWorker: MemoryWorkerHandle | null = null;
  let voiceInferenceWorker: VoiceInferenceWorkerHandle | null = null;

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
        requestPayloadFile: async ({ transferId, endpointCandidates, destinationPath, openBody, timeoutMs }) =>
          await directPeerServerLifecycle.requestPayloadFile({
            transferId,
            endpointCandidates,
            destinationPath,
            ...(openBody !== undefined ? { openBody } : {}),
            ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
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

  let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
  let machineConnectionStateCleanup: (() => void) | null = null;
  let peerMediationLoopback: StartedPeerMediationLoopback | null = null;
  let stopPeerMediationLoopbackServer: () => Promise<void> = async () => {};
  let cleanupMachineLiveStreamRelay: (() => void) | null = null;
  let cleanupPeerTcpTunnelRelay: (() => void) | null = null;
  const inactiveUsageLimitRecoveryCheckRunners = new Map<string, () => Promise<unknown>>();
  const inactiveUsageLimitRecoveryScheduler = new UsageLimitRecoveryScheduler({
    nowMs: () => Date.now(),
    store: params.inactiveUsageLimitRecoveryStore ?? createRecoveryIntentFileStore(join(
      configuration.activeServerDir,
      'connected-services',
      'inactive-usage-limit-recovery.json',
    )),
    recover: async (_intent, context) => {
      const runCheckNow = inactiveUsageLimitRecoveryCheckRunners.get(context.sessionId);
      if (!runCheckNow) {
        return {
          status: 'wait',
          nextCheckAtMs: Date.now() + 60_000,
          lastProbeError: 'usage_limit_recovery_runner_unavailable',
        };
      }
      const result = await runCheckNow();
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
  inactiveUsageLimitRecoveryScheduler.hydrate();

  if (connectedApiMachine) {
    automationWorker = params.startAutomationWorkerForMachine(params.machineId);
    const activeAutomationWorker = automationWorker;
    memoryWorker = await params.startMemoryWorkerForMachine(params.machineId);
    voiceInferenceWorker = await params.startVoiceInferenceWorkerForMachine(params.machineId);

    connectedApiMachine.setRPCHandlers(
      {
        spawnSession: params.spawnSession,
        resolveSpawnSessionByNonce: resolveDaemonSpawnSessionByNonce,
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
        emitExternalSessionTranscriptUpdate: (payload) => connectedApiMachine.emitExternalSessionTranscriptUpdate(payload),
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
        scheduleInactiveSessionUsageLimitRecoveryCheck: ({ sessionId, recovery, runCheckNow }) => {
          inactiveUsageLimitRecoveryCheckRunners.set(sessionId, runCheckNow);
          inactiveUsageLimitRecoveryScheduler.upsert({ sessionId, intent: recovery });
        },
        cancelInactiveSessionUsageLimitRecoveryCheck: ({ sessionId }) => {
          inactiveUsageLimitRecoveryCheckRunners.delete(sessionId);
          void inactiveUsageLimitRecoveryScheduler.cancel({ sessionId });
        },
        ...(params.retryTemporaryThrottleNow
          ? { retryTemporaryThrottleNow: params.retryTemporaryThrottleNow }
          : {}),
      },
    );

    peerMediationLoopback = await maybeStartPeerMediationLoopback({
      config: params.peerMediationMachineRpc,
      connectedApiMachine,
      credentials: params.credentials,
      machine: params.machine,
      machineId: params.machineId,
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
          maxActiveTunnels: serverRoutedCaps.maxActiveTunnelsPerSocket,
        });
        cleanupPeerTcpTunnelRelay = () => {
          cleanupRelaySubscription?.();
          cleanupRelaySubscription = null;
          cleanupPeerTcpTunnelRelay = null;
        };
      }
    }

    const liveStreamCaptureAdapter = params.peerMediationMachineRpc?.stream?.captureAdapter;
    if (liveStreamCaptureAdapter) {
      const liveStreamRelayTerminator = createMachineLiveStreamRelayTerminator({
        machineId: params.machineId,
        captureAdapter: liveStreamCaptureAdapter,
        nowMs: params.peerMediationMachineRpc?.nowMs ?? (() => Date.now()),
        emitEnvelope: (payload) => connectedApiMachine.sendMachineLiveStreamRelayEnvelope(payload),
      });
      cleanupMachineLiveStreamRelay = connectedApiMachine.onMachineLiveStreamRelayEnvelope((payload) => {
        if (payload.message.kind === 'start') {
          const startRequest = payload.message.startRequest as MachineLiveStreamStartRequestV1;
          void liveStreamRelayTerminator.start(startRequest).then((result) => {
            if (result.ok) return;
            logger.warn('[DAEMON RUN] Failed to start relayed live-stream capture source', {
              reasonCode: result.reasonCode,
              streamId: startRequest.streamId,
            });
          }).catch((error) => {
            logger.warn('[DAEMON RUN] Live-stream relay start handler failed', error);
          });
          return;
        }

        if (payload.message.kind !== 'control' && payload.message.kind !== 'sideband_control') return;
        const result = liveStreamRelayTerminator.applyControl(payload);
        if (result.ok) return;
        logger.warn('[DAEMON RUN] Live-stream relay control denied', {
          reasonCode: result.reasonCode,
          streamId: payload.message.control.streamId,
        });
      });
    }

    if (params.credentials) {
      const credentials = params.credentials;
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

    connectedApiMachine.onUpdate((update) => {
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
      const online = state.phase === 'online';
      params.setDaemonServerWorkOnline?.(online);
      if (online) {
        void Promise.resolve(params.onMachineConnectionOnline?.()).catch((error) => {
          logger.warn('[DAEMON RUN] Failed to wake quota persistence on machine reconnect', error);
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
    connectedApiMachine.connect({
      takeover: params.takeoverRequested,
      onConnect: async () => {
        if (params.isShuttingDown()) return;

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
          await connectedApiMachine
            .updateDaemonState((state) => mergePeerMediationLoopbackEndpoint(
              state,
              activePeerMediationLoopback.endpoint,
              activePeerMediationLoopback.activeFlows,
            ))
            .catch((error) => {
              logger.warn('[DAEMON RUN] Failed to publish peer mediation loopback endpoint', error);
            });
        }

        if (activeAutomationWorker) {
          const automationWorkerHandle = activeAutomationWorker;
          await automationWorkerHandle.refreshAssignments().catch((error) => {
            logger.warn('[DAEMON RUN] Failed to refresh automation assignments on machine reconnect', error);
          });
        }

        if (didRefreshMachineMetadata) return;
        didRefreshMachineMetadata = true;
        await connectedApiMachine
          .updateMachineMetadata((metadata) => {
            const base = (metadata ?? (params.machine.metadata as any) ?? {}) as any;
            const next: MachineMetadata = {
              ...base,
              host: params.preferredHost,
              platform: os.platform(),
              happyCliVersion: params.cliVersion,
              homeDir: os.homedir(),
              happyHomeDir: params.happyHomeDir,
              happyLibDir: params.happyLibDir,
            } as MachineMetadata;

            const current = base as Partial<MachineMetadata>;
            const isSame =
              current.host === next.host &&
              current.platform === next.platform &&
              current.happyCliVersion === next.happyCliVersion &&
              current.homeDir === next.homeDir &&
              current.happyHomeDir === next.happyHomeDir &&
              current.happyLibDir === next.happyLibDir;

            if (isSame) {
              return base as MachineMetadata;
            }

            return next;
          })
          .catch((error) => {
            didRefreshMachineMetadata = false;
            logger.warn('[DAEMON RUN] Failed to refresh machine metadata on reconnect', error);
          });
      },
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
    apiMachine: connectedApiMachine,
    apiMachineForSessions: connectedApiMachine,
    automationWorker,
    memoryWorker,
    voiceInferenceWorker,
    daemonConnectivityCoordinator,
    machineConnectionStateCleanup,
    stopPeerMediationLoopbackServer,
  };
}
