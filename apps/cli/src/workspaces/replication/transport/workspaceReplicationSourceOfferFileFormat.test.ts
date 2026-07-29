import { afterEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, readFile, readdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceReplicationSourceOffer } from './createWorkspaceReplicationSourceOffer';
import {
  readWorkspaceReplicationSourceOfferFromFile,
  WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC,
  writeWorkspaceReplicationSourceOfferToFile,
} from './workspaceReplicationSourceOfferFileFormat';

let maxWriteBytesPerCall: number | null = null;
let forceZeroProgress = false;
let failWriteAfterSuccessfulCalls: number | null = null;
let successfulWriteCalls = 0;
let writeFailure: Error | null = null;
let nextWritableCloseFailure: Error | null = null;

type BufferFileWrite = (
  buffer: Uint8Array,
  offset?: number | null,
  length?: number | null,
  position?: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const flags = args[1];
      const writable = typeof flags === 'string' && (flags.includes('w') || flags.includes('a') || flags.includes('+'));
      const write = handle.write.bind(handle) as BufferFileWrite;
      Object.defineProperty(handle, 'write', {
        configurable: true,
        value: async (
          data: string | Uint8Array,
          offsetOrPosition: number | null = typeof data === 'string' ? null : 0,
          lengthOrEncoding?: number | string | null,
          position: number | null = null,
        ) => {
          if (forceZeroProgress) {
            return { bytesWritten: 0, buffer: data };
          }
          if (failWriteAfterSuccessfulCalls !== null && successfulWriteCalls >= failWriteAfterSuccessfulCalls) {
            throw writeFailure ?? new Error('simulated source-offer write failure');
          }

          if (typeof data === 'string') {
            const buffer = Buffer.from(data, 'utf8');
            const length = maxWriteBytesPerCall === null
              ? buffer.byteLength
              : Math.min(buffer.byteLength, maxWriteBytesPerCall);
            const { bytesWritten } = await write(buffer, 0, length, offsetOrPosition);
            successfulWriteCalls += 1;
            return { bytesWritten, buffer: data };
          }

          const offset = offsetOrPosition ?? 0;
          const requestedLength = typeof lengthOrEncoding === 'number'
            ? lengthOrEncoding
            : data.byteLength - offset;
          const result = await write(
            data,
            offset,
            maxWriteBytesPerCall === null
              ? requestedLength
              : Math.min(requestedLength, maxWriteBytesPerCall),
            position,
          );
          successfulWriteCalls += 1;
          return result;
        },
      });
      if (writable) {
        const close = handle.close.bind(handle);
        Object.defineProperty(handle, 'close', {
          configurable: true,
          value: async () => {
            await close();
            if (nextWritableCloseFailure !== null) {
              const error = nextWritableCloseFailure;
              nextWritableCloseFailure = null;
              throw error;
            }
          },
        });
      }
      return handle as FileHandle;
    }),
  };
});

