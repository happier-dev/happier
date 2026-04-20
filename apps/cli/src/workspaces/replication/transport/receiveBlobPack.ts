import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createWorkspaceReplicationCasStore } from '../cas/workspaceReplicationCasStore';
import { createWorkspaceReplicationPaths } from '../state/workspaceReplicationPaths';
import {
  WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER,
  WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER_BYTES,
  WORKSPACE_REPLICATION_BLOB_PACK_HEADER_BYTES,
  WORKSPACE_REPLICATION_BLOB_RECORD_HEADER_BYTES,
  WorkspaceReplicationBlobPackFormatError,
  parseWorkspaceReplicationBlobPackBlobRecordHeader,
  parseWorkspaceReplicationBlobPackEndMarker,
  parseWorkspaceReplicationBlobPackHeader,
} from './workspaceReplicationBlobPackFormatV1';
import { assertSafeWorkspaceReplicationPackId } from './workspaceReplicationPackId';

const BLOB_PACK_STREAM_CHUNK_BYTES = 64 * 1024;

function joinRecordParts(leadByte: Buffer, rest: Buffer): Buffer {
  const joined = Buffer.allocUnsafe(leadByte.byteLength + rest.byteLength);
  leadByte.copy(joined, 0);
  rest.copy(joined, leadByte.byteLength);
  return joined;
}

