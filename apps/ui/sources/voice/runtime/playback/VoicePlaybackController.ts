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
    let pendingInterrupt = false;

    const registerStopper: VoicePlaybackStopperRegistrar = (stopper) => {
        activeStopper = stopper;

        if (pendingInterrupt) {
            pendingInterrupt = false;
            try {
                stopper();
            } catch {
                // best-effort only
            }
        }

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
            playbackEpoch += 1;

            const stopper = activeStopper;
            if (!stopper) {
                pendingInterrupt = true;
                return;
            }

            pendingInterrupt = false;
            try {
                stopper();
            } catch {
                // best-effort only
            }
        },
        registerStopper,
    };
}
