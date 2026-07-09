import { createAttemptGuard } from '@/utils/timing/attemptGuard';

export type VoicePlaybackStopperRegistrar = (stopper: () => void) => () => void;

export type VoicePlaybackController = Readonly<{
    captureEpoch: () => number;
    isEpochCurrent: (epoch: number) => boolean;
    interrupt: () => void;
    registerStopper: VoicePlaybackStopperRegistrar;
}>;

export function createVoicePlaybackController(): VoicePlaybackController {
    // The playback "epoch" is a latest-wins generation token: callers capture it
    // before async work and re-check it before committing playback; `interrupt()`
    // advances the generation so stale completions drop out. Back it with the
    // shared AttemptGuard so this staleness logic has one owner.
    const playbackGuard = createAttemptGuard();
    let activeStopper: (() => void) | null = null;
    let playbackEpoch = playbackGuard.next();
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
        isEpochCurrent: (epoch: number) => playbackGuard.isCurrent(epoch),
        interrupt: () => {
            playbackEpoch = playbackGuard.next();

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
