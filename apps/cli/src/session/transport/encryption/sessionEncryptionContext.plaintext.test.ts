import { describe, expect, it } from 'vitest';

import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
} from './sessionEncryptionContext';

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
