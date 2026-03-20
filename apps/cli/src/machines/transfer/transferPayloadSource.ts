import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { createTransferManifestHash } from './transferChunkEncryption';

type TransferPayloadDispose = () => Promise<void> | void;

type TransferPayloadSourceBase = Readonly<{
  sizeBytes?: number;
  manifestHash?: string;
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
  dispose?: TransferPayloadDispose;
}>): TransferPayloadSource {
  return {
    kind: 'file',
    filePath: input.filePath,
    ...(typeof input.sizeBytes === 'number' ? { sizeBytes: input.sizeBytes } : {}),
    ...(typeof input.manifestHash === 'string' ? { manifestHash: input.manifestHash } : {}),
    ...(input.dispose ? { dispose: input.dispose } : {}),
  };
}

export async function resolveTransferPayloadSizeBytes(source: TransferPayloadSource): Promise<number> {
  if (typeof source.sizeBytes === 'number') {
    return source.sizeBytes;
  }
  if (source.kind === 'buffer') {
    return source.payload.length;
  }
  const fileStats = await stat(source.filePath);
  return fileStats.size;
}

export async function resolveTransferPayloadManifestHash(source: TransferPayloadSource): Promise<string> {
  if (typeof source.manifestHash === 'string' && source.manifestHash.length > 0) {
    return source.manifestHash;
  }
  if (source.kind === 'buffer') {
    return createTransferManifestHash(source.payload);
  }
  return await createTransferManifestHashFromFile(source.filePath);
}

async function createTransferManifestHashFromFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
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
  const file = await open(input.source.filePath, 'r');
  try {
    const chunkBuffer = Buffer.allocUnsafe(input.length);
    const { bytesRead } = await file.read(chunkBuffer, 0, input.length, input.offset);
    return chunkBuffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export async function disposeTransferPayloadSource(source: TransferPayloadSource | null | undefined): Promise<void> {
  await source?.dispose?.();
}
