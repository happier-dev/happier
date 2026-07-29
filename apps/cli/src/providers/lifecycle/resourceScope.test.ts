import { describe, expect, it, vi } from 'vitest';

import { createProviderLaunchResourceScope } from './resourceScope';

describe('Provider launch resource scope', () => {
  it('releases registered resources in reverse order exactly once', async () => {
    const events: string[] = [];
    const scope = createProviderLaunchResourceScope();
    scope.register(() => { events.push('first'); });
    scope.register(() => { events.push('second'); });

    await scope.release();
    await scope.release();

    expect(events).toEqual(['second', 'first']);
  });

  it('transfers cleanup to the committed child without allowing failure cleanup to run it', async () => {
    const cleanup = vi.fn();
    const scope = createProviderLaunchResourceScope();
    scope.register(cleanup);

    const cleanupOnExit = scope.transfer();
    await scope.release();
    expect(cleanup).not.toHaveBeenCalled();

    await cleanupOnExit?.();
    await cleanupOnExit?.();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('selects failure cleanup before commit and exit cleanup after transfer', async () => {
    const failure = vi.fn();
    const exit = vi.fn();
    const failed = createProviderLaunchResourceScope();
    failed.register({ onFailure: failure, onExit: exit });
    await failed.release();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    const committed = createProviderLaunchResourceScope();
    committed.register({ onFailure: failure, onExit: exit });
    await committed.transfer()?.();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('sanitizes thrown values before releasing the lease that owns the sanitizer', async () => {
    const events: string[] = [];
    const scope = createProviderLaunchResourceScope();
    scope.setSanitizer((value) => value.replaceAll('secret-value', '[REDACTED]'));
    scope.register(() => {
      events.push('cleanup');
      scope.setSanitizer(null);
    });

    expect(scope.sanitize(new Error('failed with secret-value'))).toBe('failed with [REDACTED]');
    await scope.release();
    expect(events).toEqual(['cleanup']);
  });

  it('stops cleanup at the first failure so remaining custody and its sanitizer stay available', async () => {
    const events: string[] = [];
    const cleanupErrors: string[] = [];
    const scope = createProviderLaunchResourceScope({
      onCleanupError: (safeMessage) => cleanupErrors.push(safeMessage),
    });
    scope.setSanitizer((value) => value.replaceAll('secret-value', '[REDACTED]'));
    scope.register(async () => {
      await Promise.resolve();
      events.push('first');
    });
    scope.register(async () => {
      await Promise.resolve();
      events.push('second');
      throw new Error('cleanup leaked secret-value');
    });

    await expect(scope.release()).rejects.toThrow('cleanup leaked secret-value');

    expect(events).toEqual(['second']);
    expect(cleanupErrors).toEqual(['cleanup leaked [REDACTED]']);
  });

  it('returns one awaitable exact-once cleanup after transfer', async () => {
    let releaseCleanup: (() => void) | undefined;
    const releaseBarrier = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanup = vi.fn(async () => {
      await releaseBarrier;
    });
    const scope = createProviderLaunchResourceScope();
    scope.register(cleanup);

    const cleanupOnExit = scope.transfer();
    const first = cleanupOnExit?.();
    const second = cleanupOnExit?.();
    expect(cleanup).toHaveBeenCalledTimes(1);
    releaseCleanup?.();
    await Promise.all([first, second]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('uses one idempotent retirement owner before and after transfer', async () => {
    const precommitFailure = vi.fn();
    const precommitExit = vi.fn();
    const precommit = createProviderLaunchResourceScope();
    precommit.register({
      onFailure: precommitFailure,
      onExit: precommitExit,
    });

    await precommit.retire();
    await precommit.retire();
    expect(precommitFailure).toHaveBeenCalledOnce();
    expect(precommitExit).not.toHaveBeenCalled();

    const committedFailure = vi.fn();
    const committedExit = vi.fn();
    const committed = createProviderLaunchResourceScope();
    committed.register({
      onFailure: committedFailure,
      onExit: committedExit,
    });
    const cleanupOnExit = committed.transfer();

    await committed.retire();
    await cleanupOnExit?.();
    expect(committedFailure).not.toHaveBeenCalled();
    expect(committedExit).toHaveBeenCalledOnce();
  });
});
