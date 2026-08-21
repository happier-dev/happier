import { describe, expect, it } from 'vitest';

import {
  decryptSessionPayload,
  decryptStoredSessionPayload,
  encryptSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
} from './sessionEncryptionContext';

describe.each(['legacy', 'dataKey'] as const)('idempotent session payload encryption (%s)', (encryptionVariant) => {
  const ctx = {
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant,
  } as const;

  it('reuses exact ciphertext only for the same local id and frozen payload', () => {
    const payload = { role: 'user', content: { type: 'text', text: 'continue' } };
    const first = encryptSessionPayload({ ctx, payload, idempotencyKey: 'continuation:one' });
    const retry = encryptSessionPayload({ ctx, payload, idempotencyKey: 'continuation:one' });
    const changedPayload = encryptSessionPayload({
      ctx,
      payload: { role: 'user', content: { type: 'text', text: 'different' } },
      idempotencyKey: 'continuation:one',
    });
    const changedIdentity = encryptSessionPayload({ ctx, payload, idempotencyKey: 'continuation:two' });

    expect(retry).toBe(first);
    expect(changedPayload).not.toBe(first);
    expect(changedIdentity).not.toBe(first);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: first })).toEqual(payload);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: changedPayload })).toEqual({
      role: 'user',
      content: { type: 'text', text: 'different' },
    });
  });

  it('keeps ordinary sends randomly encrypted when no idempotency key is supplied', () => {
    const payload = { role: 'user', content: { type: 'text', text: 'ordinary send' } };

    const first = encryptSessionPayload({ ctx, payload });
    const second = encryptSessionPayload({ ctx, payload });

    expect(second).not.toBe(first);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: first })).toEqual(payload);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: second })).toEqual(payload);
  });
});

/**
 * A sealed Pending row outlives the process that wrote it: a retry after a daemon
 * restart must re-derive the same nonce or the message owner refuses the re-enqueue
 * as a content conflict. These vectors were derived once and are asserted forever,
 * so any per-process salt, clock, or random input entering the derivation fails here.
 */
describe('idempotent nonce derivation is stable across processes', () => {
  const payload = { role: 'user', content: { type: 'text', text: 'switch agent and continue' } };
  const frozenNonceHexByVariant = {
    legacy: 'ed48ddf2400b753f3590b9258dd02eb10a9a3d6d9ee8c3b9',
    dataKey: '79fb9321e0bdc71fdc410f60',
  } as const;

  it.each(['legacy', 'dataKey'] as const)('re-derives the frozen %s nonce', (encryptionVariant) => {
    const ctx = { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant } as const;

    const sealed = Buffer.from(
      encryptSessionPayload({ ctx, payload, idempotencyKey: 'transition-local-1' }),
      'base64',
    );
    // Legacy prefixes the 24-byte secretbox nonce; dataKey prefixes a version byte
    // before its 12-byte GCM nonce.
    const nonce = encryptionVariant === 'legacy' ? sealed.subarray(0, 24) : sealed.subarray(1, 13);

    expect(nonce.toString('hex')).toBe(frozenNonceHexByVariant[encryptionVariant]);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: sealed.toString('base64') })).toEqual(payload);
  });
});

describe('decryptStoredSessionPayload (plaintext)', () => {
  const ctx = {
    encryptionKey: new Uint8Array(32).fill(1),
    encryptionVariant: 'legacy',
  } as const;

  it('resolves stored content mode from session.encryptionMode', () => {
    expect(resolveSessionStoredContentEncryptionMode(undefined)).toBe('e2ee');
    expect(resolveSessionStoredContentEncryptionMode({})).toBe('e2ee');
    expect(resolveSessionStoredContentEncryptionMode({ encryptionMode: 'e2ee' })).toBe('e2ee');
    expect(resolveSessionStoredContentEncryptionMode({ encryptionMode: 'plain' })).toBe('plain');
  });

  it('parses JSON when mode is plain', () => {
    const res = decryptStoredSessionPayload({
      mode: 'plain',
      ctx,
      value: '{"type":"user","text":"hi"}',
    });
    expect(res).toEqual({ type: 'user', text: 'hi' });
  });

  it('stringifies JSON when mode is plain', () => {
    const wire = encryptStoredSessionPayload({
      mode: 'plain',
      ctx,
      payload: { type: 'user', text: 'hi' },
    });
    expect(wire).toBe('{"type":"user","text":"hi"}');
  });

  it('returns null when plaintext JSON is malformed', () => {
    const res = decryptStoredSessionPayload({
      mode: 'plain',
      ctx,
      value: '{',
    });
    expect(res).toBeNull();
  });

  it('decrypts plaintext session metadata without using encryption', () => {
    const credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    } as const;

    const res = tryDecryptSessionMetadata({
      credentials,
      rawSession: {
        encryptionMode: 'plain',
        metadata: '{"flavor":"default","host":"example","path":"/tmp"}',
      },
    });

    expect(res).toEqual({ flavor: 'default', host: 'example', path: '/tmp' });
  });
});
