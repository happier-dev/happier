import {
  VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
  decodeVoiceMediaAgentRealtimeFrameV1,
  encodeVoiceMediaAgentRealtimeFrameV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { dispatchVoiceMediaAgentRealtimeBinaryFrame } from './voiceMediaApplicationDispatcher';
import type { VoiceMediaAgentRealtimeApplicationConsumer } from './voiceMediaApplicationDispatcher';

const authority = {
  v: 1 as const,
  applicationKind: 'agent_realtime' as const,
  applicationAttemptId: 'attempt-1',
  applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
};

describe('Voice media application dispatcher', () => {
  it('dispatches only the exact Agent authority/substream and emits application credit independently', async () => {
    const dispatchFrame: VoiceMediaAgentRealtimeApplicationConsumer['dispatchFrame'] =
      vi.fn(async ({ frame }) => ({
        v: 1 as const,
        kind: 'input_accepted' as const,
        applicationSequence: frame.applicationSequence,
        acceptedBytes: frame.kind === 'input_audio' ? frame.payload.byteLength : 1,
      }));
    const emitted: Uint8Array[] = [];
    let daemonSequence = 0;
    await expect(dispatchVoiceMediaAgentRealtimeBinaryFrame({
      authority,
      substreamId: 'agent.realtime.attempt-1',
      carrierSequence: 0,
      payload: encodeVoiceMediaAgentRealtimeFrameV1({
        v: 1,
        kind: 'input_audio',
        applicationSequence: 4,
        format: VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
        samplesPerChannel: 2,
        payload: new Uint8Array([1, 2, 3, 4]),
      }),
      consumer: {
        dispatchFrame,
        close: vi.fn(async () => {}),
      },
      emitPayload: async (createPayload) => {
        const payload = await createPayload(daemonSequence++);
        if (payload) emitted.push(payload);
      },
      signal: new AbortController().signal,
    })).resolves.toBe(true);
    expect(dispatchFrame).toHaveBeenCalledOnce();
    expect(decodeVoiceMediaAgentRealtimeFrameV1(emitted[0]!)).toEqual({
      v: 1,
      kind: 'input_accepted',
      applicationSequence: 4,
      acceptedBytes: 4,
    });
  });

  it('rejects cross-application and mismatched substream dispatch before the consumer', async () => {
    const consumer = {
      dispatchFrame: vi.fn(async () => null),
      close: vi.fn(async () => {}),
    };
    const common = {
      carrierSequence: 0,
      payload: new Uint8Array([1]),
      consumer,
      emitPayload: vi.fn(async () => {}),
      signal: new AbortController().signal,
    };
    await expect(dispatchVoiceMediaAgentRealtimeBinaryFrame({
      ...common,
      authority: { ...authority, applicationKind: 'speech_transcription' },
      substreamId: 'agent.realtime.attempt-1',
    })).resolves.toBe(false);
    await expect(dispatchVoiceMediaAgentRealtimeBinaryFrame({
      ...common,
      authority,
      substreamId: 'agent.realtime.other-attempt',
    })).resolves.toBe(false);
    expect(consumer.dispatchFrame).not.toHaveBeenCalled();
  });
});
