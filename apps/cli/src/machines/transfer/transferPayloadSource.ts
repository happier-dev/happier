import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { createTransferManifestHash } from '@happier-dev/transfers/node';

type TransferPayloadDispose = () => Promise<void> | void;

type TransferPayloadSourceBase = Readonly<{
  sizeBytes?: number;
  manifestHash?: string;
  name?: string;
  dispose?: TransferPayloadDispose;
}>;

export type TransferPayloadSource =
  | Readonly<TransferPayloadSourceBase & {
      kind: 'buffer';
      payload: Buffer;
    }>
  | Readonly<TransferPayloadSourceBase & {
      kind: 'file';
      filePath: string;
      sourceOffsetBytes?: number;
    }>;

export function createBufferTransferPayloadSource(payload: Buffer): TransferPayloadSource {
  return {
    kind: 'buffer',
    payload,
    sizeBytes: payload.length,
    manifestHash: createTransferManifestHash(payload),
  };
}

export function createFileTransferPayloadSource(input: Readonly<{
  filePath: string;
  sizeBytes?: number;
  manifestHash?: string;
  name?: string;
  sourceOffsetBytes?: number;
  dispose?: TransferPayloadDispose;
}>): TransferPayloadSource {
  const sizeBytes =
    typeof input.sizeBytes === 'number' && Number.isFinite(input.sizeBytes) && input.sizeBytes >= 0
      ? Math.floor(input.sizeBytes)
      : undefined;
  const sourceOffsetBytes = Number.isSafeInteger(input.sourceOffsetBytes)
    && (input.sourceOffsetBytes ?? 0) >= 0
    ? input.sourceOffsetBytes
    : undefined;
  return {
    kind: 'file',
    filePath: input.filePath,
    ...(typeof sourceOffsetBytes === 'number' ? { sourceOffsetBytes } : {}),
    ...(typeof sizeBytes === 'number' ? { sizeBytes } : {}),
    ...(typeof input.manifestHash === 'string' ? { manifestHash: input.manifestHash } : {}),
    ...(typeof input.name === 'string' && input.name.length > 0 ? { name: input.name } : {}),
    ...(input.dispose ? { dispose: input.dispose } : {}),
  };
}

export async function resolveTransferPayloadSizeBytes(source: TransferPayloadSource): Promise<number> {
  if (source.kind === 'buffer') {
    return typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) && source.sizeBytes >= 0
      ? source.sizeBytes
      : source.payload.length;
  }
  const fileStats = await stat(source.filePath);
  const sourceOffsetBytes = source.sourceOffsetBytes ?? 0;
  const sizeBytes = typeof source.sizeBytes === 'number' && Number.isFinite(source.sizeBytes) && source.sizeBytes >= 0
    ? source.sizeBytes
    : fileStats.size - sourceOffsetBytes;
  if (sourceOffsetBytes > fileStats.size || sizeBytes > fileStats.size - sourceOffsetBytes) {
    throw new Error('Transfer payload range exceeds the source file');
  }
  return sizeBytes;
}

export async function resolveTransferPayloadManifestHash(source: TransferPayloadSource): Promise<string> {
  if (typeof source.manifestHash === 'string' && source.manifestHash.length > 0) {
    return source.manifestHash;
  }
  if (source.kind === 'buffer') {
    return createTransferManifestHash(source.payload);
  }
  return await createTransferManifestHashFromFile(
    source.filePath,
    source.sourceOffsetBytes ?? 0,
    await resolveTransferPayloadSizeBytes(source),
  );
}

async function createTransferManifestHashFromFile(filePath: string, sourceOffsetBytes: number, sizeBytes: number): Promise<string> {
  const hash = createHash('sha256');
  if (sizeBytes === 0) return `sha256:${hash.digest('hex')}`;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, {
      start: sourceOffsetBytes,
      end: sourceOffsetBytes + sizeBytes - 1,
    });
    stream.on('data', (chunk) => {
      hash.update(chunk as Buffer);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return `sha256:${hash.digest('hex')}`;
}

export async function readTransferPayloadChunk(input: Readonly<{
  source: TransferPayloadSource;
  offset: number;
  length: number;
}>): Promise<Buffer> {
  if (input.source.kind === 'buffer') {
    return Buffer.from(input.source.payload.subarray(input.offset, input.offset + input.length));
  }
  const sizeBytes = await resolveTransferPayloadSizeBytes(input.source);
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset >= sizeBytes || input.length <= 0) {
    return Buffer.alloc(0);
  }
  const boundedLength = Math.min(input.length, sizeBytes - input.offset);
  const file = await open(input.source.filePath, 'r');
  try {
    const chunkBuffer = Buffer.allocUnsafe(boundedLength);
    const { bytesRead } = await file.read(
      chunkBuffer,
      0,
      boundedLength,
      (input.source.sourceOffsetBytes ?? 0) + input.offset,
    );
    return chunkBuffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export async function disposeTransferPayloadSource(source: TransferPayloadSource | null | undefined): Promise<void> {
  await source?.dispose?.();
}
