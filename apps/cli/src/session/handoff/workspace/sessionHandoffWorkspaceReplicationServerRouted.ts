import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFileTransferPayloadSource,
  resolveTransferPayloadManifestHash,
  type TransferPayloadSource,
} from '@/machines/transfer/transferPayloadSource';
import type { MachineTransferChannel } from '@/machines/transfer/serverRoutedTransport';
import type { WorkspaceExportBlobProvider } from '@/scm/sourceController/workspaceExportStaging/stageWorkspaceEntries';
import { createWorkspaceReplicationCasStore } from '@/workspaces/replication/cas/workspaceReplicationCasStore';
import { buildWorkspaceReplicationBlobPacks } from '@/workspaces/replication/transport/buildWorkspaceReplicationBlobPacks';
import { createWorkspaceReplicationBlobPackPayloadSource } from '@/workspaces/replication/transport/createWorkspaceReplicationBlobPackPayloadSource';
import type { WorkspaceReplicationSourceOffer } from '@/workspaces/replication/transport/createWorkspaceReplicationSourceOffer';
import { planWorkspaceReplicationMissingBlobs } from '@/workspaces/replication/transport/planWorkspaceReplicationMissingBlobs';
import { receiveWorkspaceReplicationBlobPack } from '@/workspaces/replication/transport/receiveWorkspaceReplicationBlobPack';
import { writeWorkspaceReplicationSourceOfferToFile } from '@/workspaces/replication/transport/workspaceReplicationSourceOfferFileFormat';
import type { WorkspaceReplicationTransfers } from '@/workspaces/replication/transport/workspaceReplicationTransfers';

import {
  buildSessionHandoffWorkspaceReplicationSourceOffer,
  type SessionHandoffWorkspaceReplicationMetadata,
} from './sessionHandoffWorkspaceReplicationMetadata';

const SESSION_HANDOFF_TRANSFER_ID_PREFIX = 'session-handoff:';
const SESSION_HANDOFF_WORKSPACE_OFFER_MARKER = ':workspace-offer:';
const SESSION_HANDOFF_WORKSPACE_PACK_MARKER = ':workspace-pack:';

type SessionHandoffWorkspaceSourceOfferTransfer = Readonly<{
  handoffId: string;
  targetPath: string;
}>;

type SessionHandoffWorkspaceBlobPackTransfer = Readonly<{
  handoffId: string;
  packId: string;
  digests: readonly string[];
}>;

