import { describe, expect, it, vi } from 'vitest';

import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { logger } from '@/ui/logger';
import { cleanupSessionResources, registerSessionSpawnResourceCleanup, retireUpstreamAuthorityBeforeProcessStop } from './cleanupSessionResources';
import { legacyPidSessionTrackingKey as key, type SessionTrackingKey } from './sessionTrackingKey';

describe('registerSessionSpawnResourceCleanup', () => {
  it('identifies the failed resource rather than a later registration that only joins its cleanup', async () => {
    const boundaryError = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const cleanups = new Map<SessionTrackingKey, () => void | Promise<void>>();
    registerSessionSpawnResourceCleanup({
      trackingKey: key(45),
      label: 'provider_broker.binding.open',
      spawnResourceCleanupByKey: cleanups,
      isCurrentOwner: () => true,
      cleanup: async () => { throw boundaryError; },
    });
    registerSessionSpawnResourceCleanup({
      trackingKey: key(45),
      label: 'mcp.plugin.prepare',
      spawnResourceCleanupByKey: cleanups,
      isCurrentOwner: () => true,
      cleanup: async () => {},
    });

    const result = cleanups.get(key(45))!();
    await expect(result).rejects.toMatchObject({
      message: 'Session resource cleanup failed: provider_broker.binding.open',
      cause: boundaryError,
    });
    expect(cleanups.has(key(45))).toBe(true);
    // File logging is a system boundary. Keep the labelled Error nested so the
    // logger's canonical structured serializer retains the original cause.
    const diagnostic = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      expect(await retireUpstreamAuthorityBeforeProcessStop({ trackingKey: key(45), spawnResourceCleanupByKey: cleanups })).toBe(false);
      expect(diagnostic).toHaveBeenCalledWith(
        '[DAEMON RUN] Failed to retire upstream authority before process stop',
        expect.objectContaining({ trackingKey: key(45), error: expect.objectContaining({
          message: 'Session resource cleanup failed: provider_broker.binding.open', cause: boundaryError,
        }) }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('retries failed retirement through PID cleanup while retaining completed stages and concurrent joining', async () => {
    const events: string[] = [];
    // A failed filesystem removal is a retryable system boundary. All cleanup
    // composition, resource custody, and retirement logic below remain real.
    let removeAttempts = 0;
    let failRemoval: (() => void) | undefined;
    const failedRemoval = new Promise<void>((_resolve, reject) => {
      failRemoval = () => reject(new Error('filesystem unavailable'));
    });
    const scope = createProviderLaunchResourceScope();
    scope.register(async () => {
      events.push('remove');
      removeAttempts += 1;
      if (removeAttempts === 1) await failedRemoval;
    });
    const cleanups = new Map<SessionTrackingKey, () => void | Promise<void>>();
    cleanups.set(key(44), scope.transfer()!);
    registerSessionSpawnResourceCleanup({
      trackingKey: key(44),
      spawnResourceCleanupByKey: cleanups,
      isCurrentOwner: () => true,
      cleanup: async () => { events.push('authority'); },
    });
    const retirement = { trackingKey: key(44), spawnResourceCleanupByKey: cleanups };
    const first = retireUpstreamAuthorityBeforeProcessStop(retirement);
    const concurrent = retireUpstreamAuthorityBeforeProcessStop(retirement);
    failRemoval!();
    expect(await Promise.all([first, concurrent])).toEqual([false, false]);
    expect(cleanups.has(key(44))).toBe(true);
    expect(events).toEqual(['authority', 'remove']);

    const attachCleanups = new Map<SessionTrackingKey, () => Promise<void>>([
      [key(44), async () => { events.push('attach'); }],
    ]);
    expect(await cleanupSessionResources({ ...retirement, sessionAttachCleanupByKey: attachCleanups })).toBe(true);
    expect(events).toEqual(['authority', 'remove', 'remove', 'attach']);
    expect(cleanups.has(key(44))).toBe(false);
    expect(attachCleanups.has(key(44))).toBe(false);
  });

  it('composes exact recovered Provider cleanup before existing PID resources', async () => {
    const events: string[] = [];
    const previousCleanup = vi.fn(async () => {
      events.push('previous');
    });
    const providerCleanup = vi.fn(async () => {
      events.push('provider');
    });
    const cleanups = new Map<SessionTrackingKey, () => void | Promise<void>>([
      [key(41), previousCleanup],
    ]);

    const release = registerSessionSpawnResourceCleanup({
      trackingKey: key(41),
      spawnResourceCleanupByKey: cleanups,
      isCurrentOwner: () => true,
      cleanup: providerCleanup,
    });
    const cleanup = cleanups.get(key(41));

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
    const cleanups = new Map<SessionTrackingKey, () => void | Promise<void>>([
      [key(42), previousCleanup],
    ]);
    const release = registerSessionSpawnResourceCleanup({
      trackingKey: key(42),
      spawnResourceCleanupByKey: cleanups,
      isCurrentOwner: () => true,
      cleanup: vi.fn(),
    });

    release?.();
    expect(cleanups.get(key(42))).toBe(previousCleanup);

    const secondRelease = registerSessionSpawnResourceCleanup({
      trackingKey: key(42),
      spawnResourceCleanupByKey: cleanups,
      isCurrentOwner: () => true,
      cleanup: vi.fn(),
    });
    cleanups.set(key(42), replacementCleanup);
    secondRelease?.();
    expect(cleanups.get(key(42))).toBe(replacementCleanup);
  });

  it('publishes no cleanup when exact PID ownership changes during registration', () => {
    const previousCleanup = vi.fn();
    const cleanups = new Map<SessionTrackingKey, () => void | Promise<void>>([
      [key(43), previousCleanup],
    ]);
    let ownerCheck = 0;

    const release = registerSessionSpawnResourceCleanup({
      trackingKey: key(43),
      spawnResourceCleanupByKey: cleanups,
      isCurrentOwner: () => {
        ownerCheck += 1;
        return ownerCheck === 1;
      },
      cleanup: vi.fn(),
    });

    expect(release).toBeNull();
    expect(cleanups.get(key(43))).toBe(previousCleanup);
  });
});
