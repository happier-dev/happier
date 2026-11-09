import { describe, expect, it } from 'vitest';
import retained from '../../../../../../packages/protocol/fixtures/0.2-retained-session-layout0.json';
import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { fetchAndApplySessionById } from './sessionById';

// Only the HTTP-delivered row is supplied here. Ciphertexts/serializer bytes come from
// immutable 0.2 producers (see the portable fixture), never current encryption helpers.
describe('retained 0.2 Session full reads', () => {
  it.each(retained.vectors)('opens the historical $variant tuple without a display sidecar', async vector => {
    const publicKey = new Uint8Array(Buffer.from(retained.recipientPublicKeyHex, 'hex'));
    const machineKey = new Uint8Array(Buffer.from(retained.recipientSecretKeyHex, 'hex'));
    const encryption = vector.variant === 'dataKey'
      ? await Encryption.createFromContentKeyPair({ publicKey, machineKey }) : await Encryption.create(new Uint8Array(32));
    const credentials = vector.variant === 'plain' ? { token: 'retained' }
      : vector.variant === 'legacy' ? { token: 'retained', secret: encodeBase64(new Uint8Array(32), 'base64url') }
      : { token: 'retained', encryption: { publicKey: encodeBase64(publicKey, 'base64'), machineKey: encodeBase64(machineKey, 'base64') } };
    const sessionDataKeys = new Map<string, Uint8Array>();
    const sessionDataKeyEnvelopes = new Map<string, string>();
    const read = async (dataEncryptionKey: string | null) => fetchAndApplySessionById({
      sessionId: 'retained', credentials, encryption, sessionDataKeys, sessionDataKeyEnvelopes,
      accountCurrentness: { mode: vector.encryptionMode === 'plain' ? 'plain' : 'e2ee',
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 },
      includeMetadataTupleMutationSnapshot: true,
      request: async () => { throw new Error('The captured full read must not issue a second request'); },
      applySessions: () => {}, log: { log() {} },
      prefetched: {
        detail: { status: 200, body: { session: {
          id: 'retained', createdAt: 1, updatedAt: 2, seq: 1, active: false, activeAt: 1,
          encryptionMode: vector.encryptionMode === 'plain' ? 'plain' : 'e2ee', dataEncryptionKey,
          metadataLayoutVersion: 0, metadataVersion: 7, metadata: vector.metadata,
          agentStateVersion: 8, agentState: vector.agentState, share: null,
        } } },
        turns: { status: 200, body: { v: 1, sessionId: 'retained', updatedAt: 2, turns: [] } },
      },
    });
    expect(await read(vector.dataEncryptionKey)).toMatchObject({ ok: true, session: {
      metadata: retained.metadata, agentState: retained.agentState, metadataVersion: 7, agentStateVersion: 8,
    }, metadataTupleMutationSnapshot: { mode: 'legacy_owner' } });
    if (vector.variant === 'dataKey') {
      const key = new Uint8Array(Buffer.from(vector.keyHex!, 'hex'));
      const rewrapped = encodeBase64(await encryption.encryptEncryptionKey(key), 'base64');
      expect(rewrapped).not.toBe(vector.dataEncryptionKey);
      // Rewrapping changes the recipient envelope, not the Session content key or bytes.
      expect(await read(rewrapped)).toMatchObject({ ok: true, session: {
        metadata: retained.metadata, agentState: retained.agentState, metadataVersion: 7, agentStateVersion: 8,
      } });
      expect(sessionDataKeys.get('retained')).toEqual(key);
    }
  });
});
