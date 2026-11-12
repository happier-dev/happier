import { parseSerializedJsonValue, stringifySerializedJsonValue } from './serializedJsonValue.js';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '../server/http/requestBodyBoundsV1.js';

/** Compression must not expand a message beyond the owning raw HTTP ingress ceiling. */
export const CONTENT_VALUE_MAX_DECODED_BYTES = SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1;

export type ContentGunzip = (bytes: Uint8Array, options: Readonly<{ maxOutputLength: number }>) => Uint8Array;

export type ContentValueResult =
  | Readonly<{ status: 'authenticated'; value: unknown }>
  | Readonly<{ status: 'invalid_payload' }>;
export type ContentFrameResult =
  | Readonly<{ status: 'ready'; encoding: 'raw' | 'gzip'; bytes: Uint8Array }>
  | Readonly<{ status: 'invalid_payload' }>;

export function serializeContentValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(stringifySerializedJsonValue(value));
}

/** Authenticated content frame: [0 raw UTF-8 / 1 gzip UTF-8 | content]. */
export function frameContentBytes(raw: Uint8Array, gzip: Uint8Array): Uint8Array {
  const compressed = gzip.length < raw.length;
  const selected = compressed ? gzip : raw;
  const frame = new Uint8Array(1 + selected.length);
  frame[0] = compressed ? 1 : 0;
  frame.set(selected, 1);
  return frame;
}

export function readContentFrame(frame: Uint8Array): ContentFrameResult {
  if (frame[0] !== 0 && frame[0] !== 1) return { status: 'invalid_payload' };
  if (frame[0] === 0 && frame.byteLength - 1 > CONTENT_VALUE_MAX_DECODED_BYTES) return { status: 'invalid_payload' };
  return { status: 'ready', encoding: frame[0] === 0 ? 'raw' : 'gzip', bytes: frame.subarray(1) };
}

export function parseContentValue(bytes: Uint8Array): ContentValueResult {
  try {
    return { status: 'authenticated', value: parseSerializedJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { status: 'invalid_payload' };
  }
}

export function encodeContentValue(value: unknown, gzip: (bytes: Uint8Array) => Uint8Array): Uint8Array {
  const raw = serializeContentValue(value);
  return frameContentBytes(raw, gzip(raw));
}

export function decodeContentValue(frame: Uint8Array, gunzip: ContentGunzip): ContentValueResult {
  const content = readContentFrame(frame);
  if (content.status !== 'ready') return content;
  try {
    const bytes = content.encoding === 'gzip'
      ? gunzip(content.bytes, { maxOutputLength: CONTENT_VALUE_MAX_DECODED_BYTES })
      : content.bytes;
    if (bytes.byteLength > CONTENT_VALUE_MAX_DECODED_BYTES) return { status: 'invalid_payload' };
    return parseContentValue(bytes);
  } catch {
    return { status: 'invalid_payload' };
  }
}

/** Historical JSON never begins with either binary frame marker. */
export function decodeLegacyContentValue(bytes: Uint8Array, gunzip: ContentGunzip): ContentValueResult {
  return bytes[0] === 0 || bytes[0] === 1 ? decodeContentValue(bytes, gunzip) : parseContentValue(bytes);
}
