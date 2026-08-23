import { describe, expect, it } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  sealSessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';

import {
  decryptSessionPayload,
  deriveSessionInputEqualityTagV1,
  decryptStoredSessionPayload,
  encryptSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionOwnerMetadata,
  tryDecryptSessionOwnerMetadataView,
  tryDecryptSessionMetadata,
} from './sessionEncryptionContext';

describe.each(['legacy', 'dataKey'] as const)('session input encryption and equality (%s)', (encryptionVariant) => {
  const ctx = {
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant,
  } as const;

  it('keeps retry ciphertext randomized while deriving a stable purpose-separated equality tag', () => {
    const payload = { role: 'user', content: { type: 'text', text: 'continue' } };
    const requestedAction = { v: 1 as const, kind: 'send_now' as const };
    const first = encryptSessionPayload({ ctx, payload });
    const retry = encryptSessionPayload({ ctx, payload });
    const firstTag = deriveSessionInputEqualityTagV1({
      ctx,
      sessionId: 'session-one',
      requestEnvelope: payload,
      requestedAction,
    });
    const retryTag = deriveSessionInputEqualityTagV1({
      ctx,
      sessionId: 'session-one',
      requestEnvelope: payload,
      requestedAction,
    });
    const changedPayloadTag = deriveSessionInputEqualityTagV1({
      ctx,
      sessionId: 'session-one',
      requestEnvelope: { role: 'user', content: { type: 'text', text: 'different' } },
      requestedAction,
    });
    const changedSessionTag = deriveSessionInputEqualityTagV1({
      ctx,
      sessionId: 'session-two',
      requestEnvelope: payload,
      requestedAction,
    });
    const changedActionTag = deriveSessionInputEqualityTagV1({
      ctx,
      sessionId: 'session-one',
      requestEnvelope: payload,
      requestedAction: { v: 1, kind: 'enqueue' },
    });

    expect(retry).not.toBe(first);
    expect(retryTag).toBe(firstTag);
    expect(firstTag).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(changedPayloadTag).not.toBe(firstTag);
    expect(changedSessionTag).not.toBe(firstTag);
    expect(changedActionTag).not.toBe(firstTag);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: first })).toEqual(payload);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: retry })).toEqual(payload);
  });

  it('keeps ordinary sends randomly encrypted when no idempotency key is supplied', () => {
    const payload = { role: 'user', content: { type: 'text', text: 'ordinary send' } };

    const first = encryptSessionPayload({ ctx, payload });
    const second = encryptSessionPayload({ ctx, payload });

    expect(second).not.toBe(first);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: first })).toEqual(payload);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: second })).toEqual(payload);
  });

  it('makes an explicit idempotency key deterministic while binding the nonce to the payload', () => {
    const payload = { role: 'agent', content: { type: 'event', data: { type: 'message', text: 'divider' } } };
    const params = { ctx, payload, idempotencyKey: 'agent-transition-divider:local-1' };
    const changedPayload = {
      ...params,
      payload: { role: 'agent', content: { type: 'event', data: { type: 'message', text: 'changed' } } },
    };

    const first = encryptSessionPayload(params);
    const retry = encryptSessionPayload(params);
    const changed = encryptSessionPayload(changedPayload);

    expect(retry).toBe(first);
    expect(changed).not.toBe(first);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: first })).toEqual(payload);
    expect(decryptSessionPayload({ ctx, ciphertextBase64: changed })).toEqual(changedPayload.payload);
  });
});

