import { multiAgentPage } from '../../../../packages/session-core/src/raw/__fixtures__/multiAgentPage';
import { describe, expect, it } from 'vitest';
import { createCipheriv } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import fixtures from '../../../../packages/protocol/src/crypto/fixtures/sessionMessageContentV1.json';
import inflateBounds from '../../../../packages/protocol/src/crypto/fixtures/contentInflateBoundsV1.json';
import { packSessionDataKeyBundle } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { openSessionDataKeyBundle, sealSessionMessageDataKeyBundle } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { decodeBase64, decryptResult, encryptSessionMessage, encryptWithDataKey } from './encryption';
import { encryptSessionPayload, encryptSessionMessagePayload } from '../session/transport/encryption/sessionStoredContentCodec';

const key = decodeBase64(fixtures.keyBase64);
describe('SessionMessage content Node/WebCrypto compatibility', () => {
  it.each(['legacy', 'dataKey'] as const)('returns invalid_payload for an authenticated %s gzip bomb', async variant => {
    const frame = decodeBase64(inflateBounds.vectors[1].frameBase64);
    let ciphertext: Uint8Array;
    if (variant === 'legacy') {
      const nonce = new Uint8Array(tweetnacl.secretbox.nonceLength);
      ciphertext = new Uint8Array([...nonce, ...tweetnacl.secretbox(frame, nonce, key)]);
    } else {
      const nonce = new Uint8Array(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(frame), cipher.final()]);
      ciphertext = packSessionDataKeyBundle({ nonce, ciphertext: encrypted, authTag: cipher.getAuthTag(), version: 1 });
    }
    expect(decryptResult(key, variant, ciphertext).status).toBe('invalid_payload');
    if (variant === 'dataKey') expect((await openSessionDataKeyBundle(ciphertext, key)).status).toBe('invalid_payload');
  });

  it.each(fixtures.vectors)('opens shared $name bytes', vector => {
    expect(decryptResult(key, vector.variant === 'legacy' ? 'legacy' : 'dataKey', decodeBase64(vector.ciphertextBase64)))
      .toEqual({ status: 'authenticated', value: vector.value });
  });

  it('measures actual old/new AES bytes on the canonical mixed-Agent transcript fixture', () => {
    const rows = multiAgentPage.map(row => {
      const before = encryptWithDataKey(row.raw, key).byteLength;
      const ciphertext = encryptSessionMessage(key, 'dataKey', row.raw);
      expect(ciphertext.byteLength).toBeLessThanOrEqual(before + 1);
      expect(decryptResult(key, 'dataKey', ciphertext)).toEqual({ status: 'authenticated', value: row.raw });
      return { id: row.id, beforeCipherBytes: before, afterCipherBytes: ciphertext.byteLength };
    });
    console.info('SESSION_MESSAGE_CODEC_BYTE_SHAPE', JSON.stringify(rows));
  });

  it('opens fresh web messages with Node and Node messages with web while generic writers retain V0', async () => {
    const value = { text: 'cross adapter 🗝️'.repeat(128) };
    expect(decryptResult(key, 'dataKey', await sealSessionMessageDataKeyBundle(value, key))).toEqual({ status: 'authenticated', value });
    expect(await openSessionDataKeyBundle(encryptSessionMessage(key, 'dataKey', value), key)).toEqual({ status: 'authenticated', value });
    expect(encryptWithDataKey(value, key)[0]).toBe(0);
  });

  it('rejects a swapped AES envelope version after authentication instead of reinterpreting content', async () => {
    for (const bytes of [encryptWithDataKey({ text: 'historical' }, key), encryptSessionMessage(key, 'dataKey', { text: 'framed' })]) {
      const swapped = bytes.slice(); swapped[0] = swapped[0] === 0 ? 1 : 0;
      expect(decryptResult(key, 'dataKey', swapped)).toEqual({ status: 'invalid_payload' });
      expect(await openSessionDataKeyBundle(swapped, key)).toEqual({ status: 'invalid_payload' });
    }
  });

  it.each(['legacy', 'dataKey'] as const)('separates %s historical and framed idempotent nonces and keeps retries stable', encryptionVariant => {
    const params = { ctx: { encryptionKey: key, encryptionVariant }, payload: { text: 'same logical input'.repeat(64) }, idempotencyKey: 'codec-fixture' };
    const old = decodeBase64(encryptSessionPayload(params));
    const message = encryptSessionMessagePayload(params);
    const framed = decodeBase64(message);
    const offset = encryptionVariant === 'dataKey' ? 1 : 0;
    const length = encryptionVariant === 'dataKey' ? 12 : 24;
    expect(framed.slice(offset, offset + length)).not.toEqual(old.slice(offset, offset + length));
    expect(encryptSessionMessagePayload(params)).toBe(message);
    expect(decryptResult(key, encryptionVariant, framed)).toEqual({ status: 'authenticated', value: params.payload });
  });

  it.each(fixtures.messageNonceVectors)('binds exact raw content-frame bytes in the $variant fixed nonce vector', vector => {
    const encryptionVariant = vector.variant === 'legacy' ? 'legacy' : 'dataKey';
    const bytes = decodeBase64(encryptSessionMessagePayload({ ctx: { encryptionKey: key, encryptionVariant }, payload: vector.value, idempotencyKey: vector.idempotencyKey }));
    const offset = encryptionVariant === 'dataKey' ? 1 : 0;
    expect(bytes.slice(offset, offset + decodeBase64(vector.nonceBase64).length)).toEqual(decodeBase64(vector.nonceBase64));
  });

  it.each(['legacy', 'dataKey'] as const)('fails closed for %s tampering and wrong keys', variant => {
    const bytes = encryptSessionMessage(key, variant, { text: 'private content'.repeat(128) });
    const tampered = bytes.slice(); tampered[tampered.length - 1] ^= 1;
    expect(decryptResult(key, variant, tampered)).toEqual({ status: 'authentication_failed' });
    expect(decryptResult(new Uint8Array(32).fill(255), variant, bytes)).toEqual({ status: 'authentication_failed' });
  });
});
