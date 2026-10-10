import type {
  SessionHandoffMetadataV2,
  SessionHandoffPrepareTargetRequest,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import { copyFile } from 'node:fs/promises';
import { materializeWorkspaceSyncSeedExport } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { materializeWorkspaceExportArtifactsWithScmWorkspace } from '@/scm/workspace/workspaceExportMaterialization';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import type { SessionHandoffSourceExportRecord } from '@/session/handoff/state/sessionHandoffSourceExportStore';

import {
  type DirectPeerOnDemandTransferScope,
  isDirectPeerTransferProtocolError,
} from '../../../machines/transfer/directPeerTransport';
import { requestDirectPeerTransferToFileWithRetry } from '../../../machines/transfer/requestDirectPeerTransferToFileWithRetry';
import {
  type MachineTransferChannel,
  requestServerRoutedTransferToFile,
} from '../../../machines/transfer/serverRoutedTransport';
import { createMachineTransferRouteCache } from '../../../machines/transfer/transferRouteCache';
import { createFileTransferPayloadSource, resolveTransferPayloadSizeBytes, resolveTransferPayloadManifestHash, type TransferPayloadSource } from '../../../machines/transfer/transferPayloadSource';
import { readSessionHandoffAgentBundleFile } from '../../../session/handoff/agentBundle/file';
import {
  buildSessionHandoffAgentBundleTransferId,
  buildSessionHandoffWorkspaceSeedTransferId,
} from '../../../session/handoff/agentBundle/transferPublication';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';

export type SessionHandoffDirectPeerTransferHandle = Readonly<{
  publishTransfer: (input: Readonly<{
    transferId: string;
    payload: Readonly<Record<never, never>>;
    payloadSource?: TransferPayloadSource;
    onDemandScope?: DirectPeerOnDemandTransferScope;
  }>) => readonly TransferEndpointCandidate[] | Promise<readonly TransferEndpointCandidate[]>;
  requestPayloadFile?: (input: Readonly<{
    transferId: string;
    endpointCandidates: readonly TransferEndpointCandidate[];
    destinationPath: string;
    expectedSizeBytes?: number;
    expectedManifestHash?: string;
    openBody?: unknown;
    timeoutMs?: number;
    onProgress?: (receivedBytes: number) => Promise<void> | void;
  }>) => Promise<Readonly<{ destinationPath: string }>>;
  clearPublishedTransfer: (transferId: string) => void;
}>;

export function directPeerTransferUnavailable() {
  return {
    ok: false,
    errorCode: 'direct_peer_transfer_unavailable',
    error: 'Direct peer transfer is unavailable and server-routed fallback is disabled',
  } as const;
}

export function canUseDirectPeerForSessionHandoffAgentBundle(input: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  directPeerRequesterAvailable: boolean;
  hasLocalAgentBundle: boolean;
  localAgentBundleEndpointCandidates?: readonly TransferEndpointCandidate[];
  nowMs: number;
}>): boolean {
  const endpointCandidates =
    input.request.handoffMetadataV2?.agentBundleTransferPublication?.endpointCandidates
    ?? input.localAgentBundleEndpointCandidates
    ?? input.request.endpointCandidates;
  return input.hasLocalAgentBundle
    || (input.directPeerRequesterAvailable
      && endpointCandidates.some((candidate) => candidate.expiresAt >= input.nowMs));
}

