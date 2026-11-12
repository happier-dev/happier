import { CONTENT_VALUE_MAX_DECODED_BYTES, frameContentBytes, parseContentValue, readContentFrame, serializeContentValue, type ContentValueResult } from './contentByteCodec.js';

async function transformGzip(bytes: Uint8Array, direction: 'compress' | 'decompress'): Promise<Uint8Array> {
  const transform = direction === 'compress' ? new CompressionStream('gzip') : new DecompressionStream('gzip');
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(transform);
  if (direction === 'compress') return new Uint8Array(await new Response(stream).arrayBuffer());

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > CONTENT_VALUE_MAX_DECODED_BYTES - length) {
        await reader.cancel();
        throw new RangeError('Content exceeds the decoded byte ceiling');
      }
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function encodeContentValueWeb(value: unknown): Promise<Uint8Array> {
  const raw = serializeContentValue(value);
  return frameContentBytes(raw, await transformGzip(raw, 'compress'));
}

export async function decodeContentValueWeb(frame: Uint8Array): Promise<ContentValueResult> {
  const content = readContentFrame(frame);
  if (content.status !== 'ready') return content;
  try {
    return parseContentValue(content.encoding === 'gzip' ? await transformGzip(content.bytes, 'decompress') : content.bytes);
  } catch {
    return { status: 'invalid_payload' };
  }
}

export async function decodeLegacyContentValueWeb(bytes: Uint8Array): Promise<ContentValueResult> {
  return bytes[0] === 0 || bytes[0] === 1 ? await decodeContentValueWeb(bytes) : parseContentValue(bytes);
}
