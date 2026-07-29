import { createAttemptGuard } from '@/utils/timing/attemptGuard';

import type {
    VoicePlaybackInterruptionMode,
    VoicePlaybackInterruptionResolution,
} from '@happier-dev/bundled-voice-runtime-contract';

export type {
    VoicePlaybackInterruptionMode,
    VoicePlaybackInterruptionResolution,
} from '@happier-dev/bundled-voice-runtime-contract';

export type VoicePlaybackTarget = Readonly<{
    stop: () => void;
    beginCandidate?: () => VoicePlaybackInterruptionMode;
    resolveCandidate?: (resolution: VoicePlaybackInterruptionResolution) => void;
}>;

export type VoicePlaybackStopperRegistrar = ((stopper: () => void) => () => void) & Readonly<{
    registerTarget?: (target: VoicePlaybackTarget) => () => void;
    captureAttempt?: () => VoicePlaybackStopperRegistrar;
}>;

export type VoicePlaybackController = Readonly<{
    captureEpoch: () => number;
    isEpochCurrent: (epoch: number) => boolean;
    beginInterruptionCandidate: () => VoicePlaybackInterruptionMode;
    resolveInterruptionCandidate: (resolution: VoicePlaybackInterruptionResolution) => void;
    interrupt: () => void;
    registerTarget: (target: VoicePlaybackTarget) => () => void;
    registerStopper: VoicePlaybackStopperRegistrar;
}>;

export function createVoicePlaybackController(): VoicePlaybackController {
    // The playback "epoch" is a latest-wins generation token: callers capture it
    // before async work and re-check it before committing playback; `interrupt()`
    // advances the generation so stale completions drop out. Back it with the
    // shared AttemptGuard so this staleness logic has one owner.
    const playbackGuard = createAttemptGuard();
    let activeTarget: VoicePlaybackTarget | null = null;
    let playbackEpoch = playbackGuard.next();
    let pendingInterrupt = false;
    let candidateActive = false;
    let candidateMode: VoicePlaybackInterruptionMode = 'unsupported';

    const stopTarget = (target: VoicePlaybackTarget): void => {
        try {
            target.stop();
        } catch {
            // best-effort only
        }
    };

    const registerTargetForAttempt = (
        target: VoicePlaybackTarget,
        attemptEpoch: number | null,
    ): (() => void) => {
        if (attemptEpoch !== null && !playbackGuard.isCurrent(attemptEpoch)) {
            stopTarget(target);
            return () => {};
        }

        activeTarget = target;

        let stoppedByPendingInterrupt = false;
        if (attemptEpoch !== null) {
            // An epoch-bound target created after the latest interrupt belongs
            // to a new attempt. It may consume the pending latch without
            // admitting any older attempt, because stale epochs are rejected
            // before they can replace the active target.
            pendingInterrupt = false;
        } else if (pendingInterrupt) {
            pendingInterrupt = false;
            stopTarget(target);
            stoppedByPendingInterrupt = true;
        }
        if (!stoppedByPendingInterrupt && candidateActive) {
            try {
                candidateMode = target.beginCandidate?.() ?? 'unsupported';
            } catch {
                candidateMode = 'unsupported';
            }
        }

        return () => {
            if (activeTarget === target) {
                activeTarget = null;
            }
        };
    };

    const createStopperRegistrar = (attemptEpoch: number | null): VoicePlaybackStopperRegistrar => {
        let registrar!: VoicePlaybackStopperRegistrar;
        registrar = Object.assign(
            (stopper: () => void) => registerTargetForAttempt({ stop: stopper }, attemptEpoch),
            {
                registerTarget: (target: VoicePlaybackTarget) => registerTargetForAttempt(target, attemptEpoch),
                captureAttempt: () => attemptEpoch === null
                    ? createStopperRegistrar(playbackEpoch)
                    : registrar,
            },
        );
        return registrar;
    };

    const registerTarget = (target: VoicePlaybackTarget): (() => void) =>
        registerTargetForAttempt(target, null);
    const registerStopper = createStopperRegistrar(null);

    const interrupt = (): void => {
        playbackEpoch = playbackGuard.next();

        if (candidateActive) {
            const target = activeTarget;
            candidateActive = false;
            candidateMode = 'unsupported';
            try {
                target?.resolveCandidate?.('confirmed');
            } catch {
                // Destructive stop below remains authoritative.
            }
        }

        const target = activeTarget;
        if (!target) {
            pendingInterrupt = true;
            return;
        }

        pendingInterrupt = false;
        try {
            target.stop();
        } catch {
            // best-effort only
        }
    };

    return {
        captureEpoch: () => playbackEpoch,
        isEpochCurrent: (epoch: number) => playbackGuard.isCurrent(epoch),
        beginInterruptionCandidate: () => {
            if (candidateActive) return candidateMode;
            candidateActive = true;
            const target = activeTarget;
            try {
                candidateMode = target?.beginCandidate?.() ?? 'unsupported';
            } catch {
                candidateMode = 'unsupported';
            }
            return candidateMode;
        },
        resolveInterruptionCandidate: (resolution) => {
            if (!candidateActive) return;
            if (resolution === 'confirmed') {
                interrupt();
                return;
            }
            const target = activeTarget;
            candidateActive = false;
            candidateMode = 'unsupported';
            try {
                target?.resolveCandidate?.('false_alarm');
            } catch {
                // A failed best-effort restore must not become a destructive stop.
            }
        },
        interrupt,
        registerTarget,
        registerStopper,
    };
}
