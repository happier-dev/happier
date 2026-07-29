import { describe, expect, it, vi } from 'vitest';
import { createClaudeRuntimeActivityPublisher } from './runtimeActivityPublisher.js';

describe('createClaudeRuntimeActivityPublisher', () => {
  it('purely projects canonical inventory without owning source membership', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(123);
    try {
      const publisher = createClaudeRuntimeActivityPublisher({ sessionId: 'session' });
      const events: unknown[] = [];
      publisher.subscribe((event) => events.push(event));
      await publisher.publish({ state: 'active', activeCount: 2 });
      await publisher.publish({ state: 'active', activeCount: 2 });
      await publisher.publish({ state: 'unknown', activeCount: 0 });
      expect(events.map((event) => ({
        state: (event as { state: unknown }).state,
        activeCount: (event as { activeCount: unknown }).activeCount,
        hasSourceClass: Object.hasOwn(event as object, 'sourceClass'),
      }))).toEqual([
        { state: 'idle', activeCount: 0, hasSourceClass: false },
        { state: 'active', activeCount: 2, hasSourceClass: false },
        { state: 'unknown', activeCount: 0, hasSourceClass: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an identical projection after a subscriber rejects publication', async () => {
    const publisher = createClaudeRuntimeActivityPublisher({ sessionId: 'session' });
    const delivered: unknown[] = [];
    let rejectActive = true;
    publisher.subscribe((event) => {
      if (event.state === 'active' && rejectActive) {
        throw new Error('subscriber rejected');
      }
      delivered.push(event);
    });

    await expect(publisher.publish({ state: 'active', activeCount: 1 }))
      .rejects.toThrow('subscriber rejected');
    rejectActive = false;
    await expect(publisher.publish({ state: 'active', activeCount: 1 }))
      .resolves.toBeUndefined();

    expect(delivered).toEqual([
      expect.objectContaining({ state: 'idle', activeCount: 0 }),
      expect.objectContaining({ state: 'active', activeCount: 1 }),
    ]);
  });
});