/** Shared seed materialization below WorkspaceRef admission, carried by handoff's existing transports. */
export async function materializePrepareManagedWorkspaceSeed(params: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  targetPath: string;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  localSourceExport: SessionHandoffSourceExportRecord | null;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  transferTimeoutMs?: number;
  assertCanContinue(): Promise<void>;
}>): Promise<void> {
  const publication = params.request.handoffMetadataV2?.workspaceSeedTransferPublication;
  const transferId = buildSessionHandoffWorkspaceSeedTransferId(params.request.handoffId);
  if (!publication || publication.transferId !== transferId) throw new Error('Managed handoff workspace seed publication is unavailable');
  const custody = await materializeWorkspaceSyncSeedExport({ operationId: transferId, targetPath: params.targetPath,
    requestPayload: async (request) => {
      await params.assertCanContinue();
      const expectedSizeBytes = request.transferId === transferId ? publication.sizeBytes : request.expectedSizeBytes;
      const expectedManifestHash = request.transferId === transferId ? publication.manifestHash : request.expectedManifestHash;
      const files = params.localSourceExport?.workspaceSeed?.files;
      const local = files && Object.hasOwn(files, request.transferId) ? files[request.transferId] : undefined;
      if (local) {
        await copyFile(local.filePath, request.destinationPath);
      } else {
        let transferred = false;
        if (params.actualTransportStrategy === 'direct_peer' && params.directPeerTransfer?.requestPayloadFile) {
          try {
            await requestDirectPeerTransferToFileWithRetry({
              requestTransferToFile: params.directPeerTransfer.requestPayloadFile,
              transferId: request.transferId, destinationPath: request.destinationPath,
              endpointCandidates: publication.endpointCandidates ?? params.request.endpointCandidates,
              expectedSizeBytes, expectedManifestHash,
              ...(params.transferTimeoutMs === undefined ? {} : { timeoutMs: params.transferTimeoutMs }),
              onRetry: params.assertCanContinue,
            });
            transferred = true;
          } catch (error) {
            if (isSessionHandoffDirectPeerProtocolError(error)
              || params.request.allowServerRoutedFallback === false || !params.machineTransferChannel) throw error;
          }
        }
        if (!transferred) {
          if (!params.machineTransferChannel) throw new Error(directPeerTransferUnavailable().error);
          await requestServerRoutedTransferToFile({ transferId: request.transferId,
            sourceMachineId: params.request.sourceMachineId, destinationPath: request.destinationPath,
            machineTransferChannel: params.machineTransferChannel,
            ...(params.transferTimeoutMs === undefined ? {} : { timeoutMs: params.transferTimeoutMs,
              openBody: { t: 'session_handoff_prepare_v1', timeoutMs: params.transferTimeoutMs },
            }),
          });
        }
      }
      const received = createFileTransferPayloadSource({ filePath: request.destinationPath });
      if (expectedSizeBytes !== undefined && await resolveTransferPayloadSizeBytes(received) !== expectedSizeBytes
        || expectedManifestHash !== undefined && await resolveTransferPayloadManifestHash(received) !== expectedManifestHash) {
        throw new Error('Managed handoff workspace seed integrity mismatch');
      }
      await params.assertCanContinue();
    },
    materializeWorkspaceExportArtifacts: async (request) => await materializeWorkspaceExportArtifactsWithScmWorkspace({
      ...request, assertCanContinue: params.assertCanContinue,
    }),
  });
  try {
    await params.assertCanContinue();
    await custody.bindPromotedTarget();
    await ensureProtectedLocalStateDirectory(params.targetPath, { authority: 'owned' });
    await custody.commit();
  } catch (error) { await custody.abort(); throw error; }
}

export function isSessionHandoffDirectPeerProtocolError(error: unknown): boolean {
  if (isDirectPeerTransferProtocolError(error)) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === 'Invalid session handoff transfer payload'
    || error.message.startsWith('Direct peer transfer manifest mismatch for ');
}

