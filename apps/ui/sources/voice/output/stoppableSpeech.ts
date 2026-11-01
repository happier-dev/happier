import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';

export type StoppableSpeech = Readonly<{
  /** Aborted when the playback controller stops this speech (barge-in, stop, hang-up). */
  signal: AbortSignal;
  /** Registrar for the audio player of the current segment; stopping the speech also stops it. */
  registerPlayback: VoicePlaybackStopperRegistrar;
  dispose: () => void;
}>;

/**
 * Registers one stopper for a whole speak call, covering synthesis/network work and audio
 * playback. A deliberate stop aborts `signal`; providers treat that as completion, not failure.
 */
export function createStoppableSpeech(registerPlaybackStopper: VoicePlaybackStopperRegistrar): StoppableSpeech {
  const controller = new AbortController();
  let stopPlayback: (() => void) | null = null;

  const dispose = registerPlaybackStopper(() => {
    controller.abort();
    const stopper = stopPlayback;
    stopPlayback = null;
    stopper?.();
  });

  const registerPlayback: VoicePlaybackStopperRegistrar = (stopper) => {
    if (controller.signal.aborted) {
      stopper();
      return () => {};
    }
    stopPlayback = stopper;
    return () => {
      if (stopPlayback === stopper) stopPlayback = null;
    };
  };

  return { signal: controller.signal, registerPlayback, dispose };
}
