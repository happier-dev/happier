export type VoicePlaybackStopperRegistrar = (stopper: () => void) => () => void;

export type VoicePlaybackController = Readonly<{
  captureEpoch: () => number;
  isEpochCurrent: (epoch: number) => boolean;
  interrupt: () => void;
  registerStopper: VoicePlaybackStopperRegistrar;
}>;

export function createVoicePlaybackController(): VoicePlaybackController {
  // Several speak calls can overlap (for example a prewarm welcome and a turn reply), so every
  // active playback is tracked and an interrupt stops all of them.
  const activeStoppers = new Set<() => void>();
  let playbackEpoch = 0;

  const registerStopper: VoicePlaybackStopperRegistrar = (stopper) => {
    activeStoppers.add(stopper);
    return () => {
      activeStoppers.delete(stopper);
    };
  };

  return {
    captureEpoch: () => playbackEpoch,
    isEpochCurrent: (epoch: number) => playbackEpoch === epoch,
    interrupt: () => {
      // Always advance the epoch: speech queued while waiting for more assistant text has no
      // stopper yet and must still be dropped after a barge-in.
      playbackEpoch += 1;
      const stoppers = [...activeStoppers];
      activeStoppers.clear();
      for (const stopper of stoppers) {
        try {
          stopper();
        } catch {
          // A failing stopper must not prevent the remaining playbacks from stopping.
        }
      }
    },
    registerStopper,
  };
}
