import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import type { ReplicationManifest } from '../replicationManifestSchema';
import {
  ReplicationManifestEntrySchema,
  ReplicationManifestFingerprintSchema,
} from '../replicationManifestSchema';
import {
  createFileTransferPayloadSource,
  resolveTransferPayloadManifestHash,
  type TransferPayloadSource,
} from '@/machines/transfer/transferPayloadSource';
import type { WorkspaceReplicationManifestDigestIndexEntry } from './workspaceReplicationManifestIndex';

export const WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC = 'HAPPIER_WORKSPACE_REPLICATION_MANIFEST_V1';

const WorkspaceReplicationManifestHeaderSchema = z
  .object({
    manifestFingerprint: ReplicationManifestFingerprintSchema.optional(),
  })
  .strict();

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

async function isStreamingWorkspaceReplicationManifestFile(filePath: string): Promise<boolean> {
  const prefix = await readFilePrefixUtf8(filePath, WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC.length + 8);
  return prefix.startsWith(WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC);
}

async function validateWorkspaceReplicationManifestFileSize(input: Readonly<{
  transferId: string;
  filePath: string;
  sizeBytes?: number | null;
}>): Promise<void> {
  if (typeof input.sizeBytes !== 'number') {
    return;
  }

  let actualSizeBytes: number;
  try {
    const stats = await stat(input.filePath);
    if (!stats.isFile()) {
      throw new Error('not a file');
    }
    actualSizeBytes = stats.size;
  } catch {
    throw new Error('Invalid workspace replication manifest');
  }

  if (actualSizeBytes !== input.sizeBytes) {
    throw new Error('Invalid workspace replication manifest');
  }
}

async function visitStreamingWorkspaceReplicationManifestFile(input: Readonly<{
  transferId: string;
  filePath: string;
  sizeBytes?: number | null;
  onHeader: (header: z.infer<typeof WorkspaceReplicationManifestHeaderSchema>) => void;
  onEntry: (entry: z.infer<typeof ReplicationManifestEntrySchema>) => void;
}>): Promise<void> {
  await validateWorkspaceReplicationManifestFileSize(input);

  const streaming = await isStreamingWorkspaceReplicationManifestFile(input.filePath);
  if (!streaming) {
    throw new Error('Invalid workspace replication manifest');
  }

  const stream = createReadStream(input.filePath, { encoding: 'utf8' });
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    const iterator = rl[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || String(first.value ?? '').trim() !== WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC) {
      throw new Error('Invalid workspace replication manifest');
    }

    const headerLine = await iterator.next();
    if (headerLine.done) {
      throw new Error('Invalid workspace replication manifest');
    }

    let headerJson: unknown;
    try {
      headerJson = JSON.parse(String(headerLine.value ?? ''));
    } catch {
      throw new Error('Invalid workspace replication manifest');
    }
    const parsedHeader = WorkspaceReplicationManifestHeaderSchema.safeParse(headerJson);
    if (!parsedHeader.success) {
      throw new Error('Invalid workspace replication manifest');
    }

    input.onHeader(parsedHeader.data);

    while (true) {
      const nextLine = await iterator.next();
      if (nextLine.done) break;
      const trimmed = String(nextLine.value ?? '').trim();
      if (trimmed.length === 0) continue;
      let entryJson: unknown;
      try {
        entryJson = JSON.parse(trimmed);
      } catch {
        throw new Error('Invalid workspace replication manifest');
      }
      const parsedEntry = ReplicationManifestEntrySchema.safeParse(entryJson);
      if (!parsedEntry.success) {
        throw new Error('Invalid workspace replication manifest');
      }
      input.onEntry(parsedEntry.data);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function readWorkspaceReplicationManifestFromFile(input: Readonly<{
  transferId: string;
  filePath: string;
  sizeBytes?: number | null;
}>): Promise<ReplicationManifest> {
  const entries: z.infer<typeof ReplicationManifestEntrySchema>[] = [];
  let fingerprint: string | undefined;

  await visitStreamingWorkspaceReplicationManifestFile({
    ...input,
    onHeader: (header) => {
      fingerprint = header.manifestFingerprint;
    },
    onEntry: (entry) => {
      entries.push(entry);
    },
  });

  return {
    entries,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

export async function readWorkspaceReplicationManifestDigestIndexFromFile(input: Readonly<{
  transferId: string;
  filePath: string;
  sizeBytes?: number | null;
}>): Promise<ReadonlyMap<string, WorkspaceReplicationManifestDigestIndexEntry>> {
  const index = new Map<string, WorkspaceReplicationManifestDigestIndexEntry>();

  await visitStreamingWorkspaceReplicationManifestFile({
    ...input,
    onHeader: () => {},
    onEntry: (entry) => {
      if (entry.kind !== 'file') {
        return;
      }
      if (index.has(entry.digest)) {
        return;
      }
      index.set(entry.digest, {
        relativePath: entry.relativePath,
        sizeBytes: entry.sizeBytes,
      });
    },
  });

  return index;
}

export async function writeWorkspaceReplicationManifestToFile(input: Readonly<{
  manifest: ReplicationManifest;
  filePath: string;
}>): Promise<Readonly<{ filePath: string; sizeBytes: number }>> {
  const stream = createWriteStream(input.filePath, { encoding: 'utf8' });
  try {
    const header = {
      ...(input.manifest.fingerprint ? { manifestFingerprint: input.manifest.fingerprint } : {}),
    };

    stream.write(`${WORKSPACE_REPLICATION_MANIFEST_STREAM_MAGIC}\n`);
    stream.write(`${JSON.stringify(header)}\n`);
    for (const entry of input.manifest.entries) {
      stream.write(`${JSON.stringify(entry)}\n`);
    }

    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.on('error', reject);
    });
  } finally {
    stream.destroy();
  }

  const stats = await stat(input.filePath);
  return {
    filePath: input.filePath,
    sizeBytes: stats.size,
  };
}

export async function createWorkspaceReplicationManifestPayloadSource(input: Readonly<{
  manifest: ReplicationManifest;
}>): Promise<TransferPayloadSource> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-manifest-'));
  const filePath = join(temporaryDirectory, 'workspace-manifest.txt');

  try {
    const { sizeBytes } = await writeWorkspaceReplicationManifestToFile({
      manifest: input.manifest,
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
