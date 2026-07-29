import {
  decodeVoiceMediaAgentRealtimeFrameV1,
  encodeVoiceMediaAgentRealtimeFrameV1,
  type PeerApplicationEncryptionAuthorityBindingV1,
  type VoiceMediaAgentRealtimeFrameV1,
  type VoiceMediaApplicationAuthorityV1,
} from '@happier-dev/protocol';

import {
  voiceMediaPeerApplicationEncryptionRegistry,
  type VoiceMediaPeerApplicationEncryptionRegistry,
} from './voiceMediaPeerApplicationEncryption';

export type VoiceMediaAgentRealtimeApplicationConsumer = Readonly<{
  dispatchFrame(input: Readonly<{
    authority: VoiceMediaApplicationAuthorityV1;
    substreamId: string;
    frame: VoiceMediaAgentRealtimeFrameV1;
    emit: (frame: VoiceMediaAgentRealtimeFrameV1) => Promise<void>;
    signal: AbortSignal;
  }>): Promise<VoiceMediaAgentRealtimeFrameV1 | null>;
  close(input: Readonly<{
    authority: VoiceMediaApplicationAuthorityV1;
    substreamId: string;
    reasonCode: string;
  }>): Promise<void>;
}>;

export type VoiceMediaApplicationPayloadEmitter = (
  createPayload: (carrierSequence: number) => Promise<Uint8Array | null> | Uint8Array | null,
) => Promise<void>;

function isExactAgentRealtimeSubstream(
  authority: VoiceMediaApplicationAuthorityV1,
  substreamId: string,
): boolean {
  return substreamId === `agent.realtime.${authority.applicationAttemptId}`;
}

export async function dispatchVoiceMediaAgentRealtimeBinaryFrame(input: Readonly<{
  authority: VoiceMediaApplicationAuthorityV1;
  peerApplicationEncryption?: PeerApplicationEncryptionAuthorityBindingV1;
  substreamId: string;
  carrierSequence: number;
  payload: Uint8Array;
  consumer: VoiceMediaAgentRealtimeApplicationConsumer | undefined;
  emitPayload: VoiceMediaApplicationPayloadEmitter;
  encryptionRegistry?: VoiceMediaPeerApplicationEncryptionRegistry;
  signal: AbortSignal;
}>): Promise<boolean> {
  if (
    input.authority.applicationKind !== 'agent_realtime'
    || !isExactAgentRealtimeSubstream(input.authority, input.substreamId)
    || !input.consumer
  ) {
    return false;
  }
  const encryptionRegistry = input.encryptionRegistry
    ?? voiceMediaPeerApplicationEncryptionRegistry;
  let phase: 'install' | 'data' | 'finish' = 'data';
  let plaintext = input.payload;
  if (input.peerApplicationEncryption) {
    const opened = encryptionRegistry.openAgentRealtimeFrame({
      authority: input.authority,
      binding: input.peerApplicationEncryption,
      substreamId: input.substreamId,
      carrierSequence: input.carrierSequence,
      payload: input.payload,
    });
    if (!opened.ok) return false;
    phase = opened.phase;
    plaintext = opened.plaintext;
    if (phase === 'install') {
      await input.emitPayload((carrierSequence) => encryptionRegistry.sealAgentRealtimeFrame({
        authority: input.authority,
        binding: input.peerApplicationEncryption!,
        substreamId: input.substreamId,
        carrierSequence,
        phase: 'install',
        plaintext: encryptionRegistry.createInstallConfirmationPlaintext(),
      }));
      return true;
    }
    if (phase === 'finish') {
      await input.consumer.close({
        authority: input.authority,
        substreamId: input.substreamId,
        reasonCode: 'client_finish',
      });
      encryptionRegistry.closeAgentRealtimeAttempt(input.authority);
      return true;
    }
  }

  const frame = decodeVoiceMediaAgentRealtimeFrameV1(plaintext);
  if (!frame) return false;
  const emit = async (outbound: VoiceMediaAgentRealtimeFrameV1): Promise<void> => {
    const encoded = encodeVoiceMediaAgentRealtimeFrameV1(outbound);
    await input.emitPayload((carrierSequence) => {
      if (!input.peerApplicationEncryption) return encoded;
      return encryptionRegistry.sealAgentRealtimeFrame({
        authority: input.authority,
        binding: input.peerApplicationEncryption,
        substreamId: input.substreamId,
        carrierSequence,
        phase: 'data',
        plaintext: encoded,
      });
    });
  };
  const response = await input.consumer.dispatchFrame({
    authority: input.authority,
    substreamId: input.substreamId,
    frame,
    emit,
    signal: input.signal,
  });
  if (response) await emit(response);
  return true;
}
