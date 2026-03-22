import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

function createSha256Digest(payload: Buffer): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function expectInvalidFormatError(callback: () => unknown): void {
  try {
    callback();
    throw new Error('Expected callback to throw');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'invalid_blob_pack_format',
    });
  }
}

describe('workspaceReplicationBlobPackFormatV1', () => {
  it('encodes and parses the v1 header, blob record header, and end marker', async () => {
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);
    const {
      createWorkspaceReplicationBlobPackHeaderBuffer,
      createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer,
      createWorkspaceReplicationBlobPackEndMarkerBuffer,
      parseWorkspaceReplicationBlobPackHeader,
      parseWorkspaceReplicationBlobPackBlobRecordHeader,
      parseWorkspaceReplicationBlobPackEndMarker,
    } = await import('./workspaceReplicationBlobPackFormatV1');

    expect(parseWorkspaceReplicationBlobPackHeader(
      createWorkspaceReplicationBlobPackHeaderBuffer(),
    )).toEqual({
      version: 1,
    });
    expect(parseWorkspaceReplicationBlobPackBlobRecordHeader(
      createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer({
        digest,
        sizeBytes: payload.length,
      }),
    )).toEqual({
      digest,
      sizeBytes: payload.length,
    });
    expect(parseWorkspaceReplicationBlobPackEndMarker(
      createWorkspaceReplicationBlobPackEndMarkerBuffer(),
    )).toEqual({
      kind: 'end',
    });
  });

  it('rejects a blob-pack header with invalid magic bytes', async () => {
    const {
      createWorkspaceReplicationBlobPackHeaderBuffer,
      parseWorkspaceReplicationBlobPackHeader,
    } = await import('./workspaceReplicationBlobPackFormatV1');
    const header = createWorkspaceReplicationBlobPackHeaderBuffer();
    header.write('NOPE', 0, 'utf8');

    expectInvalidFormatError(() => parseWorkspaceReplicationBlobPackHeader(header));
  });

  it('rejects a blob-pack header with an unsupported version', async () => {
    const {
      createWorkspaceReplicationBlobPackHeaderBuffer,
      parseWorkspaceReplicationBlobPackHeader,
    } = await import('./workspaceReplicationBlobPackFormatV1');
    const header = createWorkspaceReplicationBlobPackHeaderBuffer();
    header[4] = 0x02;

    expectInvalidFormatError(() => parseWorkspaceReplicationBlobPackHeader(header));
  });

  it('rejects a blob record header with an unsupported record type', async () => {
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);
    const {
      createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer,
      parseWorkspaceReplicationBlobPackBlobRecordHeader,
    } = await import('./workspaceReplicationBlobPackFormatV1');
    const recordHeader = createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer({
      digest,
      sizeBytes: payload.length,
    });
    recordHeader[0] = 0x07;

    expectInvalidFormatError(() => parseWorkspaceReplicationBlobPackBlobRecordHeader(recordHeader));
  });

  it('rejects a blob record header with an unsupported digest algorithm', async () => {
    const payload = Buffer.from('hello\n', 'utf8');
    const digest = createSha256Digest(payload);
    const {
      createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer,
      parseWorkspaceReplicationBlobPackBlobRecordHeader,
    } = await import('./workspaceReplicationBlobPackFormatV1');
    const recordHeader = createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer({
      digest,
      sizeBytes: payload.length,
    });
    recordHeader[1] = 0x09;

    expectInvalidFormatError(() => parseWorkspaceReplicationBlobPackBlobRecordHeader(recordHeader));
  });
});
