import type {
  SessionHandoffMetadataV2,
  SessionHandoffPrepareTargetRequest,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';

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
import type { TransferPayloadSource } from '../../../machines/transfer/transferPayloadSource';
import { readSessionHandoffAgentBundleFile } from '../../../session/handoff/agentBundle/file';
import {
  buildSessionHandoffAgentBundleTransferId,
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
}>): Promise<SessionHandoffAgentBundle | undefined> {
  const transferPublication = params.handoffMetadataV2?.agentBundleTransferPublication;
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
  const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;

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
