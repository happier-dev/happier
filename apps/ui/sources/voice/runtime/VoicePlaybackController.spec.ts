import { describe, expect, it, vi } from 'vitest';

import { createVoicePlaybackController } from './VoicePlaybackController';

describe('createVoicePlaybackController', () => {
  it('invalidates the captured epoch on interrupt even when nothing is playing yet', () => {
    const controller = createVoicePlaybackController();
    const epoch = controller.captureEpoch();

    controller.interrupt();

    expect(controller.isEpochCurrent(epoch)).toBe(false);
  });

  it('stops every active playback on interrupt, not only the most recently registered one', () => {
    const controller = createVoicePlaybackController();
    const stopWelcome = vi.fn();
    const stopTurn = vi.fn();
    controller.registerStopper(stopWelcome);
    controller.registerStopper(stopTurn);

    controller.interrupt();

    expect(stopWelcome).toHaveBeenCalledTimes(1);
    expect(stopTurn).toHaveBeenCalledTimes(1);
  });

  it('does not call a stopper after its playback cleared it', () => {
    const controller = createVoicePlaybackController();
    const stopper = vi.fn();
    const clear = controller.registerStopper(stopper);
    clear();

    controller.interrupt();

    expect(stopper).not.toHaveBeenCalled();
  });
});
