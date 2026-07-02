import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64 } from '@/api/encryption';
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

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: '   ', credentials });
    expect(out).toEqual({ ok: false, reason: 'missingSessionId' });
    expect(vi.mocked(fetchSessionByIdCompat)).not.toHaveBeenCalled();
  });

  it('returns a v2 plain attach payload and vendorResumeId for plaintext sessions', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_plain',
        seq: 42,
        metadataVersion: 7,
        agentStateVersion: 3,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'codex', path: '/tmp', codexSessionId: 'vendor-plain-1' }),
        agentState: JSON.stringify({ controlledByUser: true }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_plain', credentials: null });
    expect(out).toEqual({
      ok: true,
      attachPayload: {
        v: 2,
        encryptionMode: 'plain',
        lastObservedMessageSeq: 42,
        snapshot: {
          metadata: { flavor: 'codex', path: '/tmp', codexSessionId: 'vendor-plain-1' },
          metadataVersion: 7,
          agentState: { controlledByUser: true },
          agentStateVersion: 3,
        },
      },
      vendorResumeId: 'vendor-plain-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    });
    expect(vi.mocked(fetchSessionByIdCompat)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchSessionByIdCompat)).toHaveBeenCalledWith({
      token: 't',
      sessionId: 'sess_plain',
      reason: 'manual-recovery',
    });
  });

  it('limits concurrent session-detail reads during existing-session reattach bursts', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(fetchSessionByIdCompat).mockImplementation(async ({ sessionId }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return createSessionRecordFixture({
        id: sessionId,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'codex', path: '/tmp' }),
        dataEncryptionKey: null,
      });
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        resolveExistingSessionAttachContext({
          token: 't',
          sessionId: `sess_${index}`,
          credentials: null,
        }),
      ),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('prefers the direct-session provider id when the stored metadata has no top-level flavor', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_direct_claude',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          externalSessionV1: {
            v: 1,
            providerId: 'claude',
            remoteSessionId: 'sess-direct-1',
          },
          claudeSessionId: 'sess-direct-1',
        }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({
      token: 't',
      sessionId: 'sess_direct_claude',
      credentials: null,
    });

    expect(out).toEqual({
      ok: true,
      attachPayload: {
        v: 2,
        encryptionMode: 'plain',
        lastObservedMessageSeq: 0,
        snapshot: {
          metadata: {
            externalSessionV1: {
              v: 1,
              providerId: 'claude',
              remoteSessionId: 'sess-direct-1',
            },
            claudeSessionId: 'sess-direct-1',
          },
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
        },
      },
      vendorResumeId: 'sess-direct-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    });
  });

  it('returns the configured ACP backend target from stored session metadata', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_acp',
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'acp:review-bot',
          path: '/tmp',
          acpConfiguredBackendV1: {
            v: 1,
            updatedAt: 1,
            backendId: 'review-bot',
            title: 'Review Bot',
          },
        }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({
      token: 't',
      sessionId: 'sess_acp',
      credentials: null,
    });

    expect(out).toEqual({
      ok: true,
      attachPayload: {
        v: 2,
        encryptionMode: 'plain',
        lastObservedMessageSeq: 0,
        snapshot: {
          metadata: {
            flavor: 'acp:review-bot',
            path: '/tmp',
            acpConfiguredBackendV1: {
              v: 1,
              updatedAt: 1,
              backendId: 'review-bot',
              title: 'Review Bot',
            },
          },
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 0,
        },
      },
      vendorResumeId: null,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
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

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_e2ee', credentials });
    expect(out).toMatchObject({ ok: true });

    if (!out || !('ok' in out) || out.ok !== true) {
      throw new Error('Expected successful attach context');
    }

    expect(out.attachPayload.v).toBe(2);
    expect(out.attachPayload.encryptionMode).toBe('e2ee');
    expect(out.attachPayload.lastObservedMessageSeq).toBe(77);
    expect(out.attachPayload.snapshot).toEqual({
      metadata: { flavor: 'codex', codexSessionId: 'vendor-e2ee-1' },
      metadataVersion: 1,
      agentState: null,
      agentStateVersion: 0,
    });
    expect(out.vendorResumeId).toBe('vendor-e2ee-1');
    expect(out.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'codex' });

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

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_throw', credentials });

    expect(out).toEqual({ ok: false, reason: 'fetchFailed' });
  });
});
