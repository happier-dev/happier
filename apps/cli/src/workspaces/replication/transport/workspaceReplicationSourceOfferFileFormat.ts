import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import { ReplicationManifestEntrySchema, ReplicationManifestFingerprintSchema } from '../replicationManifestSchema';
import type { WorkspaceReplicationSourceOffer } from './createWorkspaceReplicationSourceOffer';

export const WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC = 'HAPPIER_WORKSPACE_REPLICATION_SOURCE_OFFER_V1';

const WorkspaceReplicationSourceOfferHeaderSchema = z.object({
  offerId: z.string().min(1),
  relationshipId: z.string().min(1),
  directionId: z.string().min(1),
  sourceFingerprint: ReplicationManifestFingerprintSchema,
  manifestFingerprint: ReplicationManifestFingerprintSchema.optional(),
  sourceControllerMetadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

async function readFilePrefixUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function isStreamingWorkspaceReplicationSourceOfferFile(filePath: string): Promise<boolean> {
  const prefix = await readFilePrefixUtf8(filePath, WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC.length + 8);
  return prefix.startsWith(WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC);
}

export async function readWorkspaceReplicationSourceOfferFromFile(input: Readonly<{
  transferId: string;
  filePath: string;
}>): Promise<WorkspaceReplicationSourceOffer> {
  const streaming = await isStreamingWorkspaceReplicationSourceOfferFile(input.filePath);
  if (!streaming) {
    // Legacy offers were whole-buffer JSON payloads. They are intentionally rejected so large offers
    // cannot regress to whole-buffer reads/parses during transport/storage hardening.
    throw new Error(`Legacy workspace replication source offer format is not supported: ${input.transferId}`);
  }

  const stream = createReadStream(input.filePath, { encoding: 'utf8' });
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    const iterator = rl[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || String(first.value ?? '').trim() !== WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC) {
      throw new Error('Invalid workspace replication source offer');
    }

    const headerLine = await iterator.next();
    if (headerLine.done) {
      throw new Error('Invalid workspace replication source offer');
    }

    let headerJson: unknown;
    try {
      headerJson = JSON.parse(String(headerLine.value ?? ''));
    } catch {
      throw new Error('Invalid workspace replication source offer');
    }
    const parsedHeader = WorkspaceReplicationSourceOfferHeaderSchema.safeParse(headerJson);
    if (!parsedHeader.success) {
      throw new Error('Invalid workspace replication source offer');
    }

    const entries: z.infer<typeof ReplicationManifestEntrySchema>[] = [];
    const blobIndexByDigest = new Map<string, { digest: string; sizeBytes: number }>();

    // Continue from the current iterator position without buffering the full file.
    while (true) {
      const nextLine = await iterator.next();
      if (nextLine.done) break;
      const trimmed = String(nextLine.value ?? '').trim();
      if (trimmed.length === 0) continue;
      let entryJson: unknown;
      try {
        entryJson = JSON.parse(trimmed);
      } catch {
        throw new Error('Invalid workspace replication source offer');
      }
      const parsedEntry = ReplicationManifestEntrySchema.safeParse(entryJson);
      if (!parsedEntry.success) {
        throw new Error('Invalid workspace replication source offer');
      }
      const entry = parsedEntry.data;
      entries.push(entry);
      if (entry.kind === 'file' && !blobIndexByDigest.has(entry.digest)) {
        blobIndexByDigest.set(entry.digest, { digest: entry.digest, sizeBytes: entry.sizeBytes });
      }
    }

    return {
      offerId: parsedHeader.data.offerId,
      relationshipId: parsedHeader.data.relationshipId,
      directionId: parsedHeader.data.directionId,
      sourceFingerprint: parsedHeader.data.sourceFingerprint,
      manifest: {
        entries,
        ...(parsedHeader.data.manifestFingerprint ? { fingerprint: parsedHeader.data.manifestFingerprint } : {}),
      },
      blobIndex: [...blobIndexByDigest.values()],
      ...(parsedHeader.data.sourceControllerMetadata ? { sourceControllerMetadata: parsedHeader.data.sourceControllerMetadata } : {}),
    };
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function writeWorkspaceReplicationSourceOfferToFile(input: Readonly<{
  offer: WorkspaceReplicationSourceOffer;
  filePath: string;
}>): Promise<Readonly<{ filePath: string; sizeBytes: number }>> {
  const header = {
    offerId: input.offer.offerId,
    relationshipId: input.offer.relationshipId,
    directionId: input.offer.directionId,
    sourceFingerprint: input.offer.sourceFingerprint,
    ...(input.offer.manifest.fingerprint ? { manifestFingerprint: input.offer.manifest.fingerprint } : {}),
    ...(input.offer.sourceControllerMetadata ? { sourceControllerMetadata: input.offer.sourceControllerMetadata } : {}),
  };

  const file = await open(input.filePath, 'w', 0o600);
  try {
    await file.write(`${WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC}\n`);
    await file.write(`${JSON.stringify(header)}\n`);
    for (const entry of input.offer.manifest.entries) {
      await file.write(`${JSON.stringify(entry)}\n`);
    }
  } finally {
    await file.close().catch(() => undefined);
  }

  const stats = await stat(input.filePath);
  return {
    filePath: input.filePath,
    sizeBytes: stats.size,
  };
}
