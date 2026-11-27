import { describe, expect, it } from 'vitest';
import { createLiveWorkPrompt } from './liveWorkPrompt';

describe('turn-time live work', () => {
  it('emits zero bytes after the same observed work enters the provider conversation', () => {
    const prepare = createLiveWorkPrompt();
    const budget = () => 8_000;
    const active = { state: 'active', activeCount: 2 } as const;
    const first = prepare(active, budget);
    expect(first?.text).toContain('2 background activities');
    // A failed dispatch does not add the prepared note to native history.
    expect(prepare(active, budget)?.text).toBe(first?.text);
    first?.acknowledgeAccepted();
    expect(Buffer.byteLength(prepare(active, budget)?.text ?? '')).toBe(0);
    expect(prepare({ state: 'unknown', activeCount: 0 }, budget)).toBeNull();

    const idle = { state: 'idle', activeCount: 0 } as const;
    expect(prepare(idle, () => 1)).toBeNull();
    const settled = prepare(idle, budget);
    expect(settled?.text).toContain('Review any outstanding work');
    const bytes = Buffer.byteLength(settled?.text ?? '');
    expect(prepare(idle, () => bytes - 1)).toBeNull();
    expect(prepare(idle, () => bytes)?.text).toBe(settled?.text);
    settled?.acknowledgeAccepted();
    expect(Buffer.byteLength(prepare(idle, budget)?.text ?? '')).toBe(0);
  });
});
