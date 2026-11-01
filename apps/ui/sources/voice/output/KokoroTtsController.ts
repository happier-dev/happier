import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { createStoppableSpeech } from '@/voice/output/stoppableSpeech';
import { streamKokoroWavSentences } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';

/**
 * Speaks text with Kokoro. Resolves when playback finishes or is deliberately stopped; rejects only
 * on a real synthesis/playback failure.
 */
export async function speakKokoroText(opts: {
  text: string;
  assetSetId?: string | null;
  /** Requested voice; null or an id unknown to this platform's catalog uses the platform default. */
  voiceId: string | null;
  speed: number;
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  if (!isKokoroRuntimeSupported()) {
    throw new Error('kokoro_runtime_unsupported');
  }

  const speech = createStoppableSpeech(opts.registerPlaybackStopper);
  try {
    for await (const chunk of streamKokoroWavSentences({
      text: opts.text,
      assetSetId: typeof opts.assetSetId === 'string' ? opts.assetSetId : null,
      voiceId: opts.voiceId,
      speed: opts.speed,
      timeoutMs: opts.timeoutMs,
      signal: speech.signal,
    })) {
      if (speech.signal.aborted) return;
      await playAudioBytesWithStopper({
        bytes: chunk.wavBytes,
        format: 'wav',
        registerPlaybackStopper: speech.registerPlayback,
      });
    }
  } catch (error) {
    if (speech.signal.aborted) return;
    throw error;
  } finally {
    speech.dispose();
  }
}