function parseDecodedDigests(encodedDigests: string): readonly string[] | null {
  try {
    const decoded = JSON.parse(Buffer.from(encodedDigests, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function buildSessionHandoffWorkspaceSourceOfferTransferId(input: Readonly<{
  handoffId: string;
  targetPath: string;
}>): string {
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${input.handoffId}${SESSION_HANDOFF_WORKSPACE_OFFER_MARKER}${encodeURIComponent(input.targetPath)}`;
}

export function parseSessionHandoffWorkspaceSourceOfferTransferId(
  transferId: string,
): SessionHandoffWorkspaceSourceOfferTransfer | null {
  if (!transferId.startsWith(SESSION_HANDOFF_TRANSFER_ID_PREFIX)) {
    return null;
  }
  const markerIndex = transferId.indexOf(
    SESSION_HANDOFF_WORKSPACE_OFFER_MARKER,
    SESSION_HANDOFF_TRANSFER_ID_PREFIX.length,
  );
  if (markerIndex < 0) {
    return null;
  }
  const handoffId = transferId.slice(SESSION_HANDOFF_TRANSFER_ID_PREFIX.length, markerIndex).trim();
  const encodedTargetPath = transferId.slice(markerIndex + SESSION_HANDOFF_WORKSPACE_OFFER_MARKER.length);
  if (handoffId.length === 0 || encodedTargetPath.length === 0) {
    return null;
  }
  return {
    handoffId,
    targetPath: decodeURIComponent(encodedTargetPath),
  };
}

export function buildSessionHandoffWorkspaceBlobPackTransferId(input: Readonly<{
  handoffId: string;
  packId: string;
  digests: readonly string[];
}>): string {
  const encodedDigests = Buffer.from(JSON.stringify([...input.digests]), 'utf8').toString('base64url');
  return `${SESSION_HANDOFF_TRANSFER_ID_PREFIX}${input.handoffId}${SESSION_HANDOFF_WORKSPACE_PACK_MARKER}${input.packId}:${encodedDigests}`;
}

export function parseSessionHandoffWorkspaceBlobPackTransferId(
  transferId: string,
): SessionHandoffWorkspaceBlobPackTransfer | null {
  if (!transferId.startsWith(SESSION_HANDOFF_TRANSFER_ID_PREFIX)) {
    return null;
  }
  const markerIndex = transferId.indexOf(
    SESSION_HANDOFF_WORKSPACE_PACK_MARKER,
    SESSION_HANDOFF_TRANSFER_ID_PREFIX.length,
  );
  if (markerIndex < 0) {
    return null;
  }
  const handoffId = transferId.slice(SESSION_HANDOFF_TRANSFER_ID_PREFIX.length, markerIndex).trim();
  const rest = transferId.slice(markerIndex + SESSION_HANDOFF_WORKSPACE_PACK_MARKER.length);
  const separatorIndex = rest.indexOf(':');
  if (handoffId.length === 0 || separatorIndex <= 0) {
    return null;
  }
  const packId = rest.slice(0, separatorIndex);
  const encodedDigests = rest.slice(separatorIndex + 1);
  const digests = parseDecodedDigests(encodedDigests);
  if (!digests || packId.length === 0) {
    return null;
  }
  return {
    handoffId,
    packId,
    digests,
  };
}

export async function createSessionHandoffWorkspaceReplicationSourceOfferPayloadSource(input: Readonly<{
  activeServerDir: string;
  sourceMachineId: string;
  targetMachineId: string;
  targetPath: string;
  metadata: SessionHandoffWorkspaceReplicationMetadata;
}>): Promise<TransferPayloadSource> {
  const sourceOffer = await buildSessionHandoffWorkspaceReplicationSourceOffer(input);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-session-handoff-workspace-offer-'));
  const filePath = join(temporaryDirectory, 'workspace-replication-source-offer.txt');

  try {
    const { sizeBytes } = await writeWorkspaceReplicationSourceOfferToFile({
      offer: sourceOffer,
      filePath,
    });
    const manifestHash = await resolveTransferPayloadManifestHash({
      kind: 'file',
      filePath,
      sizeBytes,
    });

    return createFileTransferPayloadSource({
      filePath,
      sizeBytes,
      manifestHash,
      dispose: async () => {
        await rm(temporaryDirectory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function receiveServerRoutedSessionHandoffWorkspaceReplication(input: Readonly<{
  activeServerDir: string;
  handoffId: string;
  sourceMachineId: string;
  targetPath: string;
  machineTransferChannel: MachineTransferChannel;
  transfers: WorkspaceReplicationTransfers;
  blobPackTargetBytes: number;
  blobPackMaxBlobs: number;
  blobPackMaxSingleBlobBytes: number;
}>): Promise<Readonly<{
  sourceOffer: WorkspaceReplicationSourceOffer;
  transferredPackCount: number;
  transferredBytes: number;
  transferredBlobs: number;
}>> {
  const sourceOffer = await input.transfers.requestServerRoutedSourceOffer({
    transferId: buildSessionHandoffWorkspaceSourceOfferTransferId({
      handoffId: input.handoffId,
      targetPath: input.targetPath,
    }),
    sourceMachineId: input.sourceMachineId,
    machineTransferChannel: input.machineTransferChannel,
  });

  const missingBlobPlan = await planWorkspaceReplicationMissingBlobs({
    activeServerDir: input.activeServerDir,
    blobIndex: sourceOffer.blobIndex,
  });
  const packs = buildWorkspaceReplicationBlobPacks({
    blobs: missingBlobPlan.missingBlobs,
    blobPackTargetBytes: input.blobPackTargetBytes,
    blobPackMaxBlobs: input.blobPackMaxBlobs,
    blobPackMaxSingleBlobBytes: input.blobPackMaxSingleBlobBytes,
  });

  let transferredPackCount = 0;
  let transferredBytes = 0;
  let transferredBlobs = 0;

  for (const pack of packs) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-session-handoff-workspace-pack-'));
    const destinationPath = join(temporaryDirectory, `${pack.packId}.bin`);

    try {
      await input.transfers.requestServerRoutedBlobPackToFile({
        transferId: buildSessionHandoffWorkspaceBlobPackTransferId({
          handoffId: input.handoffId,
          packId: pack.packId,
          digests: pack.digests,
        }),
        sourceMachineId: input.sourceMachineId,
        machineTransferChannel: input.machineTransferChannel,
        destinationPath,
      });
      const result = await receiveWorkspaceReplicationBlobPack({
        activeServerDir: input.activeServerDir,
        jobId: input.handoffId,
        packId: pack.packId,
        packFilePath: destinationPath,
        maxSingleBlobBytes: input.blobPackMaxSingleBlobBytes,
      });
      transferredPackCount += 1;
      transferredBytes += result.transferredBytes;
      transferredBlobs += result.transferredBlobs;
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    sourceOffer,
    transferredPackCount,
    transferredBytes,
    transferredBlobs,
  };
}

export async function createSessionHandoffWorkspaceReplicationBlobPackPayloadSource(input: Readonly<{
  activeServerDir: string;
  packId: string;
  digests: readonly string[];
  blobProvider?: WorkspaceExportBlobProvider;
  workspaceExportArtifacts?: Readonly<{
    blobContentsByDigest: ReadonlyMap<string, Uint8Array>;
  }>;
}>): Promise<TransferPayloadSource> {
  try {
    return await createWorkspaceReplicationBlobPackPayloadSource(input);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Missing workspace replication CAS blob:')) {
      throw error;
    }

    if (input.workspaceExportArtifacts) {
      await seedWorkspaceReplicationCasFromExportArtifacts({
        activeServerDir: input.activeServerDir,
        workspaceExportArtifacts: input.workspaceExportArtifacts,
      });
    } else if (input.blobProvider) {
      const casStore = createWorkspaceReplicationCasStore({
        activeServerDir: input.activeServerDir,
      });
      for (const digest of input.digests) {
        if (await casStore.contains(digest)) {
          continue;
        }
        const blobPath = input.blobProvider.getBlobFilePath(digest);
        if (!blobPath) {
          throw error;
        }
        await casStore.commitFile({
          digest,
          sourcePath: blobPath,
        });
      }
    } else {
      throw error;
    }

    return await createWorkspaceReplicationBlobPackPayloadSource(input);
  }
}

export async function seedWorkspaceReplicationCasFromExportArtifacts(input: Readonly<{
  activeServerDir: string;
  workspaceExportArtifacts: Readonly<{
    blobContentsByDigest: ReadonlyMap<string, Uint8Array>;
  }>;
}>): Promise<void> {
  if (input.workspaceExportArtifacts.blobContentsByDigest.size === 0) {
    return;
  }

  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-session-handoff-seed-cas-'));

  try {
    await mkdir(temporaryDirectory, { recursive: true });
    for (const [digest, blobContent] of input.workspaceExportArtifacts.blobContentsByDigest.entries()) {
      const temporaryBlobPath = join(temporaryDirectory, digest.replace(/[^a-zA-Z0-9_.-]/g, '_'));
      await writeFile(temporaryBlobPath, blobContent);
      await casStore.commitFile({
        digest,
        sourcePath: temporaryBlobPath,
      });
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
