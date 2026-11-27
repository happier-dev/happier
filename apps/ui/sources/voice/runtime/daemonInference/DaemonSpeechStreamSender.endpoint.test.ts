import { describe, expect, it } from 'vitest';
import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT, DaemonVoiceInferenceSttStreamChunkResponseSchema, DaemonVoiceInferenceSttStreamFinishResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';

import { createDaemonSpeechStreamSender } from './DaemonSpeechStreamSender';
import { daemonSpeechStreamDiagnostics } from './daemonSpeechStreamDiagnostics';

describe('daemon endpoint diagnostic delivery', () => {
  it.each(['endpoint', 'final', 'unreported'] as const)('preserves available daemon facts from a %s event', async (type) => {
    const events: unknown[] = [];
    const unsubscribe = daemonSpeechStreamDiagnostics.subscribeLatency(event => events.push(event));
    const endpointDecision = { endpointRule: type === 'endpoint' ? 'unreported_by_recognizer' : 'input_finished_by_client',
      monotonicMs: 120, timeOriginMs: 1_700_000_000_000 };
    const sender = createDaemonSpeechStreamSender({
      requestId: 'request-endpoint', sessionId: 'carrier',
      transport: {
        start: async () => ({ ok: true, requestId: 'request-endpoint', streamId: 'stream-endpoint', generation: 0,
          ackSeq: -1, format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT }),
        chunk: async () => DaemonVoiceInferenceSttStreamChunkResponseSchema.parse({ ok: true, streamId: 'stream-endpoint', generation: 0,
          ackSeq: 0, events: type === 'endpoint' ? [{ type, seq: 0, transcript: 'heard', reason: 'vad', endpointDecision }] : [] }),
        finish: async () => DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({ ok: true, streamId: 'stream-endpoint', generation: 0,
          ackSeq: 0, finalText: 'heard', events: [{ type: 'final', seq: 0, text: 'heard', ...(type === 'final' ? { endpointDecision } : {}) }] }),
        cancel: async () => ({ ok: true, streamId: 'stream-endpoint', generation: 0, cancelled: true }),
      },
    });
    try {
      await sender.start();
      await sender.pushChunk(new Uint8Array([0, 0]));
      await sender.finish();
      expect(events.filter(event => (event as { phase: string }).phase === 'endpoint_decided')).toEqual(type === 'unreported' ? [] : [{
        phase: 'endpoint_decided', sessionId: 'carrier', requestId: 'request-endpoint', streamId: 'stream-endpoint',
        sequence: 0, ...endpointDecision,
      }]);
      expect(events).toContainEqual(expect.objectContaining({ phase: 'final_stt_received' }));
    } finally {
      unsubscribe();
      await sender.cancel();
    }
  });
});