async function requestServerRoutedPrepareAgentBundle(params: Readonly<{
  transferId: string;
  sourceMachineId: string;
  destinationPath: string;
  machineTransferChannel: MachineTransferChannel;
  transferTimeoutMs?: number;
  onProgress?: (receivedBytes: number) => Promise<void> | void;
}>): Promise<SessionHandoffAgentBundle> {
  const timeoutMs = params.transferTimeoutMs;
  const openBody =
    typeof timeoutMs === 'number'
      ? {
        t: 'session_handoff_prepare_v1',
        timeoutMs,
      }
      : undefined;

  await requestServerRoutedTransferToFile({
    transferId: params.transferId,
    sourceMachineId: params.sourceMachineId,
    machineTransferChannel: params.machineTransferChannel,
    destinationPath: params.destinationPath,
    ...(openBody ? { openBody } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(params.onProgress ? { onProgress: params.onProgress } : {}),
  });
  return await readSessionHandoffAgentBundleFile(params.destinationPath);
}

export async function resolvePrepareAgentBundle(params: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  handoffMetadataV2?: SessionHandoffMetadataV2;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  transferRouteCache?: ReturnType<typeof createMachineTransferRouteCache>;
  transferTimeoutMs?: number;
  invalidateDirectPeerRouteCacheForHandoffMachines?: (machineIds: readonly (string | undefined)[]) => void;
  receivedAgentBundlePath: string;
  onProgress?: (receivedBytes: number) => Promise<void> | void;
  signal?: AbortSignal;
  /** A locally exported bundle may still use the carrier admission gate. */
  existingAgentBundle?: SessionHandoffAgentBundle;
}>): Promise<SessionHandoffAgentBundle | undefined> {
  const transferPublication = params.handoffMetadataV2?.agentBundleTransferPublication;
  if (params.existingAgentBundle) {
    return params.existingAgentBundle;
  }
  if (!transferPublication) {
    if (params.actualTransportStrategy === 'server_routed_stream' && params.machineTransferChannel) {
      return await requestServerRoutedPrepareAgentBundle({
        transferId: buildSessionHandoffAgentBundleTransferId(params.request.handoffId),
        sourceMachineId: params.request.sourceMachineId,
        destinationPath: params.receivedAgentBundlePath,
        machineTransferChannel: params.machineTransferChannel,
        transferTimeoutMs: params.transferTimeoutMs,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
      });
    }
    return undefined;
  }
  const transferEndpointCandidates = transferPublication.endpointCandidates ?? params.request.endpointCandidates;
  const allowServerRoutedFallback = params.request.allowServerRoutedFallback !== false;
  const canFallbackToServerRouted = allowServerRoutedFallback
    && params.machineTransferChannel !== undefined;

  const agentBundle =
    params.actualTransportStrategy === 'server_routed_stream' && params.machineTransferChannel
      ? await requestServerRoutedPrepareAgentBundle({
        transferId: transferPublication.transferId,
        sourceMachineId: params.request.sourceMachineId,
        destinationPath: params.receivedAgentBundlePath,
        machineTransferChannel: params.machineTransferChannel,
        transferTimeoutMs: params.transferTimeoutMs,
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
      })
      : params.actualTransportStrategy === 'direct_peer'
        && transferEndpointCandidates
        && params.directPeerTransfer?.requestPayloadFile
        ? await (async (): Promise<SessionHandoffAgentBundle> => {
          const endpointCandidates = transferEndpointCandidates.filter((candidate) => candidate.expiresAt >= Date.now());
          if (endpointCandidates.length === 0) {
            if (canFallbackToServerRouted && params.machineTransferChannel) {
              return await requestServerRoutedPrepareAgentBundle({
                transferId: transferPublication.transferId,
                sourceMachineId: params.request.sourceMachineId,
                destinationPath: params.receivedAgentBundlePath,
                machineTransferChannel: params.machineTransferChannel,
                transferTimeoutMs: params.transferTimeoutMs,
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
              });
            }
            throw new Error(directPeerTransferUnavailable().error);
          }
          params.invalidateDirectPeerRouteCacheForHandoffMachines?.([
            params.request.sourceMachineId,
            params.request.targetMachineId,
          ]);
          const cachedRoute = params.transferRouteCache?.readDirectPeerRoute({
            remoteMachineId: params.request.sourceMachineId,
            endpointCandidates,
          });
          if (cachedRoute?.status === 'unavailable') {
            if (canFallbackToServerRouted && params.machineTransferChannel) {
              return await requestServerRoutedPrepareAgentBundle({
                transferId: transferPublication.transferId,
                sourceMachineId: params.request.sourceMachineId,
                destinationPath: params.receivedAgentBundlePath,
                machineTransferChannel: params.machineTransferChannel,
                transferTimeoutMs: params.transferTimeoutMs,
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
              });
            }
            throw new Error(directPeerTransferUnavailable().error);
          }
          const timeoutMs = params.transferTimeoutMs;
          try {
              await requestDirectPeerTransferToFileWithRetry({
                requestTransferToFile: params.directPeerTransfer!.requestPayloadFile!,
                transferId: transferPublication.transferId,
                endpointCandidates,
                destinationPath: params.receivedAgentBundlePath,
                expectedSizeBytes: transferPublication.sizeBytes,
                expectedManifestHash: transferPublication.manifestHash,
                ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
                maxAttempts: 8,
                retryDelayMs: 250,
                onRetry: async () => {
                  params.invalidateDirectPeerRouteCacheForHandoffMachines?.([
                    params.request.sourceMachineId,
                    params.request.targetMachineId,
                  ]);
                },
              });
              params.transferRouteCache?.recordDirectPeerRouteViable({
                remoteMachineId: params.request.sourceMachineId,
                endpointCandidates,
              });
              return await readSessionHandoffAgentBundleFile(params.receivedAgentBundlePath);
            } catch (error) {
              if (isSessionHandoffDirectPeerProtocolError(error)) {
                throw error;
              }
              params.transferRouteCache?.recordDirectPeerRouteUnavailable(
                {
                  remoteMachineId: params.request.sourceMachineId,
                  endpointCandidates,
                },
                error instanceof Error ? error.message : 'Direct peer transfer failed',
              );
              if (canFallbackToServerRouted && params.machineTransferChannel) {
                return await requestServerRoutedPrepareAgentBundle({
                  transferId: transferPublication.transferId,
                  sourceMachineId: params.request.sourceMachineId,
                  destinationPath: params.receivedAgentBundlePath,
                  machineTransferChannel: params.machineTransferChannel,
                  transferTimeoutMs: params.transferTimeoutMs,
                  ...(params.onProgress ? { onProgress: params.onProgress } : {}),
                });
              }
              throw new Error(directPeerTransferUnavailable().error);
            }
        })()
        : undefined;

  if (!agentBundle) {
    return undefined;
  }

  return agentBundle;
}
