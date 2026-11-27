import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TransferEndpointCandidateSchema,
  type TransferEndpointCandidate,
} from '@happier-dev/protocol/machines/transfer/transferStream';
import { buildDirectPeerTransferEndpointPath } from '@/machines/transfer/directPeerTransport';
import {
  createFileTransferPayloadSource,
  readTransferPayloadChunk,
  resolveTransferPayloadManifestHash,
  resolveTransferPayloadSizeBytes,
} from '@/machines/transfer/transferPayloadSource';
import type {
  WorkspaceSyncMachineTunnel,
  WorkspaceSyncMachineTunnelOpen,
} from './workspaceSyncMachineCarrierStream';

export type ParsedDirectTransferExport = Readonly<{
  transferId: string;
  sizeBytes: number;
  manifestHash: string;
  sourceCandidate: TransferEndpointCandidate;
}>;

export type DirectTransferPayloadFileFetcher = (input: Readonly<{
  transferId: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  destinationPath: string;
  expectedSizeBytes?: number;
  expectedManifestHash?: string;
  signal?: AbortSignal;
}>) => Promise<void>;

/**
 * Canonical sizeBytes invariant across all Workspace Sync direct-transfer exports:
 * any non-negative safe integer (>= 0) is valid, including zero-byte payloads.
 */
export function isValidDirectTransferSizeBytes(sizeBytes: unknown): sizeBytes is number {
  return typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0;
}

export function parsePreparedDirectTransferExport(input: Readonly<{
  raw: unknown;
  expectedTransferId: string;
  createInvalidError: (message: string) => Error;
}>): ParsedDirectTransferExport {
  if (!input.raw || typeof input.raw !== 'object' || (input.raw as { success?: unknown }).success !== true) {
    throw input.createInvalidError('Workspace sync direct transfer export is unavailable');
  }
  const prepared = input.raw as Readonly<Record<string, unknown>>;
  if (typeof prepared.transferId !== 'string' || prepared.transferId !== input.expectedTransferId
    || !isValidDirectTransferSizeBytes(prepared.sizeBytes)
    || typeof prepared.manifestHash !== 'string'
    || !Array.isArray(prepared.endpointCandidates)) {
    throw input.createInvalidError('Workspace sync direct transfer export response is invalid');
  }
  const sourceCandidate = prepared.endpointCandidates.map(c => TransferEndpointCandidateSchema.parse(c))[0];
  if (!sourceCandidate) {
    throw input.createInvalidError('Workspace sync direct transfer export has no finite transfer endpoint');
  }
  return { transferId: prepared.transferId, sizeBytes: prepared.sizeBytes, manifestHash: prepared.manifestHash, sourceCandidate };
}

export function buildLoopbackDirectTransferCandidate(input: Readonly<{
  sourceCandidate: TransferEndpointCandidate;
  transferId: string;
  localPort?: number;
}>): TransferEndpointCandidate {
  const url = new URL(input.sourceCandidate.url);
  url.protocol = 'http:';
  url.hostname = '127.0.0.1';
  if (input.localPort !== undefined) url.port = String(input.localPort);
  url.pathname = buildDirectPeerTransferEndpointPath(input.transferId);
  return { ...input.sourceCandidate, kind: 'http' as const, url: url.toString() };
}

export async function openDirectTransferPayloadEndpoint(input: Readonly<{
  sourceCandidate: TransferEndpointCandidate;
  transferId: string;
  localMachineId: string;
  sourceMachineId: string;
  issuedTunnel?: WorkspaceSyncMachineTunnel;
  openCarrier?: WorkspaceSyncMachineTunnelOpen;
  signal?: AbortSignal;
}>): Promise<Readonly<{ endpointCandidates: readonly TransferEndpointCandidate[]; dispose(): Promise<void> }>> {
  const tunnel = input.issuedTunnel ?? (input.sourceMachineId === input.localMachineId
    ? null
    : await input.openCarrier!({
      sourceMachineId: input.localMachineId, targetMachineId: input.sourceMachineId, flow: 'file_transfer',
      ...(input.signal ? { signal: input.signal } : {}),
    }));
  const candidate = buildLoopbackDirectTransferCandidate({
    sourceCandidate: input.sourceCandidate, transferId: input.transferId,
    ...(tunnel ? { localPort: tunnel.localPort } : {}),
  });
  return {
    endpointCandidates: [candidate],
    dispose: async () => { if (!input.issuedTunnel) await tunnel?.close(); },
  };
}

