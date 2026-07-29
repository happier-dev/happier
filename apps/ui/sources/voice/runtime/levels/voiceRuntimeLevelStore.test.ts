import { describe, expect, it, vi } from 'vitest';

import { createVoiceRuntimeLevelStore } from './voiceRuntimeLevelStore';

describe('createVoiceRuntimeLevelStore', () => {
  it('keeps input and output ownership independent and clamps invalid samples', () => {
    const store = createVoiceRuntimeLevelStore();
    const input = store.open({ channel: 'input', sourceId: 'capture-a' });
    const output = store.open({ channel: 'output', sourceId: 'playback-a' });

    input.write(2);
    output.write(Number.NaN);

    expect(store.getSnapshot().inputLevel).toBeGreaterThan(0);
    expect(store.getSnapshot().inputLevel).toBeLessThanOrEqual(1);
    expect(store.getSnapshot().outputLevel).toBe(0);
  });

  it('makes a superseded writer inert so stale attempts cannot overwrite a new stream', () => {
    const store = createVoiceRuntimeLevelStore();
    const stale = store.open({ channel: 'input', sourceId: 'capture-a' });
    const current = store.open({ channel: 'input', sourceId: 'capture-b' });

    current.write(0.8);
    const currentLevel = store.getSnapshot().inputLevel;
    stale.write(1);
    stale.close();

    expect(store.getSnapshot().inputLevel).toBe(currentLevel);
  });

  it('resets an active channel after its sample stream goes stale', () => {
    vi.useFakeTimers();
    try {
      const store = createVoiceRuntimeLevelStore({ staleAfterMs: 120 });
      const input = store.open({ channel: 'input', sourceId: 'capture-a' });
      input.write(0.7);

      vi.advanceTimersByTime(119);
      expect(store.getSnapshot().inputLevel).toBeGreaterThan(0);
      vi.advanceTimersByTime(1);
      expect(store.getSnapshot().inputLevel).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies only the changed channel and resets it on close', () => {
    const store = createVoiceRuntimeLevelStore();
    const inputListener = vi.fn();
    const outputListener = vi.fn();
    store.subscribe('input', inputListener);
    store.subscribe('output', outputListener);
    const input = store.open({ channel: 'input', sourceId: 'capture-a' });

    expect(store.getSnapshot()).toMatchObject({
      inputLevel: 0,
      inputSourceActive: true,
      outputSourceActive: false,
    });

    input.write(0.5);
    input.close();

    expect(inputListener).toHaveBeenCalledTimes(3);
    expect(inputListener).toHaveBeenNthCalledWith(1, { level: 0, sourceActive: true });
    expect(inputListener).toHaveBeenLastCalledWith({ level: 0, sourceActive: false });
    expect(store.getSnapshot().inputSourceActive).toBe(false);
    expect(outputListener).not.toHaveBeenCalled();
  });

  it('keeps an active but silent source distinct from an unavailable meter', () => {
    const store = createVoiceRuntimeLevelStore();
    const output = store.open({ channel: 'output', sourceId: 'playback-a' });

    output.write(0);
    expect(store.getSnapshot()).toMatchObject({ outputLevel: 0, outputSourceActive: true });

    output.close();
    expect(store.getSnapshot()).toMatchObject({ outputLevel: 0, outputSourceActive: false });
  });
});
