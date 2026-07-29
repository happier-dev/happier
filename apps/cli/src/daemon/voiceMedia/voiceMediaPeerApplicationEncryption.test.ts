import {
  PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  decodeBase64,
  decodePeerApplicationEncryptedFrameV1,
  encodeBase64,
  encodePeerApplicationEncryptedFrameV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { openAes256GcmBytes, sealAes256GcmBytes } from '@/utils/crypto/aes256GcmBytes';

import { createVoiceMediaPeerApplicationEncryptionRegistry } from './voiceMediaPeerApplicationEncryption';

const authority = {
  v: 1 as const,
  applicationKind: 'agent_realtime' as const,
  applicationAttemptId: 'attempt-1',
  applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
};
const binding = {
  ...authority,
  suite: 'aes-256-gcm' as const,
  flowKind: 'voice_media' as const,
  routeKind: 'server_relay' as const,
  authorityDigest: `sha256:${'cd'.repeat(32)}`,
  accountId: 'account-1',
  machineId: 'machine-1',
  tunnelId: 'tunnel-1',
};

describe('Voice media peer-application encryption registry', () => {
  it('admits the exact Agent attempt, authenticates install, and seals independent daemon output', () => {
    const registry = createVoiceMediaPeerApplicationEncryptionRegistry({
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const prepared = registry.admitAgentRealtimeAttempt({
      authority,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.peerApplicationEncryption) throw new Error('expected prepared recipient key');
    expect(registry.bindAgentRealtimeAttempt({
      authority,
      peerApplicationEncryption: binding,
    })).toEqual({ ok: true });

    const contentKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey: contentKey,
      recipientPublicKey: decodeBase64(
        prepared.peerApplicationEncryption.recipientPublicKeyBase64Url,
        'base64url',
      ),
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });
    const substreamId = 'agent.realtime.attempt-1';
    const requestNonce = createPeerApplicationEncryptionNonceV1({
      direction: 'client_to_daemon',
      phase: 'install',
      sequence: 0,
    });
    const ciphertext = sealAes256GcmBytes({
      key: contentKey,
      nonce: requestNonce,
      aad: createPeerApplicationEncryptionAadV1({
        authorityDigest: binding.authorityDigest,
        accountId: binding.accountId,
        machineId: binding.machineId,
        tunnelId: binding.tunnelId,
        applicationKind: 'agent_realtime',
        applicationAttemptId: authority.applicationAttemptId,
        applicationAuthorityDigest: authority.applicationAuthorityDigest,
        direction: 'client_to_daemon',
        substreamId,
        sequence: 0,
        phase: 'install',
      }),
      plaintext: new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1),
    });
    expect(registry.openAgentRealtimeFrame({
      authority,
      binding,
      substreamId,
      carrierSequence: 0,
      payload: encodePeerApplicationEncryptedFrameV1({
        v: 1,
        kind: 'install',
        nonceBase64Url: encodeBase64(requestNonce, 'base64url'),
        ciphertextBase64Url: encodeBase64(ciphertext, 'base64url'),
        encryptedDataKeyEnvelopeBase64Url: encodeBase64(envelope, 'base64url'),
      }),
    })).toMatchObject({ ok: true, phase: 'install' });

    const sealed = registry.sealAgentRealtimeFrame({
      authority,
      binding,
      substreamId,
      carrierSequence: 0,
      phase: 'install',
      plaintext: registry.createInstallConfirmationPlaintext(),
    });
    expect(sealed).not.toBeNull();
    const response = decodePeerApplicationEncryptedFrameV1(sealed!);
    expect(response?.kind).toBe('install');
    const responseNonce = createPeerApplicationEncryptionNonceV1({
      direction: 'daemon_to_client',
      phase: 'install',
      sequence: 0,
    });
    expect(new TextDecoder().decode(openAes256GcmBytes({
      key: contentKey,
      nonce: responseNonce,
      aad: createPeerApplicationEncryptionAadV1({
        authorityDigest: binding.authorityDigest,
        accountId: binding.accountId,
        machineId: binding.machineId,
        tunnelId: binding.tunnelId,
        applicationKind: 'agent_realtime',
        applicationAttemptId: authority.applicationAttemptId,
        applicationAuthorityDigest: authority.applicationAuthorityDigest,
        direction: 'daemon_to_client',
        substreamId,
        sequence: 0,
        phase: 'install',
      }),
      ciphertext: decodeBase64(response!.ciphertextBase64Url, 'base64url'),
    }))).toBe('happier.peer-application.confirmed.v1');
  });

  it('rejects cross-application and mismatched authority before allocating an attempt', () => {
    const registry = createVoiceMediaPeerApplicationEncryptionRegistry();
    expect(registry.admitAgentRealtimeAttempt({
      authority: { ...authority, applicationKind: 'speech_transcription' },
      peerApplicationEncryption: { ...binding, applicationKind: 'speech_transcription' },
    })).toEqual({ ok: false, reasonCode: 'authority_mismatch' });
    expect(registry.admitAgentRealtimeAttempt({
      authority,
      peerApplicationEncryption: {
        ...binding,
        applicationAuthorityDigest: `sha256:${'ef'.repeat(32)}`,
      },
    })).toEqual({ ok: false, reasonCode: 'authority_mismatch' });
  });
});
