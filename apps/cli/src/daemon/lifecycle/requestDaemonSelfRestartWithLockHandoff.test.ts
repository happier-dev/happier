import { describe, expect, it, vi } from 'vitest';

import {
  requestDaemonSelfRestartWithLockHandoff,
  resolveDaemonSelfRestartEnvironment,
} from './requestDaemonSelfRestartWithLockHandoff';

describe('requestDaemonSelfRestartWithLockHandoff', () => {
  it('projects the exact successor fingerprint into the inherited restart environment', () => {
    expect(resolveDaemonSelfRestartEnvironment(
      'abcdef1234567890',
      { KEEP_ME: '1' },
    )).toEqual({
      KEEP_ME: '1',
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'abcdef1234567890',
    });
    expect(resolveDaemonSelfRestartEnvironment(undefined, { KEEP_ME: '1' })).toBeUndefined();
  });

  it('quiesces plugin changes and session admission before releasing the daemon lock', async () => {
    const events: string[] = [];
    let finishQuiescing!: () => void;
    const quiescingBlocked = new Promise<void>((resolve) => {
      finishQuiescing = resolve;
    });
    const resume = vi.fn(() => {
      events.push('resume');
    });
    const quiesceBeforeLockRelease = vi.fn(async () => {
      events.push('quiesce');
      await quiescingBlocked;
      return { resume };
    });
    const releaseDaemonLock = vi.fn(async () => {
      events.push('release-lock');
    });
    const acquireDaemonLock = vi.fn(async () => 'reacquired-lock');
    const requestSelfRestart = vi.fn(async () => {
      events.push('restart');
      return { status: 'exited' as const };
    });
    let currentLock: string | null = 'current-lock';

    const restarting = requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => currentLock,
      setCurrentDaemonLockHandle: (lock) => {
        currentLock = lock;
      },
      quiesceBeforeLockRelease,
      releaseDaemonLock,
      acquireDaemonLock,
      requestShutdown: vi.fn(),
      requestSelfRestart,
      selfRestartParams: {
        expectedCliVersion: '2.0.0',
        timeoutMs: 30_000,
        pollMs: 250,
      },
    });

    await vi.waitFor(() => expect(quiesceBeforeLockRelease).toHaveBeenCalledTimes(1));
    expect(releaseDaemonLock).not.toHaveBeenCalled();
    expect(requestSelfRestart).not.toHaveBeenCalled();

    finishQuiescing();
    const result = await restarting;

    expect(result.status).toBe('exited');
    expect(releaseDaemonLock).toHaveBeenCalledWith('current-lock');
    expect(requestSelfRestart).toHaveBeenCalledWith(expect.objectContaining({
      expectedCliVersion: '2.0.0',
    }));
    expect(acquireDaemonLock).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(events).toEqual(['quiesce', 'release-lock', 'restart']);
    expect(currentLock).toBeNull();
  });

  it('reacquires the daemon lock before resuming admission when replacement confirmation fails', async () => {
    const events: string[] = [];
    const releaseDaemonLock = vi.fn(async () => {
      events.push('release-lock');
    });
    const acquireDaemonLock = vi.fn(async () => {
      events.push('reacquire-lock');
      return 'reacquired-lock';
    });
    const requestShutdown = vi.fn();
    let currentLock: string | null = 'current-lock';

    const result = await requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => currentLock,
      setCurrentDaemonLockHandle: (lock) => {
        currentLock = lock;
      },
      quiesceBeforeLockRelease: async () => {
        events.push('quiesce');
        return {
          resume: () => {
            events.push(`resume:${currentLock}`);
          },
        };
      },
      releaseDaemonLock,
      acquireDaemonLock,
      requestShutdown,
      requestSelfRestart: vi.fn(async () => {
        events.push('restart');
        return { status: 'replacement_not_confirmed' as const };
      }),
      selfRestartParams: {
        expectedCliVersion: '2.0.0',
        timeoutMs: 30_000,
        pollMs: 250,
      },
    });

    expect(result.status).toBe('replacement_not_confirmed');
    expect(acquireDaemonLock).toHaveBeenCalledTimes(1);
    expect(currentLock).toBe('reacquired-lock');
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(events).toEqual([
      'quiesce',
      'release-lock',
      'restart',
      'reacquire-lock',
      'resume:reacquired-lock',
    ]);
  });

  it('stores the reacquired daemon lock before resuming admission when the restart request throws', async () => {
    const events: string[] = [];
    const releaseDaemonLock = vi.fn(async () => {
      events.push('release-lock');
    });
    const acquireDaemonLock = vi.fn(async () => {
      events.push('reacquire-lock');
      return 'reacquired-lock';
    });
    const requestShutdown = vi.fn();
    let currentLock: string | null = 'current-lock';

    await expect(
      requestDaemonSelfRestartWithLockHandoff({
        getCurrentDaemonLockHandle: () => currentLock,
        setCurrentDaemonLockHandle: (lock) => {
          currentLock = lock;
        },
        quiesceBeforeLockRelease: async () => {
          events.push('quiesce');
          return {
            resume: () => {
              events.push(`resume:${currentLock}`);
            },
          };
        },
        releaseDaemonLock,
        acquireDaemonLock,
        requestShutdown,
        requestSelfRestart: vi.fn(async () => {
          events.push('restart');
          throw new Error('boom');
        }),
        selfRestartParams: {
          expectedCliVersion: '2.0.0',
          timeoutMs: 30_000,
          pollMs: 250,
        },
      }),
    ).rejects.toThrow('boom');

    expect(acquireDaemonLock).toHaveBeenCalledTimes(1);
    expect(currentLock).toBe('reacquired-lock');
    expect(requestShutdown).not.toHaveBeenCalled();
    expect(events).toEqual([
      'quiesce',
      'release-lock',
      'restart',
      'reacquire-lock',
      'resume:reacquired-lock',
    ]);
  });

  it('resumes admission without requesting a restart when lock release fails', async () => {
    const resume = vi.fn();
    const requestSelfRestart = vi.fn(async () => ({ status: 'exited' as const }));
    let currentLock: string | null = 'current-lock';

    await expect(requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => currentLock,
      setCurrentDaemonLockHandle: (lock) => {
        currentLock = lock;
      },
      quiesceBeforeLockRelease: async () => ({ resume }),
      releaseDaemonLock: async () => {
        throw new Error('release failed');
      },
      acquireDaemonLock: vi.fn(async () => 'not-used'),
      requestShutdown: vi.fn(),
      requestSelfRestart,
      selfRestartParams: {
        expectedCliVersion: '2.0.0',
        timeoutMs: 30_000,
        pollMs: 250,
      },
    })).rejects.toThrow('release failed');

    expect(resume).toHaveBeenCalledTimes(1);
    expect(requestSelfRestart).not.toHaveBeenCalled();
    expect(currentLock).toBe('current-lock');
  });

  it('stays quiesced and shuts down when failed replacement cannot reacquire the lock', async () => {
    const resume = vi.fn();
    const requestShutdown = vi.fn();
    let currentLock: string | null = 'current-lock';

    await expect(requestDaemonSelfRestartWithLockHandoff({
      getCurrentDaemonLockHandle: () => currentLock,
      setCurrentDaemonLockHandle: (lock) => {
        currentLock = lock;
      },
      quiesceBeforeLockRelease: async () => ({ resume }),
      releaseDaemonLock: vi.fn(async () => undefined),
      acquireDaemonLock: vi.fn(async () => null),
      requestShutdown,
      requestSelfRestart: vi.fn(async () => ({ status: 'replacement_not_confirmed' as const })),
      selfRestartParams: {
        expectedCliVersion: '2.0.0',
        timeoutMs: 30_000,
        pollMs: 250,
      },
    })).rejects.toThrow('could not reacquire its lifecycle lock');

    expect(resume).not.toHaveBeenCalled();
    expect(requestShutdown).toHaveBeenCalledWith(
      'exception',
      expect.stringContaining('could not reacquire its lifecycle lock'),
    );
    expect(currentLock).toBeNull();
  });
});
