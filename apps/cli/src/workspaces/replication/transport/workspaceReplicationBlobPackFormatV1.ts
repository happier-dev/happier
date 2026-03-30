const WORKSPACE_REPLICATION_BLOB_PACK_MAGIC = Buffer.from('HWRP', 'utf8');
const WORKSPACE_REPLICATION_BLOB_PACK_VERSION = 0x01;
const WORKSPACE_REPLICATION_BLOB_RECORD_TYPE = 0x01;
const WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER = 0xFF;
const WORKSPACE_REPLICATION_BLOB_ALGORITHM_SHA256 = 0x01;
const WORKSPACE_REPLICATION_BLOB_PACK_HEADER_BYTES = 8;
const WORKSPACE_REPLICATION_BLOB_RECORD_HEADER_BYTES = 44;
const WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER_BYTES = 8;

export class WorkspaceReplicationBlobPackFormatError extends Error {
  readonly code: 'invalid_blob_pack_format' | 'blob_digest_mismatch' | 'blob_too_large';

  constructor(code: 'invalid_blob_pack_format' | 'blob_digest_mismatch' | 'blob_too_large', message: string) {
    super(message);
    this.name = 'WorkspaceReplicationBlobPackFormatError';
    this.code = code;
  }
}

function createInvalidBlobPackFormatError(message: string): WorkspaceReplicationBlobPackFormatError {
  return new WorkspaceReplicationBlobPackFormatError('invalid_blob_pack_format', message);
}

function assertBufferLength(buffer: Uint8Array, expectedLength: number, label: string): Buffer {
  if (buffer.byteLength !== expectedLength) {
    throw createInvalidBlobPackFormatError(`Workspace replication blob pack ${label} has invalid length`);
  }
  return Buffer.from(buffer);
}

function decodeDigestBytes(digest: string): Buffer {
  if (!digest.startsWith('sha256:')) {
    throw createInvalidBlobPackFormatError(`Workspace replication blob pack digest is unsupported: ${digest}`);
  }
  const digestHex = digest.slice('sha256:'.length);
  if (!/^[a-f0-9]{64}$/u.test(digestHex)) {
    throw createInvalidBlobPackFormatError(`Workspace replication blob pack digest is invalid: ${digest}`);
  }
  return Buffer.from(digestHex, 'hex');
}

export function createWorkspaceReplicationBlobPackHeaderBuffer(): Buffer {
  return Buffer.from([
    ...WORKSPACE_REPLICATION_BLOB_PACK_MAGIC,
    WORKSPACE_REPLICATION_BLOB_PACK_VERSION,
    0x00,
    0x00,
    0x00,
  ]);
}

export function createWorkspaceReplicationBlobPackBlobRecordHeaderBuffer(input: Readonly<{
  digest: string;
  sizeBytes: number;
}>): Buffer {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw createInvalidBlobPackFormatError(`Workspace replication blob pack size is invalid: ${input.sizeBytes}`);
  }
  const header = Buffer.alloc(WORKSPACE_REPLICATION_BLOB_RECORD_HEADER_BYTES);
  header[0] = WORKSPACE_REPLICATION_BLOB_RECORD_TYPE;
  header[1] = WORKSPACE_REPLICATION_BLOB_ALGORITHM_SHA256;
  header.writeBigUInt64BE(BigInt(input.sizeBytes), 4);
  decodeDigestBytes(input.digest).copy(header, 12);
  return header;
}

export function createWorkspaceReplicationBlobPackEndMarkerBuffer(): Buffer {
  return Buffer.from([
    WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

export function parseWorkspaceReplicationBlobPackHeader(buffer: Uint8Array): Readonly<{
  version: 1;
}> {
  const header = assertBufferLength(buffer, WORKSPACE_REPLICATION_BLOB_PACK_HEADER_BYTES, 'header');
  if (!header.subarray(0, WORKSPACE_REPLICATION_BLOB_PACK_MAGIC.length).equals(WORKSPACE_REPLICATION_BLOB_PACK_MAGIC)) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack magic is invalid');
  }
  if (header[4] !== WORKSPACE_REPLICATION_BLOB_PACK_VERSION) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack version is unsupported');
  }
  if (!header.subarray(5).equals(Buffer.alloc(3))) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack header reserved bytes must be zero');
  }
  return {
    version: 1,
  };
}

export function parseWorkspaceReplicationBlobPackBlobRecordHeader(buffer: Uint8Array): Readonly<{
  digest: string;
  sizeBytes: number;
}> {
  const header = assertBufferLength(buffer, WORKSPACE_REPLICATION_BLOB_RECORD_HEADER_BYTES, 'blob record header');
  if (header[0] !== WORKSPACE_REPLICATION_BLOB_RECORD_TYPE) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack record type is unsupported');
  }
  if (header[1] !== WORKSPACE_REPLICATION_BLOB_ALGORITHM_SHA256) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack digest algorithm is unsupported');
  }
  if (header[2] !== 0x00 || header[3] !== 0x00) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack record reserved bytes must be zero');
  }
  const sizeBytes = header.readBigUInt64BE(4);
  if (sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack blob size exceeds supported range');
  }
  return {
    digest: `sha256:${header.subarray(12, 44).toString('hex')}`,
    sizeBytes: Number(sizeBytes),
  };
}

export function parseWorkspaceReplicationBlobPackEndMarker(buffer: Uint8Array): Readonly<{
  kind: 'end';
}> {
  const marker = assertBufferLength(buffer, WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER_BYTES, 'end marker');
  if (marker[0] !== WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack end marker is invalid');
  }
  if (!marker.subarray(1).equals(Buffer.alloc(7))) {
    throw createInvalidBlobPackFormatError('Workspace replication blob pack end marker reserved bytes must be zero');
  }
  return {
    kind: 'end',
  };
}

export {
  WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER,
  WORKSPACE_REPLICATION_BLOB_PACK_END_MARKER_BYTES,
  WORKSPACE_REPLICATION_BLOB_PACK_HEADER_BYTES,
  WORKSPACE_REPLICATION_BLOB_RECORD_HEADER_BYTES,
};
