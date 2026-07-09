import { createHash } from 'node:crypto';

export function utf8Bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf8'));
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function repeatBytes(chunk: Uint8Array, count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`repeat count must be a non-negative integer: ${count}`);
  }
  return concatBytes(Array.from({ length: count }, () => chunk));
}

export function bytesSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function splitBytes(bytes: Uint8Array, maxFrameBytes: number): readonly Uint8Array[] {
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new Error(`maxFrameBytes must be a positive integer: ${maxFrameBytes}`);
  }

  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maxFrameBytes) {
    frames.push(bytes.slice(offset, Math.min(offset + maxFrameBytes, bytes.byteLength)));
  }
  return frames;
}
