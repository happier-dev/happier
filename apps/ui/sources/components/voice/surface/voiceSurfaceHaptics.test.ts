import { describe, expect, it, vi } from 'vitest';

import { createVoiceSurfaceHapticNotifier } from './voiceSurfaceHaptics';

describe('createVoiceSurfaceHapticNotifier', () => {
  it('rate-limits duplicate surface notifications while allowing a later distinct event', () => {
    const emit = vi.fn();
    let now = 1_000;
    const notifier = createVoiceSurfaceHapticNotifier({ emit, now: () => now, minimumIntervalMs: 200 });

    notifier.notify('confirmed_interruption');
    notifier.notify('confirmed_interruption');
    now += 199;
    notifier.notify('start_stop');
    expect(emit).toHaveBeenCalledTimes(1);

    now += 1;
    notifier.notify('start_stop');
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
