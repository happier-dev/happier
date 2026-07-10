export function splitStringByCodePoints(text: string, chunkSize: number): string[] {
  const normalizedChunkSize = Math.max(1, Math.trunc(chunkSize));
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += normalizedChunkSize) {
    chunks.push(codePoints.slice(index, index + normalizedChunkSize).join(''));
  }
  return chunks;
}

export function splitBufferByBytes(buffer: Buffer, chunkSize: number): Buffer[] {
  if (buffer.length === 0) return [];
  const normalizedChunkSize = Math.max(1, Math.trunc(chunkSize));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += normalizedChunkSize) {
    chunks.push(buffer.subarray(offset, offset + normalizedChunkSize));
  }
  return chunks;
}
