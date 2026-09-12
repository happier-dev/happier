import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encryptStoredSessionPayload, resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: vi.fn(async () => null),
}));

import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

import type { Credentials } from '@/persistence';
import { resolveExistingSessionAttachContext } from './resolveExistingSessionAttachContext';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('resolveExistingSessionAttachContext', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a missing-session-id failure (and does not fetch) when sessionId is blank', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
    };

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: '   ', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, credentials });
    expect(out).toEqual({ ok: false, reason: 'missingSessionId' });
    expect(vi.mocked(fetchSessionByIdCompat)).not.toHaveBeenCalled();
  });

  it('returns a v2 plain attach payload and vendorResumeId for plaintext sessions', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_plain',
        seq: 42,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'codex', path: '/tmp', codexSessionId: 'vendor-plain-1' }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_plain', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, credentials: null });
    expect(out).toMatchObject({
      ok: true,
      attachPayload: {
        v: 2,
        encryptionMode: 'plain',
        lastObservedMessageSeq: 42,
      },
      vendorResumeId: 'vendor-plain-1',
      sessionPath: '/tmp',
      metadata: { flavor: 'codex', path: '/tmp', codexSessionId: 'vendor-plain-1' },
    });
    expect(vi.mocked(fetchSessionByIdCompat)).toHaveBeenCalledTimes(1);
  });

  it('uses the server session sequence without consulting retired delivery watermark metadata', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_owed',
        seq: 42,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', path: '/tmp', deliveredUserMessageSeqV1: 4 }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_owed', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, credentials: null });
    expect(out).toMatchObject({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 42 },
    });
  });

  it('keeps the session seq as the attach cursor when no delivered watermark exists (legacy sessions)', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_legacy',
        seq: 42,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'claude', path: '/tmp' }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_legacy', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, credentials: null });
    expect(out).toMatchObject({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 42 },
    });
  });

  it('returns decrypted plaintext metadata for runtime snapshot restoration', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_plain',
        seq: 42,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'claude',
          path: '/tmp',
          permissionMode: 'yolo',
          permissionModeUpdatedAt: 200,
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'claude-subscription': {
                source: 'connected',
                selection: 'profile',
                profileId: 'claude-work',
              },
            },
          },
        }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_plain', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, credentials: null });
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) throw new Error('Expected successful attach context');
    expect(out.metadata).toMatchObject({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 200,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'claude-work',
          },
        },
      },
    });
  });

  it('returns a v2 e2ee attach payload with an opened DEK and vendorResumeId for encrypted sessions', async () => {
    const seed = new Uint8Array(32).fill(11);
    const compatSecretKey = createHash('sha512').update(seed).digest().subarray(0, 32);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(compatSecretKey).publicKey;
    const dataKey = new Uint8Array(32).fill(4);

    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey,
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });
    const encryptedEnvelopeBase64 = encodeBase64(envelope, 'base64');

    const credentials: Credentials = {
      token: 't',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(8),
        machineKey: seed,
      },
    };

    const metadataCiphertext = encryptStoredSessionPayload({
      mode: 'e2ee',
      ctx: resolveSessionEncryptionContextFromCredentials(credentials, { dataEncryptionKey: encryptedEnvelopeBase64 }),
      payload: { flavor: 'codex', codexSessionId: 'vendor-e2ee-1' },
    });

    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_e2ee',
        seq: 77,
        encryptionMode: 'e2ee',
        metadata: metadataCiphertext,
        dataEncryptionKey: encryptedEnvelopeBase64,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_e2ee', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, credentials });
    expect(out).toMatchObject({ ok: true });

    if (!out || !('ok' in out) || out.ok !== true) {
      throw new Error('Expected successful attach context');
    }

    expect(out.attachPayload.v).toBe(2);
    expect(out.attachPayload.encryptionMode).toBe('e2ee');
    expect(out.attachPayload.lastObservedMessageSeq).toBe(77);
    expect(out.vendorResumeId).toBe('vendor-e2ee-1');
    expect(out.sessionPath).toBeNull();

    if (out.attachPayload.encryptionMode !== 'e2ee') {
      throw new Error('Expected e2ee attach payload');
    }

    const opened = decodeBase64(out.attachPayload.encryptionKeyBase64, 'base64');
    expect(Array.from(opened)).toEqual(Array.from(dataKey));
    expect(out.attachPayload.encryptionVariant).toBe('dataKey');
    expect(vi.mocked(fetchSessionByIdCompat)).toHaveBeenCalledTimes(1);
  });

  it('returns a missing-credentials failure when an encrypted session needs a DEK but credentials are unavailable', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_e2ee',
        encryptionMode: 'e2ee',
        metadata: 'ciphertext',
        dataEncryptionKey: 'encrypted-dek',
      }),
    );

    const out = await resolveExistingSessionAttachContext({
      token: 't',
      sessionId: 'sess_e2ee',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      credentials: null,
    });

    expect(out).toEqual({ ok: false, reason: 'missingCredentials' });
  });

  it('returns a fetch-failed reason when session lookup throws', async () => {
    vi.mocked(fetchSessionByIdCompat).mockRejectedValueOnce(new Error('boom'));

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
    };

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_throw', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, credentials });

    expect(out).toEqual({ ok: false, reason: 'fetchFailed' });
  });

  it('returns a not-authenticated reason when session lookup rejects with an auth status', async () => {
    vi.mocked(fetchSessionByIdCompat).mockRejectedValueOnce(
      createHttpStatusError(401, 'Unauthorized (401)', 'not_authenticated'),
    );

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
    };

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_auth', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, credentials });

    expect(out).toEqual({ ok: false, reason: 'notAuthenticated' });
  });

  it('limits concurrent existing-session detail lookups during attach bursts', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];

    vi.mocked(fetchSessionByIdCompat).mockImplementation(async (params) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      active -= 1;
      return createSessionRecordFixture({
        id: params.sessionId,
        seq: 1,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'codex', path: '/tmp' }),
        dataEncryptionKey: null,
      });
    });

    let settled = 0;
    const requests = Array.from({ length: 6 }, (_value, index) =>
      resolveExistingSessionAttachContext({
        token: 't',
        sessionId: `sess_${index}`,
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        credentials: null,
        reason: 'startup-drain',
      }).finally(() => {
        settled += 1;
      }));

    await Promise.resolve();

    try {
      expect(maxActive).toBeLessThanOrEqual(4);
      expect(releases).toHaveLength(4);
    } finally {
      while (settled < requests.length) {
        const batch = releases.splice(0);
        if (batch.length === 0) {
          await Promise.resolve();
          continue;
        }
        for (const release of batch) {
          release();
        }
        await Promise.resolve();
      }
      await Promise.allSettled(requests);
    }

    expect(fetchSessionByIdCompat).toHaveBeenCalledTimes(6);
    for (const call of vi.mocked(fetchSessionByIdCompat).mock.calls) {
      expect(call[0]).toMatchObject({ reason: 'startup-drain' });
    }
  });
});
