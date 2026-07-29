import { randomBytes } from 'node:crypto';

import {
  PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1,
  PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1,
  PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1,
  PEER_APPLICATION_ENCRYPTION_SUITE_V1,
  createPeerApplicationEncryptionAadV1,
  createPeerApplicationEncryptionNonceV1,
  decodeBase64,
  decodePeerApplicationEncryptedFrameV1,
  deriveBoxPublicKeyFromSeed,
  encodeBase64,
  encodePeerApplicationEncryptedFrameV1,
  openEncryptedDataKeyEnvelopeV1,
  type PeerApplicationEncryptionAuthorityBindingV1,
  type PeerApplicationEncryptionPhaseV1,
  type PeerApplicationEncryptionStartResponseV1,
  type VoiceMediaApplicationAuthorityV1,
} from '@happier-dev/protocol';

import { openAes256GcmBytes, sealAes256GcmBytes } from '@/utils/crypto/aes256GcmBytes';

type AdmittedAgentRealtimeEncryption = {
  authority: VoiceMediaApplicationAuthorityV1;
  binding: PeerApplicationEncryptionAuthorityBindingV1 | null;
  recipientSecretKeySeed: Uint8Array;
  contentKey: Uint8Array | null;
  lastClientCarrierSequence: number;
  lastDaemonCarrierSequence: number;
};
type BoundAgentRealtimeEncryption = Omit<AdmittedAgentRealtimeEncryption, 'binding'> & {
  binding: PeerApplicationEncryptionAuthorityBindingV1;
};

export type VoiceMediaAgentRealtimeEncryptionAdmissionResult =
  | Readonly<{ ok: true; peerApplicationEncryption?: PeerApplicationEncryptionStartResponseV1 }>
  | Readonly<{
      ok: false;
      reasonCode: 'authority_mismatch' | 'attempt_already_admitted' | 'attempt_not_admitted';
    }>;

export type VoiceMediaAgentRealtimeOpenedFrame =
  | Readonly<{ ok: true; phase: 'install'; plaintext: Uint8Array }>
  | Readonly<{ ok: true; phase: 'data' | 'finish'; plaintext: Uint8Array }>
  | Readonly<{
      ok: false;
      reasonCode:
        | 'attempt_not_admitted'
        | 'authority_mismatch'
        | 'frame_invalid'
        | 'sequence_mismatch'
        | 'nonce_mismatch'
        | 'key_invalid'
        | 'key_not_installed'
        | 'authentication_failed';
    }>;

function authorityKey(authority: VoiceMediaApplicationAuthorityV1): string {
  return `${authority.applicationAttemptId}\u0000${authority.applicationAuthorityDigest}`;
}

function sameAuthority(
  left: VoiceMediaApplicationAuthorityV1,
  right: VoiceMediaApplicationAuthorityV1,
): boolean {
  return left.applicationKind === right.applicationKind
    && left.applicationAttemptId === right.applicationAttemptId
    && left.applicationAuthorityDigest === right.applicationAuthorityDigest;
}

function bindingMatchesAuthority(
  binding: PeerApplicationEncryptionAuthorityBindingV1,
  authority: VoiceMediaApplicationAuthorityV1,
): boolean {
  return binding.flowKind === 'voice_media'
    && binding.applicationKind === authority.applicationKind
    && binding.applicationAttemptId === authority.applicationAttemptId
    && binding.applicationAuthorityDigest === authority.applicationAuthorityDigest;
}

function sameBinding(
  left: PeerApplicationEncryptionAuthorityBindingV1,
  right: PeerApplicationEncryptionAuthorityBindingV1,
): boolean {
  return left.v === right.v
    && left.suite === right.suite
    && left.flowKind === right.flowKind
    && left.routeKind === right.routeKind
    && left.authorityDigest === right.authorityDigest
    && left.accountId === right.accountId
    && left.machineId === right.machineId
    && left.tunnelId === right.tunnelId
    && bindingMatchesAuthority(left, right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) mismatch |= left[index]! ^ right[index]!;
  return mismatch === 0;
}

function clearAdmission(admission: AdmittedAgentRealtimeEncryption): void {
  admission.recipientSecretKeySeed.fill(0);
  admission.contentKey?.fill(0);
  admission.contentKey = null;
}