async function readExactBytes(input: Readonly<{
  file: Awaited<ReturnType<typeof open>>;
  position: number;
  length: number;
}>): Promise<Buffer> {
  const buffer = Buffer.alloc(input.length);
  let totalBytesRead = 0;

  while (totalBytesRead < input.length) {
    const { bytesRead } = await input.file.read(
      buffer,
      totalBytesRead,
      input.length - totalBytesRead,
      input.position + totalBytesRead,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }

  return buffer.subarray(0, totalBytesRead);
}

async function removeEmptyDirectoriesUpTo(input: Readonly<{
  startDirectory: string;
  stopDirectory: string;
}>): Promise<void> {
  let currentDirectory = input.startDirectory;
  while (currentDirectory.startsWith(input.stopDirectory)) {
    if (currentDirectory === input.stopDirectory) {
      const entries = await readdir(currentDirectory).catch(() => []);
      if (entries.length === 0) {
        await rm(currentDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      return;
    }
    const entries = await readdir(currentDirectory).catch(() => []);
    if (entries.length > 0) {
      return;
    }
    await rm(currentDirectory, { recursive: true, force: true }).catch(() => undefined);
    currentDirectory = currentDirectory.slice(0, currentDirectory.lastIndexOf('/'));
  }
}

async function cleanupTemporaryBlobFile(input: Readonly<{
  temporaryPath: string;
  packDirectory: string;
  stagingDirectory: string;
}>): Promise<void> {
  await rm(input.temporaryPath, { force: true }).catch(() => undefined);
  await removeEmptyDirectoriesUpTo({
    startDirectory: input.packDirectory,
    stopDirectory: input.stagingDirectory,
  });
}

export type ReceiveWorkspaceReplicationBlobPackResult = Readonly<{
  receivedDigests: readonly string[];
  committedDigests: readonly string[];
  transferredBytes: number;
  transferredBlobs: number;
}>;

export async function receiveWorkspaceReplicationBlobPack(input: Readonly<{
  activeServerDir: string;
  jobId: string;
  packId: string;
  packFilePath: string;
  maxSingleBlobBytes: number;
}>): Promise<ReceiveWorkspaceReplicationBlobPackResult> {
  assertSafeWorkspaceReplicationPackId(input.packId);

  const paths = createWorkspaceReplicationPaths({
    activeServerDir: input.activeServerDir,
  });
  const packDirectory = join(paths.stagingDirectory, input.jobId, 'blob-packs', input.packId);
  const casStore = createWorkspaceReplicationCasStore({
    activeServerDir: input.activeServerDir,
  });
  const receivedDigests: string[] = [];
  const committedDigests: string[] = [];
  let transferredBytes = 0;
  let transferredBlobs = 0;
  const packFile = await open(input.packFilePath, 'r');
  let position = 0;

  try {
    const packHeader = await readExactBytes({
      file: packFile,
      position,
      length: WORKSPACE_REPLICATION_BLOB_PACK_HEADER_BYTES,
    });
    if (packHeader.length !== WORKSPACE_REPLICATION_BLOB_PACK_HEADER_BYTES) {
      throw new WorkspaceReplicationBlobPackFormatError(
        'invalid_blob_pack_format',
        'Workspace replication blob pack ended before the header completed',
      );
    }
    parseWorkspaceReplicationBlobPackHeader(packHeader);
    position += packHeader.length;

    for (;;) {
      const recordLeadByte = await readExactBytes({
        file: packFile,
        position,
        length: 1,
      });
      if (recordLeadByte.length === 0) {
        throw new WorkspaceReplicationBlobPackFormatError(
          'invalid_blob_pack_format',
          'Workspace replication blob pack ended before the end marker',
        );
      }
      position += 1;

      if (recordLeadByte[0] === WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER) {
        const endMarkerRest = await readExactBytes({
          file: packFile,
          position,
          length: WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER_BYTES - 1,
        });
        if (endMarkerRest.length !== WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER_BYTES - 1) {
          throw new WorkspaceReplicationBlobPackFormatError(
            'invalid_blob_pack_format',
            'Workspace replication blob pack ended before the end marker completed',
          );
        }
        parseWorkspaceReplicationBlobPackEndMarker(joinRecordParts(recordLeadByte, endMarkerRest));
        position += endMarkerRest.length;

        const trailingByte = await readExactBytes({
          file: packFile,
          position,
          length: 1,
        });
        if (trailingByte.length > 0) {
          throw new WorkspaceReplicationBlobPackFormatError(
            'invalid_blob_pack_format',
            'Workspace replication blob pack has trailing bytes after the end marker',
          );
        }

        return {
          receivedDigests,
          committedDigests,
          transferredBlobs,
          transferredBytes,
        };
      }

      const recordHeaderRest = await readExactBytes({
        file: packFile,
        position,
        length: WORKSPACE_REPLICATION_BLOB_RECORD_HEADER_BYTES - 1,
      });
      if (recordHeaderRest.length !== WORKSPACE_REPLICATION_BLOB_RECORD_HEADER_BYTES - 1) {
        throw new WorkspaceReplicationBlobPackFormatError(
          'invalid_blob_pack_format',
          'Workspace replication blob pack ended before a blob record header completed',
        );
      }
      const recordHeader = parseWorkspaceReplicationBlobPackBlobRecordHeader(
        joinRecordParts(recordLeadByte, recordHeaderRest),
      );
      position += recordHeaderRest.length;

      if (recordHeader.sizeBytes > input.maxSingleBlobBytes) {
        throw new WorkspaceReplicationBlobPackFormatError(
          'blob_too_large',
          `Workspace replication blob exceeds max single-blob bytes: ${recordHeader.digest}`,
        );
      }

      await mkdir(packDirectory, { recursive: true });
      const temporaryPath = join(packDirectory, `${recordHeader.digest.slice('sha256:'.length)}-${randomUUID()}.part`);
      const temporaryFile = await open(temporaryPath, 'w');
      const digest = createHash('sha256');
      let remainingBytes = recordHeader.sizeBytes;

      try {
        while (remainingBytes > 0) {
          const chunkLength = Math.min(remainingBytes, BLOB_PACK_STREAM_CHUNK_BYTES);
          const chunk = await readExactBytes({
            file: packFile,
            position,
            length: chunkLength,
          });
          if (chunk.length !== chunkLength) {
            throw new WorkspaceReplicationBlobPackFormatError(
              'invalid_blob_pack_format',
              'Workspace replication blob pack ended before a blob payload completed',
            );
          }
          await temporaryFile.write(chunk);
          digest.update(chunk);
          remainingBytes -= chunk.length;
          position += chunk.length;
        }
      } catch (error) {
        await temporaryFile.close();
        await cleanupTemporaryBlobFile({
          temporaryPath,
          packDirectory,
          stagingDirectory: paths.stagingDirectory,
        });
        throw error;
      }

      await temporaryFile.close();

      const computedDigest = `sha256:${digest.digest('hex')}`;
      if (computedDigest !== recordHeader.digest) {
        await cleanupTemporaryBlobFile({
          temporaryPath,
          packDirectory,
          stagingDirectory: paths.stagingDirectory,
        });
        throw new WorkspaceReplicationBlobPackFormatError(
          'blob_digest_mismatch',
          `Workspace replication blob digest mismatch: ${recordHeader.digest}`,
        );
      }

      receivedDigests.push(recordHeader.digest);
      if (await casStore.contains(recordHeader.digest)) {
        await cleanupTemporaryBlobFile({
          temporaryPath,
          packDirectory,
          stagingDirectory: paths.stagingDirectory,
        });
        continue;
      }

      await casStore.commitFile({
        digest: recordHeader.digest,
        sourcePath: temporaryPath,
      });
      await cleanupTemporaryBlobFile({
        temporaryPath,
        packDirectory,
        stagingDirectory: paths.stagingDirectory,
      });
      committedDigests.push(recordHeader.digest);
      transferredBytes += recordHeader.sizeBytes;
      transferredBlobs += 1;
    }
  } finally {
    await packFile.close();
  }
}
