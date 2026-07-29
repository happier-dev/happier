import { describe, expect, it } from 'vitest';
import {
  SessionOwnerMetadataV1Schema,
  sealSessionOwnerMetadataV1,
} from '@happier-dev/protocol';

import {
  decryptSessionPayload,
  decryptStoredSessionPayload,
  encryptSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionOwnerMetadata,
  tryDecryptSessionOwnerMetadataView,
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

  it('strictly parses layout-v1 shared metadata and rejects owner-only or future-layout fields', () => {
    const credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    } as const;

    expect(tryDecryptSessionMetadata({
      credentials,
      rawSession: {
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({
          v: 1,
          summary: { text: 'Safe title', updatedAt: 10 },
        }),
      },
    })).toEqual({
      v: 1,
      summary: { text: 'Safe title', updatedAt: 10 },
    });

    expect(tryDecryptSessionMetadata({
      credentials,
      rawSession: {
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({
          v: 1,
          path: '/owner-only-worktree',
        }),
      },
    })).toBeNull();

    expect(tryDecryptSessionMetadata({
      credentials,
      rawSession: {
        encryptionMode: 'plain',
        metadataLayoutVersion: 2,
        metadata: JSON.stringify({
          v: 2,
          future: 'unsupported',
        }),
      },
    })).toBeNull();
  });

  it('opens owner metadata with account credentials even when transcript storage is plain', () => {
    const machineKey = new Uint8Array(32).fill(11);
    const credentials = {
      token: 't',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(12), machineKey },
    } as const;
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/worktree',
        machineId: 'machine-private',
      },
      nativeSession: {
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-private',
          remoteSessionId: 'native-private',
          source: { kind: 'codexHome', home: 'user' },
          linkedAtMs: 1,
        },
      },
    });
    const ciphertext = sealSessionOwnerMetadataV1({
      material: { type: 'dataKey', machineKey },
      ownerMetadata,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    const opened = tryDecryptSessionOwnerMetadata({
      credentials,
      rawSession: {
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        ownerMetadata: ciphertext,
      },
    });

    expect(opened).toEqual(ownerMetadata);
    expect(opened?.workspace?.path).toBe('/private/worktree');

    expect(tryDecryptSessionOwnerMetadata({
      credentials,
      rawSession: {
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        ownerMetadata: JSON.stringify(ownerMetadata),
      },
    })).toBeNull();
  });

  it('projects a layout-v1 owner-only runtime descriptor into the local owner view', () => {
    const secret = new Uint8Array(32).fill(13);
    const credentials = {
      token: 't',
      encryption: { type: 'legacy', secret },
    } as const;
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: { path: '/private/worktree' },
      nativeSession: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'grok',
          providerSessionId: 'provider-parent',
        },
      },
    });
    const ownerMetadataCiphertext = sealSessionOwnerMetadataV1({
      material: { type: 'legacy', secret },
      ownerMetadata,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    expect(tryDecryptSessionOwnerMetadataView({
      credentials,
      rawSession: {
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: ownerMetadataCiphertext,
      },
    })).toMatchObject({
      path: '/private/worktree',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'grok',
        agent: { providerSessionId: 'provider-parent' },
      },
    });
  });
});