export function createVoiceMediaPeerApplicationEncryptionRegistry(input?: Readonly<{
  randomBytes?: (length: number) => Uint8Array;
}>) {
  const admitted = new Map<string, AdmittedAgentRealtimeEncryption>();
  const getRandomBytes = input?.randomBytes ?? ((length: number) => new Uint8Array(randomBytes(length)));

  function getExact(inputExact: Readonly<{
    authority: VoiceMediaApplicationAuthorityV1;
    binding: PeerApplicationEncryptionAuthorityBindingV1;
  }>): BoundAgentRealtimeEncryption | null {
    const current = admitted.get(authorityKey(inputExact.authority));
    return current
      && current.binding
      && sameAuthority(current.authority, inputExact.authority)
      && sameBinding(current.binding, inputExact.binding)
      ? current as BoundAgentRealtimeEncryption
      : null;
  }

  return {
    admitAgentRealtimeAttempt(inputAdmission: Readonly<{
      authority: VoiceMediaApplicationAuthorityV1;
      peerApplicationEncryption?: PeerApplicationEncryptionAuthorityBindingV1;
    }>): VoiceMediaAgentRealtimeEncryptionAdmissionResult {
      if (inputAdmission.authority.applicationKind !== 'agent_realtime') {
        return { ok: false, reasonCode: 'authority_mismatch' };
      }
      if (
        inputAdmission.peerApplicationEncryption
        && !bindingMatchesAuthority(
          inputAdmission.peerApplicationEncryption,
          inputAdmission.authority,
        )
      ) {
        return { ok: false, reasonCode: 'authority_mismatch' };
      }
      const key = authorityKey(inputAdmission.authority);
      const current = admitted.get(key);
      if (current) {
        if (
          !inputAdmission.peerApplicationEncryption
          || current.binding
          || !sameAuthority(current.authority, inputAdmission.authority)
        ) {
          return { ok: false, reasonCode: 'attempt_already_admitted' };
        }
        current.binding = inputAdmission.peerApplicationEncryption;
        return {
          ok: true,
          peerApplicationEncryption: {
            v: 1,
            suite: PEER_APPLICATION_ENCRYPTION_SUITE_V1,
            recipientPublicKeyBase64Url: encodeBase64(
              deriveBoxPublicKeyFromSeed(current.recipientSecretKeySeed),
              'base64url',
            ),
          },
        };
      }
      const recipientSecretKeySeed = getRandomBytes(PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1);
      const admission: AdmittedAgentRealtimeEncryption = {
        authority: inputAdmission.authority,
        binding: inputAdmission.peerApplicationEncryption ?? null,
        recipientSecretKeySeed,
        contentKey: null,
        lastClientCarrierSequence: -1,
        lastDaemonCarrierSequence: -1,
      };
      admitted.set(key, admission);
      return {
        ok: true,
        peerApplicationEncryption: {
          v: 1,
          suite: PEER_APPLICATION_ENCRYPTION_SUITE_V1,
          recipientPublicKeyBase64Url: encodeBase64(
            deriveBoxPublicKeyFromSeed(recipientSecretKeySeed),
            'base64url',
          ),
        },
      };
    },

    bindAgentRealtimeAttempt(inputBinding: Readonly<{
      authority: VoiceMediaApplicationAuthorityV1;
      peerApplicationEncryption: PeerApplicationEncryptionAuthorityBindingV1;
    }>): VoiceMediaAgentRealtimeEncryptionAdmissionResult {
      if (
        inputBinding.authority.applicationKind !== 'agent_realtime'
        || !bindingMatchesAuthority(
          inputBinding.peerApplicationEncryption,
          inputBinding.authority,
        )
      ) {
        return { ok: false, reasonCode: 'authority_mismatch' };
      }
      const current = admitted.get(authorityKey(inputBinding.authority));
      if (!current || !sameAuthority(current.authority, inputBinding.authority)) {
        return { ok: false, reasonCode: 'attempt_not_admitted' };
      }
      if (current.binding) {
        return { ok: false, reasonCode: 'attempt_already_admitted' };
      }
      current.binding = inputBinding.peerApplicationEncryption;
      return { ok: true };
    },

    openAgentRealtimeFrame(inputFrame: Readonly<{
      authority: VoiceMediaApplicationAuthorityV1;
      binding: PeerApplicationEncryptionAuthorityBindingV1;
      substreamId: string;
      carrierSequence: number;
      payload: Uint8Array;
    }>): VoiceMediaAgentRealtimeOpenedFrame {
      const current = getExact(inputFrame);
      if (!current) {
        return admitted.has(authorityKey(inputFrame.authority))
          ? { ok: false, reasonCode: 'authority_mismatch' }
          : { ok: false, reasonCode: 'attempt_not_admitted' };
      }
      if (inputFrame.carrierSequence !== current.lastClientCarrierSequence + 1) {
        return { ok: false, reasonCode: 'sequence_mismatch' };
      }
      const frame = decodePeerApplicationEncryptedFrameV1(inputFrame.payload);
      if (!frame) return { ok: false, reasonCode: 'frame_invalid' };
      const phase: PeerApplicationEncryptionPhaseV1 = frame.kind;
      const nonce = createPeerApplicationEncryptionNonceV1({
        direction: 'client_to_daemon',
        phase,
        sequence: inputFrame.carrierSequence,
      });
      if (!sameBytes(decodeBase64(frame.nonceBase64Url, 'base64url'), nonce)) {
        return { ok: false, reasonCode: 'nonce_mismatch' };
      }
      let contentKey = current.contentKey;
      if (frame.kind === 'install') {
        if (contentKey || inputFrame.carrierSequence !== 0 || !frame.encryptedDataKeyEnvelopeBase64Url) {
          return { ok: false, reasonCode: 'frame_invalid' };
        }
        contentKey = openEncryptedDataKeyEnvelopeV1({
          envelope: decodeBase64(frame.encryptedDataKeyEnvelopeBase64Url, 'base64url'),
          recipientSecretKeyOrSeed: current.recipientSecretKeySeed,
        });
        if (!contentKey || contentKey.byteLength !== PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1) {
          contentKey?.fill(0);
          return { ok: false, reasonCode: 'key_invalid' };
        }
      } else if (!contentKey) {
        return { ok: false, reasonCode: 'key_not_installed' };
      }
      let plaintext: Uint8Array;
      try {
        plaintext = openAes256GcmBytes({
          key: contentKey,
          nonce,
          aad: createPeerApplicationEncryptionAadV1({
            authorityDigest: current.binding.authorityDigest,
            accountId: current.binding.accountId,
            machineId: current.binding.machineId,
            tunnelId: current.binding.tunnelId,
            applicationKind: 'agent_realtime',
            applicationAttemptId: current.authority.applicationAttemptId,
            applicationAuthorityDigest: current.authority.applicationAuthorityDigest,
            direction: 'client_to_daemon',
            substreamId: inputFrame.substreamId,
            sequence: inputFrame.carrierSequence,
            phase,
          }),
          ciphertext: decodeBase64(frame.ciphertextBase64Url, 'base64url'),
        });
      } catch {
        if (phase === 'install') contentKey.fill(0);
        return { ok: false, reasonCode: 'authentication_failed' };
      }
      if (phase === 'install') {
        if (new TextDecoder().decode(plaintext) !== PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1) {
          contentKey.fill(0);
          return { ok: false, reasonCode: 'authentication_failed' };
        }
        current.contentKey = contentKey;
      }
      current.lastClientCarrierSequence = inputFrame.carrierSequence;
      return { ok: true, phase, plaintext };
    },

    sealAgentRealtimeFrame(inputFrame: Readonly<{
      authority: VoiceMediaApplicationAuthorityV1;
      binding: PeerApplicationEncryptionAuthorityBindingV1;
      substreamId: string;
      carrierSequence: number;
      phase: PeerApplicationEncryptionPhaseV1;
      plaintext: Uint8Array;
    }>): Uint8Array | null {
      const current = getExact(inputFrame);
      if (
        !current?.contentKey
        || inputFrame.carrierSequence !== current.lastDaemonCarrierSequence + 1
      ) {
        return null;
      }
      const nonce = createPeerApplicationEncryptionNonceV1({
        direction: 'daemon_to_client',
        phase: inputFrame.phase,
        sequence: inputFrame.carrierSequence,
      });
      const ciphertext = sealAes256GcmBytes({
        key: current.contentKey,
        nonce,
        aad: createPeerApplicationEncryptionAadV1({
          authorityDigest: current.binding.authorityDigest,
          accountId: current.binding.accountId,
          machineId: current.binding.machineId,
          tunnelId: current.binding.tunnelId,
          applicationKind: 'agent_realtime',
          applicationAttemptId: current.authority.applicationAttemptId,
          applicationAuthorityDigest: current.authority.applicationAuthorityDigest,
          direction: 'daemon_to_client',
          substreamId: inputFrame.substreamId,
          sequence: inputFrame.carrierSequence,
          phase: inputFrame.phase,
        }),
        plaintext: inputFrame.plaintext,
      });
      current.lastDaemonCarrierSequence = inputFrame.carrierSequence;
      return encodePeerApplicationEncryptedFrameV1({
        v: 1,
        kind: inputFrame.phase,
        nonceBase64Url: encodeBase64(nonce, 'base64url'),
        ciphertextBase64Url: encodeBase64(ciphertext, 'base64url'),
      });
    },

    createInstallConfirmationPlaintext(): Uint8Array {
      return new TextEncoder().encode(PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1);
    },

    closeAgentRealtimeAttempt(authority: VoiceMediaApplicationAuthorityV1): void {
      const key = authorityKey(authority);
      const current = admitted.get(key);
      if (!current || !sameAuthority(current.authority, authority)) return;
      admitted.delete(key);
      clearAdmission(current);
    },

    dispose(): void {
      for (const current of admitted.values()) clearAdmission(current);
      admitted.clear();
    },
  };
}

export const voiceMediaPeerApplicationEncryptionRegistry =
  createVoiceMediaPeerApplicationEncryptionRegistry();

export type VoiceMediaPeerApplicationEncryptionRegistry =
  ReturnType<typeof createVoiceMediaPeerApplicationEncryptionRegistry>;
