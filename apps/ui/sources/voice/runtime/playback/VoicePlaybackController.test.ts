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
});
