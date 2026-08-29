import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type {
  SessionHandoffMetadataV2,
  SessionHandoffPrepareTargetRequest,
  SessionHandoffWorkspaceTransfer,
  TransferEndpointCandidate,
  WorkspaceManifest,
} from '@happier-dev/protocol';

import {
  type DirectPeerOnDemandTransferScope,
  isDirectPeerTransferProtocolError,
} from '../../../machines/transfer/directPeerTransport';
import { requestDirectPeerTransferToFileWithRetry } from '../../../machines/transfer/requestDirectPeerTransferToFileWithRetry';
import { rewriteDirectPeerEndpointCandidatesForTransferId } from '../../../machines/transfer/rewriteDirectPeerEndpointCandidatesForTransferId';
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
import {
  type SessionHandoffWorkspaceReplicationMetadata,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';
import {
  buildSessionHandoffWorkspaceManifestTransferId,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/serverRouted';
import { readWorkspaceReplicationManifestFromFile } from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/manifestFile';

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

async function requestDirectPeerPayloadFileWithWorkspaceRetry(params: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  destinationPath: string;
  expectedSizeBytes?: number;
  expectedManifestHash?: string;
  timeoutMs?: number;
  onProgress?: (receivedBytes: number) => Promise<void> | void;
  directPeerTransfer: SessionHandoffDirectPeerTransferHandle;
  invalidateDirectPeerRouteCacheForHandoffMachines?: (machineIds: readonly (string | undefined)[]) => void;
}>): Promise<Readonly<{ destinationPath: string }>> {
  if (params.request.workspaceTransfer?.enabled !== true) {
    const requestPayloadFile = params.directPeerTransfer.requestPayloadFile;
    if (!requestPayloadFile) {
      throw new Error(directPeerTransferUnavailable().error);
    }
    return await requestPayloadFile({
      transferId: params.transferId,
      endpointCandidates: params.endpointCandidates,
      destinationPath: params.destinationPath,
      ...(typeof params.expectedSizeBytes === 'number'
        ? { expectedSizeBytes: params.expectedSizeBytes }
        : {}),
      ...(typeof params.expectedManifestHash === 'string'
        ? { expectedManifestHash: params.expectedManifestHash }
        : {}),
      ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.onProgress ? { onProgress: params.onProgress } : {}),
    });
  }

  const maxAttempts = params.request.workspaceTransfer?.strategy === 'transfer_snapshot' ? 12 : 8;
  const retryDelayMs = 250;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestPayloadFile = params.directPeerTransfer.requestPayloadFile;
    if (requestPayloadFile) {
      return await requestDirectPeerTransferToFileWithRetry({
        requestTransferToFile: requestPayloadFile,
        transferId: params.transferId,
        endpointCandidates: params.endpointCandidates,
        destinationPath: params.destinationPath,
        ...(typeof params.expectedSizeBytes === 'number'
          ? { expectedSizeBytes: params.expectedSizeBytes }
          : {}),
        ...(typeof params.expectedManifestHash === 'string'
          ? { expectedManifestHash: params.expectedManifestHash }
          : {}),
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
        maxAttempts,
        retryDelayMs: 250,
        onRetry: async () => {
          params.invalidateDirectPeerRouteCacheForHandoffMachines?.([
            params.request.sourceMachineId,
            params.request.targetMachineId,
          ]);
        },
      });
    }

    if (attempt >= maxAttempts) {
      break;
    }

    params.invalidateDirectPeerRouteCacheForHandoffMachines?.([
      params.request.sourceMachineId,
      params.request.targetMachineId,
    ]);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, retryDelayMs * attempt);
    });
  }

  throw new Error(directPeerTransferUnavailable().error);
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
        && (params.request.workspaceTransfer?.enabled === true || params.directPeerTransfer?.requestPayloadFile)
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
          if (params.request.workspaceTransfer?.enabled === true) {
            params.invalidateDirectPeerRouteCacheForHandoffMachines?.([
              params.request.sourceMachineId,
              params.request.targetMachineId,
            ]);
          }
          const cachedRoute = params.transferRouteCache?.readDirectPeerRoute({
            remoteMachineId: params.request.sourceMachineId,
            endpointCandidates,
          });
          if (cachedRoute?.status === 'unavailable' && params.request.workspaceTransfer?.enabled !== true) {
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
              await requestDirectPeerPayloadFileWithWorkspaceRetry({
                request: params.request,
                transferId: transferPublication.transferId,
                endpointCandidates,
                destinationPath: params.receivedAgentBundlePath,
                expectedSizeBytes: transferPublication.sizeBytes,
                expectedManifestHash: transferPublication.manifestHash,
                ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                directPeerTransfer: params.directPeerTransfer!,
                ...(params.onProgress ? { onProgress: params.onProgress } : {}),
                invalidateDirectPeerRouteCacheForHandoffMachines: params.invalidateDirectPeerRouteCacheForHandoffMachines,
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

export async function resolvePrepareWorkspaceReplicationMetadata(params: Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  actualTransportStrategy: SessionHandoffPrepareTargetRequest['negotiatedTransportStrategy'];
  workspaceTransfer?: SessionHandoffWorkspaceTransfer;
  handoffMetadataV2?: SessionHandoffMetadataV2;
  machineTransferChannel?: MachineTransferChannel;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  transferTimeoutMs?: number;
  invalidateDirectPeerRouteCacheForHandoffMachines?: (machineIds: readonly (string | undefined)[]) => void;
}>): Promise<SessionHandoffWorkspaceReplicationMetadata | undefined> {
  if (params.workspaceTransfer?.enabled !== true) {
    return undefined;
  }

  const transferPublication = params.handoffMetadataV2?.workspaceReplicationManifestTransferPublication;
  const sourceRootPath = params.handoffMetadataV2?.workspaceReplicationSourceRootPath;
  if (!transferPublication || !sourceRootPath) {
    return undefined;
  }

  const manifest =
    params.actualTransportStrategy === 'server_routed_stream' && params.machineTransferChannel
      ? await (async (): Promise<WorkspaceManifest> => {
        const machineTransferChannel = params.machineTransferChannel;
        if (!machineTransferChannel) {
          throw new Error(`Server-routed transfer is unavailable for ${transferPublication.transferId}`);
        }
        const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-server-routed-'));
        const payloadFilePath = join(temporaryDirectory, 'workspace-manifest.txt');
        try {
          const timeoutMs = params.transferTimeoutMs;
          const openBody =
            typeof timeoutMs === 'number'
              ? {
                t: 'session_handoff_prepare_v1',
                timeoutMs,
              }
              : undefined;
          const received = await requestServerRoutedTransferToFile({
            transferId: transferPublication.transferId,
            sourceMachineId: params.request.sourceMachineId,
            machineTransferChannel,
            destinationPath: payloadFilePath,
            ...(openBody ? { openBody } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          });
          return await readWorkspaceReplicationManifestFromFile({
            transferId: transferPublication.transferId,
            filePath: received.destinationPath,
            sizeBytes: received.sizeBytes,
          });
        } finally {
          await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      })()
      : params.actualTransportStrategy === 'direct_peer'
        ? await (async (): Promise<WorkspaceManifest> => {
          const endpointCandidates =
            transferPublication.endpointCandidates
            ?? (params.request.endpointCandidates.length
              ? rewriteDirectPeerEndpointCandidatesForTransferId({
                endpointCandidates: params.request.endpointCandidates,
                transferId: transferPublication.transferId,
              })
              : undefined);
          if (!endpointCandidates?.length) {
            throw new Error(`Direct peer transfer is unavailable for ${transferPublication.transferId}`);
          }
          const filteredEndpointCandidates = endpointCandidates.filter((candidate) => candidate.expiresAt >= Date.now());
          const allowServerRoutedFallback = params.request.allowServerRoutedFallback !== false;
          const canFallbackToServerRouted = allowServerRoutedFallback && params.machineTransferChannel !== undefined;
          const timeoutMs = params.transferTimeoutMs;
          if (params.request.workspaceTransfer?.enabled === true) {
            params.invalidateDirectPeerRouteCacheForHandoffMachines?.([
              params.request.sourceMachineId,
              params.request.targetMachineId,
            ]);
          }
          if (filteredEndpointCandidates.length === 0) {
            if (canFallbackToServerRouted && params.machineTransferChannel) {
              const temporaryServerRoutedDirectory =
                await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-server-routed-'));
              const serverRoutedPath = join(temporaryServerRoutedDirectory, 'workspace-manifest.txt');
              try {
                const openBody =
                  typeof timeoutMs === 'number'
                    ? {
                      t: 'session_handoff_prepare_v1',
                      timeoutMs,
                    }
                    : undefined;
                const received = await requestServerRoutedTransferToFile({
                  transferId: transferPublication.transferId,
                  sourceMachineId: params.request.sourceMachineId,
                  machineTransferChannel: params.machineTransferChannel,
                  destinationPath: serverRoutedPath,
                  ...(openBody ? { openBody } : {}),
                  ...(timeoutMs ? { timeoutMs } : {}),
                });
                return await readWorkspaceReplicationManifestFromFile({
                  transferId: transferPublication.transferId,
                  filePath: received.destinationPath,
                  sizeBytes: received.sizeBytes,
                });
              } finally {
                await rm(temporaryServerRoutedDirectory, { recursive: true, force: true }).catch(() => undefined);
              }
            }
            throw new Error(directPeerTransferUnavailable().error);
          }
          const temporaryDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-direct-peer-'));
          const payloadFilePath = join(temporaryDirectory, 'workspace-manifest.txt');
          try {
            try {
              const received = await requestDirectPeerPayloadFileWithWorkspaceRetry({
                request: params.request,
                transferId: transferPublication.transferId,
                endpointCandidates: filteredEndpointCandidates,
                destinationPath: payloadFilePath,
                ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
                directPeerTransfer: params.directPeerTransfer!,
                invalidateDirectPeerRouteCacheForHandoffMachines: params.invalidateDirectPeerRouteCacheForHandoffMachines,
              });
              return await readWorkspaceReplicationManifestFromFile({
                transferId: transferPublication.transferId,
                filePath: received.destinationPath,
              });
            } catch (error) {
              if (isSessionHandoffDirectPeerProtocolError(error)) {
                throw error;
              }
              if (canFallbackToServerRouted && params.machineTransferChannel) {
                const temporaryServerRoutedDirectory =
                  await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-manifest-server-routed-'));
                const serverRoutedPath = join(temporaryServerRoutedDirectory, 'workspace-manifest.txt');
                try {
                  const openBody =
                    typeof timeoutMs === 'number'
                      ? {
                        t: 'session_handoff_prepare_v1',
                        timeoutMs,
                      }
                      : undefined;
                  const received = await requestServerRoutedTransferToFile({
                    transferId: transferPublication.transferId,
                    sourceMachineId: params.request.sourceMachineId,
                    machineTransferChannel: params.machineTransferChannel,
                    destinationPath: serverRoutedPath,
                    ...(openBody ? { openBody } : {}),
                    ...(timeoutMs ? { timeoutMs } : {}),
                  });
                  return await readWorkspaceReplicationManifestFromFile({
                    transferId: transferPublication.transferId,
                    filePath: received.destinationPath,
                    sizeBytes: received.sizeBytes,
                  });
                } finally {
                  await rm(temporaryServerRoutedDirectory, { recursive: true, force: true }).catch(() => undefined);
                }
              }
              throw new Error(directPeerTransferUnavailable().error);
            }
          } finally {
            await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
        })()
        : (() => {
          throw new Error(`Unexpected workspace replication manifest request (${params.actualTransportStrategy})`);
        })();

  return {
    sourceRootPath,
    manifest,
    ...(params.handoffMetadataV2?.workspaceReplicationSourceControllerMetadata
      ? { workspaceIntegrationMetadata: params.handoffMetadataV2.workspaceReplicationSourceControllerMetadata }
      : {}),
  };
}
