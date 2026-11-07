import type { VoiceHostTextPlayback, VoiceRealtimeJsonValue, VoiceOutputPlayback } from '@happier-dev/plugin-sdk/voice/client';
import { normalizeXaiRealtimeEventType } from './wire.js';

type PlaybackResult = Awaited<ReturnType<VoiceHostTextPlayback>>;
const unavailable = (): PlaybackResult => ({ status: 'unavailable', code: 'host_text_playback_unavailable' });
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** One forced utterance on the existing connection, never model-authored speech. */
export function createHostTextPlayback(input: Readonly<{
  send(event: VoiceRealtimeJsonValue): Promise<void>;
  capture(): VoiceOutputPlayback | null;
}>) {
  let utteranceSequence = 0;
  let pending: {
    text: string;
    itemId: string;
    responseId: string | null;
    heardText: string | null;
    hasAudio: boolean;
    draining: boolean;
    playback: VoiceOutputPlayback;
    finish(result: PlaybackResult): void;
    signal: AbortSignal;
  } | null = null;
  const cancel = () => pending?.finish({ status: 'cancelled' });
  const play: VoiceHostTextPlayback = async ({ text, signal }) => {
    if (signal.aborted) return { status: 'cancelled' };
    if (pending) return unavailable();
    const playback = input.capture();
    if (!playback) return unavailable();
    return await new Promise<PlaybackResult>(resolve => {
      const current = { text, itemId: `voice-host-summary-${++utteranceSequence}`,
        responseId: null as string | null, heardText: null as string | null,
        hasAudio: false, draining: false, signal, playback,
        finish(result: PlaybackResult) {
          if (pending !== current) return;
          pending = null;
          signal.removeEventListener('abort', cancel);
          resolve(result);
        } };
      pending = current;
      signal.addEventListener('abort', cancel, { once: true });
      void input.send({ type: 'conversation.item.create', item: {
        id: current.itemId, type: 'force_message', role: 'assistant', interruptible: true,
        content: [{ type: 'output_text', text }],
      } }).catch(() => current.finish(unavailable()));
    });
  };
  const observe = (raw: unknown): void => {
    const current = pending;
    if (!current) return;
    const event = record(raw);
    if (!event || typeof event.type !== 'string') return;
    const type = normalizeXaiRealtimeEventType(event.type);
    if (type === 'error') { current.finish(unavailable()); return; }
    if (type === 'input_audio_buffer.speech_started') { cancel(); return; }
    if (type === 'response.created') {
      const id = record(event.response)?.id;
      if (current.responseId || typeof id !== 'string') { current.finish(unavailable()); return; }
      current.responseId = id;
      return;
    }
    if (!current.responseId) return;
    const id = event.response_id ?? record(event.response)?.id;
    if (id !== current.responseId) return;
    // Transcript equality alone cannot distinguish the host's forced utterance
    // from model speech. A server that does not echo this native item ID cannot
    // establish the binding and falls back to Ask.
    if (type === 'response.output_audio.delta' && event.item_id === current.itemId
      && typeof event.delta === 'string' && event.delta) current.hasAudio = true;
    if (type === 'response.output_audio_transcript.done' && event.item_id === current.itemId) {
      current.heardText = typeof event.transcript === 'string' ? event.transcript : null;
    }
    if (type !== 'response.done' || current.draining) return;
    if (record(event.response)?.status !== 'completed' || !current.hasAudio || current.heardText !== current.text) {
      current.finish(unavailable()); return;
    }
    current.draining = true;
    void current.playback.waitForDrain(current.signal).then(result => {
      current.finish(current.signal.aborted || result === 'cancelled' ? { status: 'cancelled' }
        : result === 'completed' ? { status: 'completed' } : unavailable());
    }, () => current.finish(unavailable()));
  };
  return { play, observe, cancel };
}
