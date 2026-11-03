import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { deriveBoxPublicKeyFromSeed, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64, encrypt } from '@/api/encryption';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
// Only the HTTP and environment boundaries are replaced; ID resolution,
// response parsing, envelope-state decisions, and Session cryptography stay real.
vi.mock('axios', () => ({ default: { get } }));
vi.mock('@/configuration', () => ({ configuration: {
  serverUrl: 'https://home.example', apiServerUrl: 'https://home.example', sessionControlHttpTimeoutMs: 1000,
} }));

beforeEach(() => {
  get.mockReset();
  vi.stubEnv('HAPPIER_SESSION_E2EE_DEK_FETCH_RETRY_DELAY_MS', '1');
});
afterEach(() => vi.unstubAllEnvs());

it.each(['', ' '])('settles a malformed published envelope %j without treating it as a pending publication', async (malformed) => {
  const sessionId = 'c123456789012345678901234';
  const machineKey = new Uint8Array(32).fill(7);
  const publicKey = deriveBoxPublicKeyFromSeed(machineKey);
  const sessionKey = new Uint8Array(32).fill(9);
  const validEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
    dataKey: sessionKey, recipientPublicKey: publicKey,
    randomBytes: (length) => new Uint8Array(length).fill(3),
  }));
  let sessionReads = 0;
  get.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'available' },
    } };
    if (url.endsWith(`/v2/sessions/${sessionId}`)) {
      sessionReads += 1;
      return { status: 200, data: { session: {
        id: sessionId, seq: 1, createdAt: 1, updatedAt: 2, active: true, activeAt: 1, archivedAt: null,
        encryptionMode: 'e2ee', metadataVersion: 0, agentState: null, agentStateVersion: 0,
        pendingCount: 0, pendingVersion: 0, share: null,
        metadata: encodeBase64(encrypt(sessionKey, 'dataKey', { path: '/workspace' })),
        dataEncryptionKey: sessionReads === 1 ? malformed : validEnvelope,
      } } };
    }
    throw new Error(`Unexpected HTTP request: ${url}`);
  });

  await expect(resolveSessionTransportContext({
    reason: 'session-control',
    credentials: { token: 'test', encryption: { type: 'dataKey', machineKey, publicKey } },
    idOrPrefix: sessionId,
  })).resolves.toEqual({ ok: false, code: 'encryption_material_unavailable', sessionId });
  expect(sessionReads).toBe(1);
});
