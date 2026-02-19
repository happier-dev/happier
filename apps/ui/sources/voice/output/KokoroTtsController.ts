import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { streamKokoroWavSentences } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';

export async function speakKokoroText(opts: {
  text: string;
  assetSetId?: string | null;
  voiceId: string;
  speed: number;
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  if (!isKokoroRuntimeSupported()) {
    throw new Error('kokoro_runtime_unsupported');
  }

  const controller = new AbortController();
  let stopPlayback: (() => void) | null = null;
  let clearStopper = () => {};

  try {
    clearStopper = opts.registerPlaybackStopper(() => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      const stopper = stopPlayback;
      if (!stopper) return;
      try {
        stopper();
      } catch {
        // ignore
      }
    });

    const registerPlaybackOnly: VoicePlaybackStopperRegistrar = (stopper) => {
      stopPlayback = stopper;
      return () => {
        if (stopPlayback === stopper) {
          stopPlayback = null;
        }
      };
    };

    for await (const chunk of streamKokoroWavSentences({
      text: opts.text,
      assetSetId: typeof opts.assetSetId === 'string' ? opts.assetSetId : null,
      voiceId: opts.voiceId,
      speed: opts.speed,
      timeoutMs: opts.timeoutMs,
      signal: controller.signal,
    })) {
      await playAudioBytesWithStopper({
        bytes: chunk.wavBytes,
        format: 'wav',
        registerPlaybackStopper: registerPlaybackOnly,
      });
    }
  } finally {
    clearStopper();
  }
}
