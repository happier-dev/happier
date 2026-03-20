import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { configuration } from '@/configuration';
import {
  type AgentRuntimeDescriptorV1,
  type MachineTransferReceiveEnvelope,
  type MachineTransferSendEnvelope,
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffStartRequest,
  type TransferEndpointCandidate,
  SessionHandoffAbortRequestSchema,
  SessionHandoffCommitRequestSchema,
  SessionHandoffPrepareTargetRequestSchema,
  type SessionHandoffResumePlan,
  type SessionHandoffWorkspaceTransfer,
  SessionHandoffStartRequestSchema,
  SessionHandoffStatusGetRequestSchema,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  registerServerRoutedTransferResponder,
  requestServerRoutedTransferPayload,
} from '../../machines/transfer/serverRoutedTransport';
import {
  requestTypedDirectPeerTransferPayload,
} from '../../machines/transfer/directPeerTransport';
import { createMachineTransferRouteCache } from '../../machines/transfer/transferRouteCache';
import {
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from '../../machines/transfer/transferPayloadSource';
import {
  resolveRequestedTypedTransferPayload,
  resolveTypedTransferPayloadDelivery,
} from '../../machines/transfer/typedTransferPayloadDelivery';
import {
  exportSessionHandoffState,
} from '../../session/handoff/exportSessionHandoffState';
import { importSessionHandoffProviderBundle } from '../../session/handoff/importSessionHandoffProviderBundle';
import { validateSessionHandoffWorkspaceTransferSourcePath } from '../../session/handoff/validateSessionHandoffWorkspaceTransferSourcePath';
import { validateSessionHandoffWorkspaceTransferStrategy } from '../../session/handoff/validateSessionHandoffWorkspaceTransferStrategy';
import {
  importSessionHandoffWorkspaceArtifacts,
} from '../../session/handoff/workspace/sessionHandoffWorkspaceArtifacts';
import type { ScmSourceControllerWorkspaceExportArtifacts } from '../../scm/sourceController/workspaceExportArtifacts';
import {
  createSessionHandoffTransferredBundles,
  createSessionHandoffTransferredBundlesCodec,
  createSessionHandoffTransferredBundlesPayloadSource,
  mergeSessionHandoffTransferredBundles,
  normalizeSessionHandoffTransferredBundles,
  sessionHandoffTransferredBundlesCodec,
  type SessionHandoffTransferredBundles,
} from '../../session/handoff/transfer/sessionHandoffTransferredBundles';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { SessionHandoffProviderBundle } from '../../session/handoff/types';
const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';

type StoredHandoffState = Readonly<{
  status: SessionHandoffStatus;
  transferredBundles?: SessionHandoffTransferredBundles;
  transferredPayloadSource?: TransferPayloadSource;
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
}>;

export type SessionHandoffDirectPeerTransferHandle = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: SessionHandoffTransferredBundles;
    payloadSource?: TransferPayloadSource;
  }>) => readonly TransferEndpointCandidate[];
  requestPayload?: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
  }>) => Promise<SessionHandoffTransferredBundles>;
  clearPublishedTransfer: (transferId: string) => void;
}>;

