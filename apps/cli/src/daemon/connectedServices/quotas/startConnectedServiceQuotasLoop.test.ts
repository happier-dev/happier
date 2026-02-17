import { describe, expect, it, vi } from 'vitest';

import { startConnectedServiceQuotasLoop } from './startConnectedServiceQuotasLoop';

describe('startConnectedServiceQuotasLoop', () => {
  it('schedules tickOnce when enabled', async () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };

	    let captured: (() => void) = () => {};
	    let cleared = 0;
	    const setIntervalFn = ((fn: () => void) => {
	      captured = fn;
	      return 123;
	    });
    const clearIntervalFn = (() => {
      cleared += 1;
    });

    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn,
    });

    expect(handle).not.toBeNull();
    const callback: () => void = captured ?? (() => {
      throw new Error('fixture: expected interval callback');
    });
    callback();
    await Promise.resolve();

    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
    handle?.stop();
    expect(cleared).toBe(1);
  });

  it('unrefs the interval handle when supported', () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };
    const unref = vi.fn();
    const setIntervalFn = vi.fn(() => ({ unref }));

    startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const handle = startConnectedServiceQuotasLoop({
      enabled: false,
      tickMs: 10,
      coordinator: { tickOnce: vi.fn() },
      onTickError: vi.fn(),
      setIntervalFn: () => 123,
      clearIntervalFn: () => {},
    });
    expect(handle).toBeNull();
  });
});
