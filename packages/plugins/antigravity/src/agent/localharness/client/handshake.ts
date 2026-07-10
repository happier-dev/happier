import type {
  ExecLoopbackWebSocketEndpointCodecV1,
  ExecLoopbackWebSocketEndpointV1,
} from '@happier-dev/plugin-sdk';

import type {
  AntigravityLocalharnessInputConfig,
  AntigravityLocalharnessOutputConfig,
} from './protocol.js';

export const LOCALHARNESS_DESCRIPTOR_SHA256 = 'e19c0670578bf891c96e470ed21cf2f6243f3983b559a3ae6d91236ce8c2f89d';
export const LOCALHARNESS_PROTOCOL_FINGERPRINT = `antigravity-localharness-v1:${LOCALHARNESS_DESCRIPTOR_SHA256}`;

const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_LENGTH_DELIMITED = 2;

function encodeVarint(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Antigravity localharness protobuf varint requires a non-negative safe integer.');
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function encodeTag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeStringField(fieldNumber: number, value: string): number[] {
  const encoded = new TextEncoder().encode(value);
  return [...encodeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED), ...encodeVarint(encoded.byteLength), ...encoded];
}

function encodeMessageField(fieldNumber: number, payload: Uint8Array): number[] {
  return [...encodeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED), ...encodeVarint(payload.byteLength), ...payload];
}

function encodeClientInfo(config: AntigravityLocalharnessInputConfig['clientInfo']): Uint8Array {
  return Uint8Array.from([
    ...encodeStringField(1, config.language),
    ...encodeStringField(2, config.version),
    ...encodeStringField(3, config.languageVersion),
  ]);
}

export function encodeInputConfigFrame(config: AntigravityLocalharnessInputConfig): Uint8Array {
  return Uint8Array.from([
    ...encodeStringField(1, config.storageDirectory ?? ''),
    ...encodeMessageField(4, encodeClientInfo(config.clientInfo)),
  ]);
}

function decodeVarint(bytes: Uint8Array, offset: number): Readonly<{ value: number; offset: number }> {
  let value = 0;
  let multiplier = 1;
  let cursor = offset;
  while (cursor < bytes.byteLength) {
    const byte = bytes[cursor]!;
    value += (byte & 0x7f) * multiplier;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    multiplier *= 128;
    if (multiplier > Number.MAX_SAFE_INTEGER) break;
  }
  throw new Error('Antigravity localharness OutputConfig protobuf varint is malformed.');
}

function readLengthDelimited(bytes: Uint8Array, offset: number): Readonly<{ value: Uint8Array; offset: number }> {
  const length = decodeVarint(bytes, offset);
  const end = length.offset + length.value;
  if (end > bytes.byteLength) {
    throw new Error('Antigravity localharness OutputConfig protobuf string is truncated.');
  }
  return { value: bytes.slice(length.offset, end), offset: end };
}

function skipUnknownField(bytes: Uint8Array, wireType: number, offset: number): number {
  if (wireType === WIRE_TYPE_VARINT) return decodeVarint(bytes, offset).offset;
  if (wireType === WIRE_TYPE_LENGTH_DELIMITED) return readLengthDelimited(bytes, offset).offset;
  throw new Error(`Antigravity localharness OutputConfig contains unsupported protobuf wire type ${wireType}.`);
}

export function decodeOutputConfigFrame(frame: Uint8Array): AntigravityLocalharnessOutputConfig {
  let offset = 0;
  let port: number | null = null;
  let apiKey: string | null = null;
  const decoder = new TextDecoder();

  while (offset < frame.byteLength) {
    const tag = decodeVarint(frame, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x7;
    if (fieldNumber === 1 && wireType === WIRE_TYPE_VARINT) {
      const decoded = decodeVarint(frame, offset);
      port = decoded.value;
      offset = decoded.offset;
      continue;
    }
    if (fieldNumber === 2 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      const decoded = readLengthDelimited(frame, offset);
      apiKey = decoder.decode(decoded.value);
      offset = decoded.offset;
      continue;
    }
    offset = skipUnknownField(frame, wireType, offset);
  }

  const decodedPort = port;
  if (decodedPort === null || !Number.isInteger(decodedPort) || decodedPort < 1 || decodedPort > 65535) {
    throw new Error('Antigravity localharness OutputConfig is missing a valid loopback port.');
  }
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('Antigravity localharness OutputConfig is missing a loopback API key.');
  }
  return {
    protocolFingerprint: LOCALHARNESS_PROTOCOL_FINGERPRINT,
    port: decodedPort,
    apiKey,
  };
}

export type AntigravityLocalharnessEndpoint = ExecLoopbackWebSocketEndpointV1 & Readonly<{
  protocolFingerprint: string;
  apiKey: string;
}>;

export const antigravityLocalharnessEndpointCodec: ExecLoopbackWebSocketEndpointCodecV1 = Object.freeze({
  decodeHandshakeResponse(response) {
    const decoded = decodeOutputConfigFrame(response);
    return {
      protocolFingerprint: decoded.protocolFingerprint,
      host: 'localhost',
      port: decoded.port,
      path: '/',
      apiKey: decoded.apiKey,
    };
  },
  buildHeaders(endpoint) {
    const apiKey = typeof endpoint.apiKey === 'string' ? endpoint.apiKey : '';
    return [{ name: 'x-goog-api-key', value: apiKey, sensitive: true }];
  },
});
