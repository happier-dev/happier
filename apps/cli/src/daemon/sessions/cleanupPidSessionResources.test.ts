import { describe, expect, it, vi } from 'vitest';

import { registerPidSpawnResourceCleanup } from './cleanupPidSessionResources';

describe('registerPidSpawnResourceCleanup', () => {
  it('composes exact recovered Provider cleanup before existing PID resources', async () => {
    const events: string[] = [];
    const previousCleanup = vi.fn(async () => {
      events.push('previous');
    });
    const providerCleanup = vi.fn(async () => {
      events.push('provider');
    });
    const cleanups = new Map<number, () => void | Promise<void>>([
      [41, previousCleanup],
    ]);

    const release = registerPidSpawnResourceCleanup({
      pid: 41,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: providerCleanup,
    });
    const cleanup = cleanups.get(41);

    expect(release).not.toBeNull();
    expect(cleanup).not.toBe(previousCleanup);
    await Promise.all([cleanup?.(), cleanup?.()]);
    expect(events).toEqual(['provider', 'previous']);
    expect(providerCleanup).toHaveBeenCalledOnce();
    expect(previousCleanup).toHaveBeenCalledOnce();
  });

  it('restores only the exact prior PID cleanup when an unconsumed claim rolls back', () => {
    const previousCleanup = vi.fn();
    const replacementCleanup = vi.fn();
    const cleanups = new Map<number, () => void | Promise<void>>([
      [42, previousCleanup],
    ]);
    const release = registerPidSpawnResourceCleanup({
      pid: 42,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: vi.fn(),
    });

    release?.();
    expect(cleanups.get(42)).toBe(previousCleanup);

    const secondRelease = registerPidSpawnResourceCleanup({
      pid: 42,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => true,
      cleanup: vi.fn(),
    });
    cleanups.set(42, replacementCleanup);
    secondRelease?.();
    expect(cleanups.get(42)).toBe(replacementCleanup);
  });

  it('publishes no cleanup when exact PID ownership changes during registration', () => {
    const previousCleanup = vi.fn();
    const cleanups = new Map<number, () => void | Promise<void>>([
      [43, previousCleanup],
    ]);
    let ownerCheck = 0;

    const release = registerPidSpawnResourceCleanup({
      pid: 43,
      spawnResourceCleanupByPid: cleanups,
      isCurrentPidOwner: () => {
        ownerCheck += 1;
        return ownerCheck === 1;
      },
      cleanup: vi.fn(),
    });

    expect(release).toBeNull();
    expect(cleanups.get(43)).toBe(previousCleanup);
  });
});
