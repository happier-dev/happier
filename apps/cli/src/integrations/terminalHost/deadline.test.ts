import { describe, expect, it, vi } from 'vitest';

import { createTerminalHostDeadline, remainingTerminalHostDeadlineMs } from './deadline';

describe('terminal host deadline helpers', () => {
  it('returns undefined for absent or non-positive timeouts', () => {
    expect(createTerminalHostDeadline(undefined)).toBeUndefined();
    expect(createTerminalHostDeadline(0)).toBeUndefined();
    expect(createTerminalHostDeadline(-1)).toBeUndefined();
  });

  it('computes non-negative remaining time from one shared deadline owner', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const deadline = createTerminalHostDeadline(250);
    expect(deadline).toBe(1_250);

    vi.setSystemTime(1_125);
    expect(remainingTerminalHostDeadlineMs(deadline)).toBe(125);

    vi.setSystemTime(1_400);
    expect(remainingTerminalHostDeadlineMs(deadline)).toBe(0);
    expect(remainingTerminalHostDeadlineMs(undefined)).toBeUndefined();
  });
});
