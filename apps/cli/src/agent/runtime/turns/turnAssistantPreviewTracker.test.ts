import { describe, expect, it } from 'vitest';

import { createTurnAssistantPreviewTracker } from './turnAssistantPreviewTracker';

describe('createTurnAssistantPreviewTracker', () => {
  it('normalizes, replaces, appends, and resets assistant preview text', () => {
    const tracker = createTurnAssistantPreviewTracker();

    expect(tracker.getPreview()).toBeNull();

    tracker.append('Hello');
    tracker.append('\n\nworld');
    expect(tracker.getPreview()).toBe('Hello world');

    tracker.replace('  Final\nanswer  ');
    expect(tracker.getPreview()).toBe('Final answer');

    tracker.reset();
    expect(tracker.getPreview()).toBeNull();
  });
});
