import { describe, expect, it } from 'vitest';

import {
  PEER_APPLICATION_ENCRYPTION_SUITE_V1,
  createPeerApplicationAuthorityDigestV1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  decodePeerApplicationEncryptedFrameV1,
  encodePeerApplicationEncryptedFrameV1,
} from './peerApplicationEncryptionV1.js';

const authority = {
  payload: {
    v: 2,
    grantId: 'grant-1',
    accountId: 'account-1',
    targetMachineId: 'machine-1',
    flowKind: 'voice_media',
    routeKind: 'server_relay',
    tunnelId: 'tunnel-1',
    applicationKind: 'speech_transcription',
    applicationAttemptId: 'attempt-1',
    applicationAuthorityDigest: `sha256:${'cd'.repeat(32)}`,
  },
  signature: { keyId: 'key-1', alg: 'Ed25519', valueBase64Url: 'c2ln' },
} as const;

describe('peer application encryption v1', () => {
  it('derives the transcription authority from its existing START attempt identity', () => {
    expect(createSpeechTranscriptionApplicationAuthorityDigestV1('attempt-1')).toBe(
      'sha256:cbfa0040b526cea8442f6835d13700b4ba1844e4dc4ebb6c39ccc9efbcaf23a1',
    );
  });

  it('freezes the signed authority digest, canonical AAD, and direction-specific nonce domains', () => {
    const authorityDigest = createPeerApplicationAuthorityDigestV1(authority);
    expect(authorityDigest).toBe('sha256:2a50e40b6e437c487adfbadbe80f5b8b2de2d88c47d387ba1e92a3a140cf27c5');

    const base = {
      authorityDigest,
      accountId: 'account-1',
      machineId: 'machine-1',
      tunnelId: 'tunnel-1',
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'cd'.repeat(32)}`,
      streamId: 'stream-1',
      generation: 7,
      substreamId: 'daemon.voiceInference.stt.stream-1.7',
      sequence: 9,
      phase: 'data' as const,
    };
    const speechAad = new TextDecoder().decode(createPeerApplicationEncryptionAadV1({
      ...base,
      direction: 'client_to_daemon',
    }));
    expect(speechAad).toContain('"flowKind":"voice_media"');
    expect(speechAad).toContain('"applicationKind":"speech_transcription"');
    expect(speechAad).toContain('"applicationAttemptId":"attempt-1"');
    expect(speechAad).toContain(`"applicationAuthorityDigest":"sha256:${'cd'.repeat(32)}"`);
    expect([...createPeerApplicationEncryptionNonceV1({
      direction: 'client_to_daemon', phase: 'data', sequence: 9,
    })]).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    expect([...createPeerApplicationEncryptionNonceV1({
      direction: 'daemon_to_client', phase: 'data', sequence: 9,
    })]).toEqual([1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
    expect(PEER_APPLICATION_ENCRYPTION_SUITE_V1).toBe('aes-256-gcm');
  });

  it('cryptographically separates transcription and Agent realtime application authority', () => {
    const common = {
      authorityDigest: `sha256:${'ab'.repeat(32)}`,
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'cd'.repeat(32)}`,
      accountId: 'account-1',
      machineId: 'machine-1',
      tunnelId: 'tunnel-1',
      substreamId: 'voice-media.attempt-1',
      sequence: 1,
      phase: 'data' as const,
      direction: 'client_to_daemon' as const,
    };
    const speech = createPeerApplicationEncryptionAadV1({
      ...common,
      applicationKind: 'speech_transcription',
      streamId: 'stream-1',
      generation: 1,
    });
    const agent = createPeerApplicationEncryptionAadV1({
      ...common,
      applicationKind: 'agent_realtime',
    });
    expect(agent).not.toEqual(speech);
  });

  it('round-trips strict install and ciphertext frames and rejects unknown fields', () => {
    const install = {
      v: 1 as const,
      kind: 'install' as const,
      encryptedDataKeyEnvelopeBase64Url: 'AQID',
      nonceBase64Url: 'AQEAAAAAAAAAAAAA',
      ciphertextBase64Url: 'AAECAwQFBgcICQoLDA0ODw',
    };
    expect(decodePeerApplicationEncryptedFrameV1(encodePeerApplicationEncryptedFrameV1(install))).toEqual(install);

    const malformed = new TextEncoder().encode(JSON.stringify({ ...install, downgrade: true }));
    expect(decodePeerApplicationEncryptedFrameV1(malformed)).toBeNull();
  });
});
