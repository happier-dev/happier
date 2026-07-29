import { describe, expect, it, vi } from 'vitest';

import { createVoicePlaybackController } from './VoicePlaybackController';

describe('VoicePlaybackController', () => {
    it('increments the playback epoch even when no stopper is registered', () => {
        const controller = createVoicePlaybackController();

        const before = controller.captureEpoch();
        controller.interrupt();

        expect(controller.captureEpoch()).toBe(before + 1);
    });

    it('immediately stops late-registered playback when an interrupt is already pending', () => {
        const controller = createVoicePlaybackController();
        const stopper = vi.fn();

        controller.interrupt();
        const clearStopper = controller.registerStopper(stopper);

        expect(stopper).toHaveBeenCalledTimes(1);

        clearStopper();
        controller.interrupt();

        expect(stopper).toHaveBeenCalledTimes(1);
    });

    it('allows a current attempt while rejecting an older attempt after an interrupt', () => {
        const controller = createVoicePlaybackController();
        const staleStopper = vi.fn();
        const currentStopper = vi.fn();
        const staleAttempt = controller.registerStopper.captureAttempt?.() ?? controller.registerStopper;

        controller.interrupt();
        const currentAttempt = controller.registerStopper.captureAttempt?.() ?? controller.registerStopper;
        currentAttempt(currentStopper);
        staleAttempt(staleStopper);

        expect(currentStopper).not.toHaveBeenCalled();
        expect(staleStopper).toHaveBeenCalledTimes(1);
    });

    it('retains playback during a provisional interruption and resumes only on a false alarm', () => {
        const controller = createVoicePlaybackController();
        const stop = vi.fn();
        const beginCandidate = vi.fn(() => 'retained' as const);
        const resolveCandidate = vi.fn();
        const epoch = controller.captureEpoch();
        controller.registerTarget({ stop, beginCandidate, resolveCandidate });

        expect(controller.beginInterruptionCandidate()).toBe('retained');
        expect(controller.beginInterruptionCandidate()).toBe('retained');
        controller.resolveInterruptionCandidate('false_alarm');

        expect(beginCandidate).toHaveBeenCalledTimes(1);
        expect(resolveCandidate).toHaveBeenCalledWith('false_alarm');
        expect(stop).not.toHaveBeenCalled();
        expect(controller.captureEpoch()).toBe(epoch);
    });

    it('makes confirmed interruption destructive and never resumes the destroyed target', () => {
        const controller = createVoicePlaybackController();
        const stop = vi.fn();
        const resolveCandidate = vi.fn();
        controller.registerTarget({
            stop,
            beginCandidate: () => 'ducked',
            resolveCandidate,
        });
        const epoch = controller.captureEpoch();

        expect(controller.beginInterruptionCandidate()).toBe('ducked');
        controller.resolveInterruptionCandidate('confirmed');
        controller.resolveInterruptionCandidate('false_alarm');

        expect(resolveCandidate).toHaveBeenCalledTimes(1);
        expect(resolveCandidate).toHaveBeenCalledWith('confirmed');
        expect(stop).toHaveBeenCalledTimes(1);
        expect(controller.captureEpoch()).toBe(epoch + 1);
    });

    it('does not let stale target cleanup unregister a newer playback target', () => {
        const controller = createVoicePlaybackController();
        const firstStop = vi.fn();
        const secondStop = vi.fn();
        const clearFirst = controller.registerTarget({ stop: firstStop });
        controller.registerTarget({ stop: secondStop });

        clearFirst();
        controller.interrupt();

        expect(firstStop).not.toHaveBeenCalled();
        expect(secondStop).toHaveBeenCalledTimes(1);
    });
});
