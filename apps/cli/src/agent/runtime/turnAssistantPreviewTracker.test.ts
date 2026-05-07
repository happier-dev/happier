import { describe, expect, it } from 'vitest';

import { createTurnAssistantPreviewTracker } from './turnAssistantPreviewTracker';

describe('turnAssistantPreviewTracker', () => {
  it('accumulates assistant deltas into a normalized preview', () => {
    const tracker = createTurnAssistantPreviewTracker();

    tracker.appendDelta('Hello');
    tracker.appendDelta('\n\nworld');

    expect(tracker.getPreview()).toBe('Hello world');
  });

  it('replaces the preview when a backend emits cumulative full text', () => {
    const tracker = createTurnAssistantPreviewTracker();

    tracker.appendDelta('Old');
    tracker.replace('Latest full response');

    expect(tracker.getPreview()).toBe('Latest full response');
  });

  it('clears the preview on reset', () => {
    const tracker = createTurnAssistantPreviewTracker();

    tracker.replace('Ready');
    tracker.reset();

    expect(tracker.getPreview()).toBeNull();
  });
});
