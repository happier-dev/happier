import { describe, expect, it } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodeContentValue, decodeContentValue, frameContentBytes, serializeContentValue } from './contentByteCodec.js';
import { decodeContentValueWeb, encodeContentValueWeb } from './contentByteCodecWeb.js';
import { decodeBase64 } from './base64.js';
import { frameSessionDataKeyBundle } from './sessionDataKeyBundleV0.js';
import { openSessionDataKeyBundle, sealSessionMessageDataKeyBundle, sealAesGcmPayloadWebCrypto } from './sessionDataKeyBundleWebCrypto.js';
import fixtures from './fixtures/sessionMessageContentV1.json';
import inflateBounds from './fixtures/contentInflateBoundsV1.json';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '../server/http/requestBodyBoundsV1.js';

describe('SessionMessage content byte codec', () => {
  it.each(inflateBounds.vectors)('bounds Node and web gzip output at the owning ingress ceiling ($name)', async vector => {
    expect(inflateBounds.maxDecodedBytes).toBe(SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1);
    const frame = decodeBase64(vector.frameBase64);
    expect(vector.decodedBytes / frame.byteLength).toBeGreaterThan(1000);
    const node = decodeContentValue(frame, gunzipSync);
    const web = await decodeContentValueWeb(frame);
    expect({ node: node.status, web: web.status }).toEqual({ node: vector.expectedStatus, web: vector.expectedStatus });
    if (node.status === 'authenticated') expect(node.value).toBeNull();
    if (web.status === 'authenticated') expect(web.value).toBeNull();
  });

  it.each([undefined, null, 0, false, '', { text: '跨端 🗝️' }, { text: 'tool output\n'.repeat(256) }])(
    'round trips Node and web compression without a base64 content wrapper (%j)', async value => {
      const node = encodeContentValue(value, gzipSync);
      const web = await encodeContentValueWeb(value);
      expect(decodeContentValue(node, gunzipSync)).toEqual({ status: 'authenticated', value });
      expect(await decodeContentValueWeb(node)).toEqual({ status: 'authenticated', value });
      expect(decodeContentValue(web, gunzipSync)).toEqual({ status: 'authenticated', value });
      const raw = serializeContentValue(value);
      expect(node.length).toBe(Math.min(raw.length, gzipSync(raw).length) + 1);
    });

  it('uses gzip only when its complete framed representation is smaller', () => {
    const raw = new Uint8Array([123, 125]);
    expect(frameContentBytes(raw, raw)[0]).toBe(0);
    expect(frameContentBytes(raw, new Uint8Array(3))[0]).toBe(0);
    expect(frameContentBytes(raw, new Uint8Array(1))[0]).toBe(1);
  });

  it.each([new Uint8Array(), new Uint8Array([2, 123, 125]), new Uint8Array([1, 123]), new Uint8Array([0, 255]), new Uint8Array([0, 123])])(
    'rejects corrupt frames, gzip, UTF-8 and JSON without a plaintext fallback', async bytes => {
      expect(decodeContentValue(bytes, gunzipSync)).toEqual({ status: 'invalid_payload' });
      expect(await decodeContentValueWeb(bytes)).toEqual({ status: 'invalid_payload' });
    });

  it('reports authenticated malformed frame content as invalid_payload', async () => {
    const key = decodeBase64(fixtures.keyBase64);
    for (const bytes of [new Uint8Array([1, 123]), new Uint8Array([2, 123, 125])]) {
      const bundle = frameSessionDataKeyBundle(await sealAesGcmPayloadWebCrypto(bytes, key), 1);
      expect(await openSessionDataKeyBundle(bundle, key)).toEqual({ status: 'invalid_payload' });
    }
  });

  it('opens shared AES historical/raw/gzip vectors through the WebCrypto adapter', async () => {
    const key = decodeBase64(fixtures.keyBase64);
    for (const vector of fixtures.vectors.filter(vector => vector.variant === 'dataKey')) {
      expect(await openSessionDataKeyBundle(decodeBase64(vector.ciphertextBase64), key)).toEqual({ status: 'authenticated', value: vector.value });
    }
    const value = { text: 'web message'.repeat(128) };
    const ciphertext = await sealSessionMessageDataKeyBundle(value, key);
    expect(ciphertext[0]).toBe(1);
    expect(await openSessionDataKeyBundle(ciphertext, key)).toEqual({ status: 'authenticated', value });
  });
});
