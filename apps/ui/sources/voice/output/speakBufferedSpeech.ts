import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { createStoppableSpeech } from '@/voice/output/stoppableSpeech';
import { batchSpeechForSynthesis } from '@/voice/output/TtsChunker';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';

export async function speakBufferedSpeech(opts: {
  input: string;
  format: 'mp3' | 'wav';
  readAloudChunkChars?: number;
  maxInputUtf8Bytes?: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  fetchAudio: (input: string, signal: AbortSignal) => Promise<ArrayBuffer>;
}): Promise<void> {
  const speech = createStoppableSpeech(opts.registerPlaybackStopper);
  try {
    const batches = batchSpeechForSynthesis(opts.input, {
      maxInputUtf8Bytes: opts.maxInputUtf8Bytes,
      grouping: opts.readAloudChunkChars === undefined
        ? undefined
        : { maxChars: opts.readAloudChunkChars, mode: 'early-start' },
    });
    for (const input of batches) {
      if (speech.signal.aborted) return;
      const bytes = await opts.fetchAudio(input, speech.signal);
      if (speech.signal.aborted) return;
      await playAudioBytesWithStopper({
        bytes,
        format: opts.format,
        registerPlaybackStopper: speech.registerPlayback,
      });
    }
  } catch (error) {
    if (!speech.signal.aborted) throw error;
  } finally {
    speech.dispose();
  }
}