describe('decryptStoredSessionPayload (plaintext)', () => {
  it('resolves stored content mode from session.encryptionMode', () => {
    expect(resolveSessionStoredContentEncryptionMode(undefined)).toBe('e2ee');
    expect(resolveSessionStoredContentEncryptionMode({})).toBe('e2ee');
    expect(resolveSessionStoredContentEncryptionMode({ encryptionMode: 'e2ee' })).toBe('e2ee');
    expect(resolveSessionStoredContentEncryptionMode({ encryptionMode: 'plain' })).toBe('plain');
  });

  it('parses JSON when mode is plain', () => {
    const res = decryptStoredSessionPayload({
      mode: 'plain',
      ctx: null,
      value: '{"type":"user","text":"hi"}',
    });
    expect(res).toEqual({ type: 'user', text: 'hi' });
  });

  it('stringifies JSON when mode is plain', () => {
    const wire = encryptStoredSessionPayload({
      mode: 'plain',
      ctx: null,
      payload: { type: 'user', text: 'hi' },
    });
    expect(wire).toBe('{"type":"user","text":"hi"}');
  });

  it('returns null when plaintext JSON is malformed', () => {
    const res = decryptStoredSessionPayload({
      mode: 'plain',
      ctx: null,
      value: '{',
    });
    expect(res).toBeNull();
  });

  it('decrypts plaintext session metadata without using encryption', () => {
    const credentials = {
      token: 't',
      encryption: null,
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

  it('keeps retained encrypted metadata locked for token-only credentials', () => {
    expect(tryDecryptSessionMetadata({
      credentials: {
        token: 't',
        encryption: null,
      },
      rawSession: {
        encryptionMode: 'e2ee',
        metadata: 'retained-ciphertext',
      },
    })).toBeNull();
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

  it('opens a plain owner envelope without account encryption material', () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/worktree',
        machineId: 'machine-private',
      },
    });
    const envelope = createPlainSessionOwnerMetadataEnvelopeV1(
      ownerMetadata,
    );

    expect(tryDecryptSessionOwnerMetadata({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      accountEncryptionMode: 'plain',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: envelope,
      },
    })).toEqual(ownerMetadata);
  });

  it('opens an encrypted owner envelope for an E2EE Account independently of Session mode', () => {
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
    const envelope = sealSessionOwnerMetadataEnvelopeV1({
      material: { type: 'dataKey', machineKey },
      ownerMetadata,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    const opened = tryDecryptSessionOwnerMetadata({
      credentials,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: envelope,
      },
    });

    expect(opened).toEqual(ownerMetadata);
    expect(opened?.workspace?.path).toBe('/private/worktree');

    expect(tryDecryptSessionOwnerMetadata({
      credentials,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: envelope,
      },
    })).toEqual(ownerMetadata);
    expect(tryDecryptSessionOwnerMetadata({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      accountEncryptionMode: 'e2ee',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: envelope,
      },
    })).toBeNull();
    expect(tryDecryptSessionOwnerMetadata({
      credentials,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: JSON.stringify(ownerMetadata),
      },
    })).toBeNull();
  });

  it('fails owner-envelope content that disagrees with persisted Account mode closed', () => {
    const machineKey = new Uint8Array(32).fill(17);
    const credentials = {
      token: 't',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(18),
        machineKey,
      },
    } as const;
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/worktree',
        machineId: 'machine-private',
      },
    });
    const encryptedEnvelope = sealSessionOwnerMetadataEnvelopeV1({
      material: { type: 'dataKey', machineKey },
      ownerMetadata,
      randomBytes: (length) => new Uint8Array(length).fill(19),
    });
    const plainEnvelope = createPlainSessionOwnerMetadataEnvelopeV1(
      ownerMetadata,
    );

    expect(tryDecryptSessionOwnerMetadata({
      credentials,
      accountEncryptionMode: 'plain',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: encryptedEnvelope,
      },
    })).toBeNull();
    expect(tryDecryptSessionOwnerMetadata({
      credentials,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: plainEnvelope,
      },
    })).toBeNull();
    expect(tryDecryptSessionOwnerMetadata({
      credentials,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        metadataLayoutVersion: 1,
        ownerMetadata: plainEnvelope,
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
    const ownerMetadataEnvelope = sealSessionOwnerMetadataEnvelopeV1({
      material: { type: 'legacy', secret },
      ownerMetadata,
      randomBytes: (length) => new Uint8Array(length).fill(5),
    });

    expect(tryDecryptSessionOwnerMetadataView({
      credentials,
      accountEncryptionMode: 'e2ee',
      rawSession: {
        encryptionMode: 'e2ee',
        metadataLayoutVersion: 1,
        metadata: encryptStoredSessionPayload({
          mode: 'e2ee',
          ctx: {
            encryptionKey: secret,
            encryptionVariant: 'legacy',
          },
          payload: { v: 1 },
        }),
        ownerMetadata: ownerMetadataEnvelope,
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

  it.each([
    { accountMode: 'plain', sessionMode: 'e2ee' },
    { accountMode: 'e2ee', sessionMode: 'plain' },
  ] as const)(
    'reads External Sessions owner state when Account=$accountMode and Session=$sessionMode',
    ({ accountMode, sessionMode }) => {
      const secret = new Uint8Array(32).fill(23);
      const credentials = {
        token: 't',
        encryption: { type: 'legacy', secret },
      } as const;
      const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
        v: 1,
        nativeSession: {
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-private',
            remoteSessionId: 'external-private',
            source: { kind: 'codexHome', home: 'user' },
            linkedAtMs: 1,
          },
        },
      });
      const ownerMetadataEnvelope = accountMode === 'plain'
        ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata)
        : sealSessionOwnerMetadataEnvelopeV1({
            material: { type: 'legacy', secret },
            ownerMetadata,
            randomBytes: (length) => new Uint8Array(length).fill(24),
          });
      const sharedMetadata = { v: 1 as const };

      expect(tryDecryptSessionOwnerMetadataView({
        credentials,
        accountEncryptionMode: accountMode,
        rawSession: {
          encryptionMode: sessionMode,
          metadataLayoutVersion: 1,
          metadata: sessionMode === 'plain'
            ? JSON.stringify(sharedMetadata)
            : encryptStoredSessionPayload({
                mode: 'e2ee',
                ctx: {
                  encryptionKey: secret,
                  encryptionVariant: 'legacy',
                },
                payload: sharedMetadata,
              }),
          ownerMetadata: ownerMetadataEnvelope,
        },
      })).toMatchObject({
        externalSessionV1: {
          remoteSessionId: 'external-private',
        },
      });
    },
  );
});
