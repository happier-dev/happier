import { describe, expect, it } from 'vitest';

import {
  LOCALHARNESS_DESCRIPTOR_SHA256,
  LOCALHARNESS_PROTOCOL_FINGERPRINT,
  decodeAntigravityLocalharnessEndpoint,
  decodeOutputConfigFrame,
  encodeInputConfigFrame,
} from './handshake.js';
import { HANDSHAKE_FIXTURE } from '../__fixtures__/localharness-0.1.4.js';

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function lengthPrefixLittleEndian(payload: Uint8Array): Uint8Array {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.byteLength, 0);
  return Uint8Array.from(Buffer.concat([prefix, Buffer.from(payload)]));
}

describe('Antigravity localharness handshake codec', () => {
  it('encodes InputConfig as descriptor-derived protobuf payload bytes for host little-endian framing', () => {
    const payload = encodeInputConfigFrame({
      storageDirectory: '',
      clientInfo: {
        language: 'happier',
        version: '0.0.0',
        languageVersion: 'typescript',
      },
    });

    expect(Buffer.from(payload).toString('hex')).toBe(HANDSHAKE_FIXTURE.inputConfigPayloadHex);
    expect(Buffer.from(lengthPrefixLittleEndian(payload)).toString('hex')).toBe(HANDSHAKE_FIXTURE.inputConfigFrameHex);
    expect(LOCALHARNESS_DESCRIPTOR_SHA256).toBe(HANDSHAKE_FIXTURE.descriptorSha256);
    expect(HANDSHAKE_FIXTURE.version).toBe('0.1.4');
    expect(LOCALHARNESS_PROTOCOL_FINGERPRINT).toContain(HANDSHAKE_FIXTURE.descriptorSha256.slice(0, 12));
  });

  it('decodes OutputConfig protobuf payload bytes and fails closed when required fields are absent', () => {
    expect(decodeOutputConfigFrame(fromHex(HANDSHAKE_FIXTURE.outputConfigPayloadHex))).toEqual({
      protocolFingerprint: LOCALHARNESS_PROTOCOL_FINGERPRINT,
      port: 43123,
      apiKey: 'loopback-key',
    });

    expect(() => decodeOutputConfigFrame(fromHex('12036b6579'))).toThrow(/port/i);
    expect(() => decodeOutputConfigFrame(fromHex('087b'))).toThrow(/api key/i);
    expect(() => decodeOutputConfigFrame(fromHex('08ffffffff0f12036b6579'))).toThrow(/port/i);
  });

  it('projects child-discovered connection facts into the stable loopback endpoint contract', () => {
    expect(decodeAntigravityLocalharnessEndpoint(
      fromHex(HANDSHAKE_FIXTURE.outputConfigPayloadHex),
    )).toEqual({
      host: '127.0.0.1',
      port: 43123,
      path: '/',
      headers: [{ name: 'x-goog-api-key', value: 'loopback-key', sensitive: true }],
    });
  });
});
