import { describe, expect, it } from 'vitest';

describe('pid inspection helpers', () => {
  it('polls until inspection succeeds or timeout elapses', async () => {
    const processHelpers = await import('@/testkit/process/pidInspection').catch(() => null);

    expect(processHelpers).not.toBeNull();
    expect(processHelpers?.waitForPidInspection).toBeTypeOf('function');

    const inspected = await processHelpers!.waitForPidInspection(async () => null, 123, {
      timeoutMs: 25,
      intervalMs: 5,
    });

    expect(inspected).toBeNull();
  });

  it('accepts falsy non-null inspection values', async () => {
    const { waitForPidInspection } = await import('@/testkit/process/pidInspection');

    const inspected = await waitForPidInspection(async () => 0, 12345, {
      timeoutMs: 25,
      intervalMs: 1,
    });

    expect(inspected).toBe(0);
  });
});
