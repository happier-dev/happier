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

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: '   ', agent: 'codex', credentials });
    expect(out).toEqual({ ok: false, reason: 'missingSessionId' });
    expect(vi.mocked(fetchSessionByIdCompat)).not.toHaveBeenCalled();
  });

  it('returns a v2 plain attach payload and vendorResumeId for plaintext sessions', async () => {
    vi.mocked(fetchSessionByIdCompat).mockResolvedValueOnce(
      createSessionRecordFixture({
        id: 'sess_plain',
        encryptionMode: 'plain',
        metadata: JSON.stringify({ flavor: 'codex', path: '/tmp', codexSessionId: 'vendor-plain-1' }),
        dataEncryptionKey: null,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_plain', agent: 'codex', credentials: null });
    expect(out).toEqual({
      ok: true,
      attachPayload: { v: 2, encryptionMode: 'plain' },
      vendorResumeId: 'vendor-plain-1',
    });
    expect(vi.mocked(fetchSessionByIdCompat)).toHaveBeenCalledTimes(1);
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
        encryptionMode: 'e2ee',
        metadata: metadataCiphertext,
        dataEncryptionKey: encryptedEnvelopeBase64,
      }),
    );

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_e2ee', agent: 'codex', credentials });
    expect(out).toMatchObject({ ok: true });

    if (!out || !('ok' in out) || out.ok !== true) {
      throw new Error('Expected successful attach context');
    }

    expect(out.attachPayload.v).toBe(2);
    expect(out.attachPayload.encryptionMode).toBe('e2ee');
    expect(out.vendorResumeId).toBe('vendor-e2ee-1');

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
      agent: 'codex',
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

    const out = await resolveExistingSessionAttachContext({ token: 't', sessionId: 'sess_throw', agent: 'codex', credentials });

    expect(out).toEqual({ ok: false, reason: 'fetchFailed' });
  });
});
