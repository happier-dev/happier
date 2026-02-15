export type VoicePlaybackStopperRegistrar = (stopper: () => void) => () => void;

export type VoicePlaybackController = Readonly<{
  captureEpoch: () => number;
  isEpochCurrent: (epoch: number) => boolean;
  interrupt: () => void;
  registerStopper: VoicePlaybackStopperRegistrar;
}>;

export function createVoicePlaybackController(): VoicePlaybackController {
  let activeStopper: (() => void) | null = null;
  let playbackEpoch = 0;

  const registerStopper: VoicePlaybackStopperRegistrar = (stopper) => {
    activeStopper = stopper;
    return () => {
      if (activeStopper === stopper) {
        activeStopper = null;
      }
    };
  };

  return {
    captureEpoch: () => playbackEpoch,
    isEpochCurrent: (epoch: number) => playbackEpoch === epoch,
    interrupt: () => {
      const stopper = activeStopper;
      if (!stopper) return;
      playbackEpoch += 1;
      try {
        stopper();
      } catch {
        // best-effort only
      }
    },
    registerStopper,
  };
}