function createTestSourceOffer(): WorkspaceReplicationSourceOffer {
  return {
    offerId: 'offer_1',
    relationshipId: 'rel_1',
    directionId: 'dir_1',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    manifest: {
      entries: [
        { relativePath: 'src', kind: 'directory' as const },
        {
          relativePath: 'src/a.ts',
          kind: 'file' as const,
          digest: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 1,
          executable: false,
        },
      ],
      fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    blobIndex: [{ digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 1 }],
    workspaceIntegrationMetadata: { scm: 'git' },
  };
}

function encodeExpectedSourceOfferFile(offer: ReturnType<typeof createTestSourceOffer>): string {
  return [
    WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC,
    JSON.stringify({
      offerId: offer.offerId,
      relationshipId: offer.relationshipId,
      directionId: offer.directionId,
      sourceFingerprint: offer.sourceFingerprint,
      manifestFingerprint: offer.manifest.fingerprint,
      workspaceIntegrationMetadata: offer.workspaceIntegrationMetadata,
    }),
    ...offer.manifest.entries.map((entry) => JSON.stringify(entry)),
    '',
  ].join('\n');
}

describe('workspaceReplicationSourceOfferFileFormat', () => {
  afterEach(() => {
    maxWriteBytesPerCall = null;
    forceZeroProgress = false;
    failWriteAfterSuccessfulCalls = null;
    successfulWriteCalls = 0;
    writeFailure = null;
    nextWritableCloseFailure = null;
    vi.clearAllMocks();
  });

  it('roundtrips a source offer through the streaming file format without whole-buffer JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      const offer = createTestSourceOffer();

      await writeWorkspaceReplicationSourceOfferToFile({ offer, filePath });

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).resolves.toMatchObject({
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: offer.sourceFingerprint,
        workspaceIntegrationMetadata: { scm: 'git' },
        manifest: {
          fingerprint: offer.manifest.fingerprint,
        },
        blobIndex: [{ digest: `sha256:${'b'.repeat(64)}`, sizeBytes: 1 }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('writes the exact source offer bytes and size after progressing filesystem short writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-short-write-'));
    try {
      const filePath = join(dir, 'offer.txt');
      const baseOffer = createTestSourceOffer();
      const offer: WorkspaceReplicationSourceOffer = {
        ...baseOffer,
        manifest: {
          ...baseOffer.manifest,
          entries: [
            { relativePath: 'src/Grüße-東京-🙂', kind: 'directory' },
            baseOffer.manifest.entries[1]!,
          ],
        },
      };
      const expectedFile = encodeExpectedSourceOfferFile(offer);
      maxWriteBytesPerCall = 2;

      const result = await writeWorkspaceReplicationSourceOfferToFile({
        offer,
        filePath,
      });

      expect(result.sizeBytes).toBe(Buffer.byteLength(expectedFile, 'utf8'));
      await expect(readFile(filePath, 'utf8')).resolves.toBe(expectedFile);
      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_short_write',
        filePath,
      })).resolves.toMatchObject({
        offerId: offer.offerId,
        manifest: {
          entries: offer.manifest.entries,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('preserves an existing offer and removes unpublished bytes when a rewrite fails after partial progress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-partial-rewrite-'));
    try {
      const filePath = join(dir, 'offer.txt');
      const existingOffer = createTestSourceOffer();
      const replacementOffer: WorkspaceReplicationSourceOffer = {
        ...existingOffer,
        relationshipId: 'rel_replacement',
      };
      const primaryFailure = new Error('simulated source-offer write failure after progress');
      await writeFile(filePath, encodeExpectedSourceOfferFile(existingOffer), 'utf8');
      maxWriteBytesPerCall = 2;
      failWriteAfterSuccessfulCalls = 1;
      writeFailure = primaryFailure;

      const outcome = await writeWorkspaceReplicationSourceOfferToFile({
        offer: replacementOffer,
        filePath,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBe(primaryFailure);
      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: existingOffer.offerId,
        filePath,
      })).resolves.toMatchObject({
        offerId: existingOffer.offerId,
        relationshipId: existingOffer.relationshipId,
        manifest: { entries: existingOffer.manifest.entries },
      });
      await expect(readdir(dir)).resolves.toEqual(['offer.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects a close failure without replacing an existing offer or leaking a temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-close-failure-'));
    try {
      const filePath = join(dir, 'offer.txt');
      const existingOffer = createTestSourceOffer();
      const replacementOffer: WorkspaceReplicationSourceOffer = {
        ...existingOffer,
        directionId: 'dir_replacement',
      };
      const closeFailure = new Error('simulated source-offer close failure');
      await writeFile(filePath, encodeExpectedSourceOfferFile(existingOffer), 'utf8');
      nextWritableCloseFailure = closeFailure;

      const outcome = await writeWorkspaceReplicationSourceOfferToFile({
        offer: replacementOffer,
        filePath,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBe(closeFailure);
      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: existingOffer.offerId,
        filePath,
      })).resolves.toMatchObject({
        offerId: existingOffer.offerId,
        directionId: existingOffer.directionId,
        manifest: { entries: existingOffer.manifest.entries },
      });
      await expect(readdir(dir)).resolves.toEqual(['offer.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a filesystem write makes zero progress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-zero-write-'));
    try {
      const filePath = join(dir, 'offer.txt');
      forceZeroProgress = true;

      await expect(writeWorkspaceReplicationSourceOfferToFile({
        offer: createTestSourceOffer(),
        filePath,
      })).rejects.toThrow('File write made no progress');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the streaming magic line is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      await writeFile(filePath, `not-magic\n{}\n`, 'utf8');

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).rejects.toThrow(/legacy/i);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when the header line is not valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      await writeFile(filePath, `${WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC}\nnot-json\n`, 'utf8');

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).rejects.toThrow('Invalid workspace replication source offer');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when an entry line does not match the manifest entry schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-replication-offer-format-'));
    try {
      const filePath = join(dir, 'offer.txt');
      const header = JSON.stringify({
        offerId: 'offer_1',
        relationshipId: 'rel_1',
        directionId: 'dir_1',
        sourceFingerprint: `sha256:${'a'.repeat(64)}`,
      });
      const badEntry = JSON.stringify({
        // Absolute paths are rejected by WorkspaceManifestEntrySchema.
        relativePath: '/etc/passwd',
        kind: 'file',
        digest: `sha256:${'b'.repeat(64)}`,
        sizeBytes: 1,
        executable: false,
      });
      await writeFile(filePath, `${WORKSPACE_REPLICATION_SOURCE_OFFER_STREAM_MAGIC}\n${header}\n${badEntry}\n`, 'utf8');

      await expect(readWorkspaceReplicationSourceOfferFromFile({
        transferId: 'transfer_1',
        filePath,
      })).rejects.toThrow('Invalid workspace replication source offer');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