export async function fetchDirectTransferPayloadViaCarrier(input: Readonly<{
  prepared: ParsedDirectTransferExport;
  transferId: string;
  destinationPath: string;
  expectedSizeBytes?: number;
  expectedManifestHash?: string;
  requireCommitment?: boolean;
  createInvalidCommitmentError?: (message: string) => Error;
  localMachineId: string;
  sourceMachineId: string;
  issuedTunnel?: WorkspaceSyncMachineTunnel;
  openCarrier?: WorkspaceSyncMachineTunnelOpen;
  fetchPayloadFile: DirectTransferPayloadFileFetcher;
  signal?: AbortSignal;
}>): Promise<void> {
  const isRootPayload = input.transferId === input.prepared.transferId;
  const sizeBytes = isRootPayload ? input.prepared.sizeBytes : input.expectedSizeBytes;
  const manifestHash = isRootPayload ? input.prepared.manifestHash : input.expectedManifestHash;
  if (input.requireCommitment && (!isValidDirectTransferSizeBytes(sizeBytes) || !manifestHash)) {
    throw (input.createInvalidCommitmentError
      ?? (message => Object.assign(new Error(message), { code: 'target_bootstrap_offline' })))('Workspace sync seed payload commitment is invalid');
  }
  const opened = await openDirectTransferPayloadEndpoint({
    sourceCandidate: input.prepared.sourceCandidate, transferId: input.transferId,
    localMachineId: input.localMachineId, sourceMachineId: input.sourceMachineId,
    ...(input.issuedTunnel ? { issuedTunnel: input.issuedTunnel } : {}),
    ...(input.openCarrier ? { openCarrier: input.openCarrier } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    await input.fetchPayloadFile({
      transferId: input.transferId, endpointCandidates: opened.endpointCandidates, destinationPath: input.destinationPath,
      ...(sizeBytes === undefined ? {} : { expectedSizeBytes: sizeBytes }),
      ...(manifestHash === undefined ? {} : { expectedManifestHash: manifestHash }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    await opened.dispose();
  }
}

export async function createTempDirPayloadSourceResolver(input: Readonly<{
  prefix: string;
  fetchToFile: (request: Readonly<{ transferId: string; destinationPath: string }>) => Promise<void>;
  releaseUnderlying: () => Promise<void>;
}>): Promise<Readonly<{
  resolvePayloadSource: (request: Readonly<{ transferId: string }>) => Promise<Readonly<{
    sizeBytes: number; manifestHash: string;
    readChunk: (range: Readonly<{ offset: number; length: number }>) => Promise<Buffer>;
  }>>;
  dispose: () => Promise<void>;
}>> {
  const directory = await mkdtemp(join(tmpdir(), input.prefix)).catch(async error => {
    await input.releaseUnderlying();
    throw error;
  });
  let index = 0;
  return {
    resolvePayloadSource: async ({ transferId }) => {
      const destinationPath = join(directory, String(index++));
      await input.fetchToFile({ transferId, destinationPath });
      const source = createFileTransferPayloadSource({ filePath: destinationPath });
      return {
        sizeBytes: await resolveTransferPayloadSizeBytes(source),
        manifestHash: await resolveTransferPayloadManifestHash(source),
        readChunk: async range => readTransferPayloadChunk({ source, ...range }),
      };
    },
    dispose: async () => {
      try { await input.releaseUnderlying(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