function buildSessionHandoffTransferId(handoffId: string): string {
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${handoffId}`;
}

function parseHandoffIdFromTransferId(transferId: string): string | null {
  if (!transferId.startsWith(SESSION_HANDOFF_TRANSFER_ID_PREFIX)) return null;
  const handoffId = transferId.slice(SESSION_HANDOFF_TRANSFER_ID_PREFIX.length).trim();
  return handoffId.length > 0 ? handoffId : null;
}

function resolveStoredTransferredBundles(
  current?: StoredHandoffState,
): SessionHandoffTransferredBundles | null {
  return current?.transferredBundles ?? null;
}

function resolveStoredTransferredPayloadSource(current?: StoredHandoffState): TransferPayloadSource | null {
  return current?.transferredPayloadSource ?? null;
}

function resolvePersistedTransferredBundles(params: Readonly<{
  current?: StoredHandoffState;
  transferredBundles: SessionHandoffTransferredBundles;
}>): SessionHandoffTransferredBundles {
  return mergeSessionHandoffTransferredBundles({
    current: resolveStoredTransferredBundles(params.current),
    incoming: params.transferredBundles,
  });
}

function invalidRequest() {
  return { ok: false, errorCode: 'invalid_request' } as const;
}

function buildStartRecoveryStatus(handoffId: string): SessionHandoffStatus {
  return {
    handoffId,
    status: 'awaiting_recovery',
    phase: 'preparing',
    recoveryActions: ['restart_on_source', 'keep_stopped'],
  };
}

function directPeerTransferUnavailable() {
  return {
    ok: false,
    errorCode: 'direct_peer_transfer_unavailable',
    error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
  } as const;
}

function createInvalidDirectPeerTransferResponseError(handoffId: string): Error {
  return new Error(`Invalid direct peer transfer response for ${handoffId}`);
}

function isDirectPeerTransferProtocolError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return error.message === 'Invalid session handoff transfer payload'
    || error.message.startsWith('Invalid direct peer transfer response for ');
}

function isServerRoutedTransferProtocolError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return error.message === 'Invalid session handoff transfer payload'
    || error.message.startsWith('Machine transfer manifest mismatch for ');
}

async function requestServerRoutedPrepareTransferredBundles(params: Readonly<{
  handoffId: string;
  sourceMachineId: string;
  machineTransferChannel: NonNullable<Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel']>;
}>): Promise<SessionHandoffTransferredBundles> {
  const payload = await requestServerRoutedTransferPayload({
    transferId: buildSessionHandoffTransferId(params.handoffId),
    sourceMachineId: params.sourceMachineId,
    machineTransferChannel: params.machineTransferChannel,
  });
  return sessionHandoffTransferredBundlesCodec.decode({
    transferId: buildSessionHandoffTransferId(params.handoffId),
    payload,
  });
}

const sessionHandoffDirectPeerTransferCodec = createSessionHandoffTransferredBundlesCodec({
  mapDecodeError: ({ transferId }) => createInvalidDirectPeerTransferResponseError(transferId),
});

type PrepareTransferredBundlesResolution = Readonly<{
  kind: 'resolved';
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  transferredBundles: SessionHandoffTransferredBundles;
}>;

type PrepareTransferredBundlesUnavailable = Readonly<{
  kind: 'unavailable';
  response: ReturnType<typeof directPeerTransferUnavailable>;
}>;

type StartTransferredPayloadDelivery = Readonly<{
  endpointCandidates: readonly TransferEndpointCandidate[];
}>;

async function resolvePrepareTransferredBundles(params: Readonly<{
  current?: StoredHandoffState;
  request: SessionHandoffPrepareTargetRequest;
  machineTransferChannel?: Parameters<typeof registerMachineSessionHandoffRpcHandlers>[0]['machineTransferChannel'];
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  transferRouteCache?: ReturnType<typeof createMachineTransferRouteCache>;
}>): Promise<PrepareTransferredBundlesResolution | PrepareTransferredBundlesUnavailable> {
  const resolved = await resolveRequestedTypedTransferPayload({
    transferId: params.request.handoffId,
    sourceMachineId: params.request.sourceMachineId,
    negotiatedTransportStrategy: params.request.negotiatedTransportStrategy,
    endpointCandidates: params.request.endpointCandidates,
    allowServerRoutedFallback: params.request.allowServerRoutedFallback !== false,
    storedPayload: resolveStoredTransferredBundles(params.current),
    requestDirectPeerPayload: async ({ transferId, endpointCandidates }) => {
      const directPeerRouteInput = {
        remoteMachineId: params.request.sourceMachineId,
        endpointCandidates,
      } as const;
      const cachedDirectPeerRoute = params.transferRouteCache?.readDirectPeerRoute(directPeerRouteInput);
      if (cachedDirectPeerRoute?.status === 'unavailable') {
        throw new Error(cachedDirectPeerRoute.failureReason);
      }
      const requestDirectPeerPayload = params.directPeerTransfer?.requestPayload ?? (async (requestParams: Readonly<{
        transferId: string;
        endpointCandidates: readonly TransferEndpointCandidate[];
      }>) =>
        await requestTypedDirectPeerTransferPayload({
          transferId: requestParams.transferId,
          endpointCandidates: requestParams.endpointCandidates,
          codec: sessionHandoffDirectPeerTransferCodec,
        }));
      try {
        const transferredBundles = normalizeSessionHandoffTransferredBundles(
          await requestDirectPeerPayload({
            transferId,
            endpointCandidates,
          }),
        );
        params.transferRouteCache?.recordDirectPeerRouteViable(directPeerRouteInput);
        return transferredBundles;
      } catch (error) {
        if (isDirectPeerTransferProtocolError(error)) {
          throw error;
        }
        params.transferRouteCache?.recordDirectPeerRouteUnavailable(
          directPeerRouteInput,
          'direct_peer_request_failed',
        );
        throw error;
      }
    },
    requestServerRoutedPayload: params.machineTransferChannel
      ? async ({ sourceMachineId }) =>
        await requestServerRoutedPrepareTransferredBundles({
          handoffId: params.request.handoffId,
          sourceMachineId,
          machineTransferChannel: params.machineTransferChannel!,
        })
      : null,
    isDirectPeerProtocolError: isDirectPeerTransferProtocolError,
    unavailableResponse: directPeerTransferUnavailable,
  });

  return resolved.kind === 'resolved'
    ? {
      kind: 'resolved',
      actualTransportStrategy: resolved.actualTransportStrategy,
      transferredBundles: resolved.payload,
    }
    : resolved;
}

function resolveStartTransferredPayloadDelivery(params: Readonly<{
  negotiatedTransportStrategy: SessionHandoffStartRequest['negotiatedTransportStrategy'];
  transferredBundles: SessionHandoffTransferredBundles;
  transferredPayloadSource?: TransferPayloadSource;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  handoffId: string;
}>): StartTransferredPayloadDelivery {
  const negotiatedTransportStrategy = params.negotiatedTransportStrategy ?? 'direct_peer';
  const delivery = resolveTypedTransferPayloadDelivery({
    transferId: params.handoffId,
    negotiatedTransportStrategy,
    payload: params.transferredBundles,
    payloadSource: params.transferredPayloadSource,
    directPeerTransfer: params.directPeerTransfer,
  });
  return {
    endpointCandidates: delivery.endpointCandidates,
  };
}

export function registerMachineSessionHandoffRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  loadSessionMetadata?: (sessionId: string) => Promise<Record<string, unknown> | null>;
  stopSessionForHandoff?: (sessionId: string) => Promise<'stopped' | 'already_inactive' | 'failed'>;
  exportSessionBundle?: (metadata: Record<string, unknown>, workspaceTransfer?: SessionHandoffWorkspaceTransfer) => Promise<Readonly<{
    providerBundle: SessionHandoffProviderBundle;
    targetPath: string;
    workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
  }>>;
  importSessionBundle?: (bundle: SessionHandoffProviderBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') => Promise<Readonly<{
    remoteSessionId: string;
    directSource: Record<string, unknown>;
    agentRuntimeDescriptorV1?: AgentRuntimeDescriptorV1;
    resume: SessionHandoffResumePlan;
  }>>;
  importWorkspaceBundle?: (params: Readonly<{
    workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
    targetPath: string;
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  }>) => Promise<Readonly<{ targetPath: string }>>;
  machineTransferChannel?: Readonly<{
    onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
    sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
  }>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
}>): void {
  const store = new Map<string, StoredHandoffState>();
  const { rpcHandlerManager } = params;
  const transferRouteCache = createMachineTransferRouteCache({
    serverId: configuration.activeServerId,
  });
  const loadSessionMetadata =
    params.loadSessionMetadata ??
    (async (sessionId: string): Promise<Record<string, unknown> | null> => {
      const [{ readCredentials }, { fetchSessionById }, { tryDecryptSessionMetadata }] = await Promise.all([
        import('../../persistence'),
        import('../../sessionControl/sessionsHttp'),
        import('../../sessionControl/sessionEncryptionContext'),
      ]);
      const credentials = await readCredentials().catch(() => null);
      if (!credentials) return null;
      const rawSession = await fetchSessionById({ token: credentials.token, sessionId }).catch(() => null);
      if (!rawSession) return null;
      const metadata = tryDecryptSessionMetadata({ credentials, rawSession });
      return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : null;
    });
  const exportSessionBundle =
    params.exportSessionBundle ??
    (async (metadata: Record<string, unknown>, workspaceTransfer?: SessionHandoffWorkspaceTransfer) => {
      return await exportSessionHandoffState({
        metadata,
        activeServerDir: configuration.activeServerDir,
        workspaceTransfer,
      });
    });
  const importSessionBundle =
    params.importSessionBundle ??
    (async (bundle: SessionHandoffProviderBundle, targetPath: string, sessionStorageMode: 'direct' | 'persisted') =>
      await importSessionHandoffProviderBundle({
        bundle,
        targetPath,
        sessionStorageMode,
      }));
  const importWorkspaceBundle =
    params.importWorkspaceBundle ??
    (async (workspaceParams: Readonly<{
      workspaceExportArtifacts?: ScmSourceControllerWorkspaceExportArtifacts;
      targetPath: string;
      workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    }>) =>
      await importSessionHandoffWorkspaceArtifacts(workspaceParams));

  if (params.machineTransferChannel) {
    registerServerRoutedTransferResponder({
      machineTransferChannel: params.machineTransferChannel,
      loadTransferPayloadSource: (transferId) => {
        const handoffId = parseHandoffIdFromTransferId(transferId);
        if (!handoffId) return null;
        return resolveStoredTransferredPayloadSource(store.get(handoffId));
      },
    });
  }

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_START, async (raw: unknown) => {
    const parsed = SessionHandoffStartRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const metadata = await loadSessionMetadata(parsed.data.sessionId);
    if (!metadata) {
      return { ok: false, errorCode: 'session_not_found' } as const;
    }
    const workspaceTransferValidation = validateSessionHandoffWorkspaceTransferSourcePath({
      metadata,
      fallbackSourceHomeDir: os.homedir(),
      workspaceTransfer: parsed.data.workspaceTransfer,
    });
    if (!workspaceTransferValidation.ok) {
      return workspaceTransferValidation;
    }
    const workspaceTransferStrategyValidation = validateSessionHandoffWorkspaceTransferStrategy({
      workspaceTransfer: parsed.data.workspaceTransfer,
    });
    if (!workspaceTransferStrategyValidation.ok) {
      return workspaceTransferStrategyValidation;
    }

    const handoffId = `handoff_${randomUUID()}`;
    const sourceStopState = params.stopSessionForHandoff
      ? await params.stopSessionForHandoff(parsed.data.sessionId)
      : 'already_inactive';
    if (sourceStopState === 'failed') {
      return {
        ok: false,
        errorCode: 'source_stop_failed',
        error: 'Failed to stop the active source session before handoff cutover',
      } as const;
    }
    let transferredPayloadSource: TransferPayloadSource | null = null;
    try {
      const exported = await exportSessionBundle(metadata, parsed.data.workspaceTransfer);
      const transferredBundles = normalizeSessionHandoffTransferredBundles(exported);
      transferredPayloadSource = await createSessionHandoffTransferredBundlesPayloadSource(transferredBundles);

      const status: SessionHandoffStatus = {
        handoffId,
        status: 'pending',
        phase: 'preparing',
        recoveryActions: sourceStopState === 'stopped' ? ['restart_on_source', 'keep_stopped'] : [],
      };
      store.set(handoffId, {
        status,
        transferredBundles,
        transferredPayloadSource,
        workspaceTransfer: parsed.data.workspaceTransfer,
      });
      const startTransferredPayloadDelivery = resolveStartTransferredPayloadDelivery({
        negotiatedTransportStrategy: parsed.data.negotiatedTransportStrategy,
        transferredBundles,
        transferredPayloadSource,
        directPeerTransfer: params.directPeerTransfer,
        handoffId,
      });

      return {
        handoffId,
        status,
        endpointCandidates: startTransferredPayloadDelivery.endpointCandidates,
        targetPath: exported.targetPath,
      };
    } catch (error) {
      await disposeTransferPayloadSource(transferredPayloadSource);
      const errorMessage = error instanceof Error ? error.message : 'Failed to export session handoff state';
      if (sourceStopState !== 'stopped') {
        return {
          ok: false,
          errorCode: 'source_export_failed',
          error: errorMessage,
        } as const;
      }
      const status = buildStartRecoveryStatus(handoffId);
      store.set(handoffId, {
        status,
        workspaceTransfer: parsed.data.workspaceTransfer,
      });
      return {
        ok: false,
        errorCode: 'source_export_failed',
        error: errorMessage,
        handoffId,
        status,
      } as const;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET, async (raw: unknown) => {
    const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    const prepareResolution = await resolvePrepareTransferredBundles({
      current,
      request: parsed.data,
      machineTransferChannel: params.machineTransferChannel,
      directPeerTransfer: params.directPeerTransfer,
      transferRouteCache,
    });
    if (prepareResolution.kind === 'unavailable') {
      return prepareResolution.response;
    }
    const { actualTransportStrategy, transferredBundles } = prepareResolution;
    if (!transferredBundles?.providerBundle) return invalidRequest();

    const readyForCutoverStatus: SessionHandoffStatus = {
      ...(current?.status ?? {
        handoffId: parsed.data.handoffId,
        status: 'pending',
        phase: 'preparing',
        recoveryActions: [],
      }),
      status: 'ready_for_cutover',
      phase: 'staging_target',
      transportStrategy: actualTransportStrategy,
    };
    const stagedTargetStatus: SessionHandoffStatus = {
      ...readyForCutoverStatus,
      status: 'pending',
    };
    const persistedTransferredBundles = resolvePersistedTransferredBundles({
      current,
      transferredBundles,
    });
    store.set(parsed.data.handoffId, {
      ...(current ?? {}),
      status: stagedTargetStatus,
      transferredBundles: persistedTransferredBundles,
      workspaceTransfer: current?.workspaceTransfer ?? parsed.data.workspaceTransfer,
    });
    try {
      const importedWorkspace = await importWorkspaceBundle({
        ...(persistedTransferredBundles.workspaceExportArtifacts
          ? { workspaceExportArtifacts: persistedTransferredBundles.workspaceExportArtifacts }
          : {}),
        targetPath: parsed.data.targetPath,
        workspaceTransfer: parsed.data.workspaceTransfer ?? current?.workspaceTransfer,
      });
      const imported = await importSessionBundle(
        persistedTransferredBundles.providerBundle,
        importedWorkspace.targetPath,
        parsed.data.targetSessionStorageMode === 'persisted'
          ? 'persisted'
          : parsed.data.sourceSessionStorageMode === 'persisted'
            ? 'persisted'
            : 'direct',
      );
      store.set(parsed.data.handoffId, {
        ...(store.get(parsed.data.handoffId) ?? {}),
        status: readyForCutoverStatus,
      });

      return {
        handoffId: parsed.data.handoffId,
        status: readyForCutoverStatus,
        remoteSessionId: imported.remoteSessionId,
        directSource: imported.directSource,
        ...(imported.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: imported.agentRuntimeDescriptorV1 } : {}),
        resume: imported.resume,
      };
    } catch (error) {
      store.set(parsed.data.handoffId, {
        ...(store.get(parsed.data.handoffId) ?? {}),
        status: {
          ...stagedTargetStatus,
          status: 'awaiting_recovery',
        },
      });
      throw error;
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, async (raw: unknown) => {
    const parsed = SessionHandoffCommitRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    if (!current) return { ok: false, errorCode: 'not_found' } as const;

    const status: SessionHandoffStatus = {
      ...current.status,
      status: 'completed',
      phase: 'finalizing',
    };
    params.directPeerTransfer?.clearPublishedTransfer(parsed.data.handoffId);
    await disposeTransferPayloadSource(resolveStoredTransferredPayloadSource(current));
    store.set(parsed.data.handoffId, { status });
    return { handoffId: parsed.data.handoffId, status };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, async (raw: unknown) => {
    const parsed = SessionHandoffAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    if (!current) return { ok: false, errorCode: 'not_found' } as const;

    const status: SessionHandoffStatus = {
      ...current.status,
      status: 'aborted',
      phase: current.status.phase,
    };
    params.directPeerTransfer?.clearPublishedTransfer(parsed.data.handoffId);
    await disposeTransferPayloadSource(resolveStoredTransferredPayloadSource(current));
    store.set(parsed.data.handoffId, { status });
    return { handoffId: parsed.data.handoffId, status };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, async (raw: unknown) => {
    const parsed = SessionHandoffStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidRequest();

    const current = store.get(parsed.data.handoffId);
    if (!current) return { ok: false, errorCode: 'not_found' } as const;

    return { handoffId: parsed.data.handoffId, status: current.status };
  });
}
