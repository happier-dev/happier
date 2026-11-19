import { describe, expect, it, vi } from 'vitest';

import { CliReloginRequiredError } from '@/persistence';
import { waitForInitialCredentials } from './waitForInitialCredentials';

describe('waitForInitialCredentials', () => {
  it('continues immediately in interactive mode', async () => {
    const readCredentials = vi.fn(async () => ({ token: 'x' }));

    const result = await waitForInitialCredentials({
      isInteractive: true,
      waitForAuthEnabled: false,
      waitForAuthTimeoutMs: 0,
      credentialsPath: '/tmp/creds',
      readCredentials,
      acquireDaemonLock: async () => null,
      releaseDaemonLock: async () => {},
      resolvesWhenShutdownRequested: new Promise(() => {}),
      logger: { debug: vi.fn(), warn: vi.fn() },
      daemonLockHandle: null,
      sleepMs: 0,
    });

    expect(result).toEqual({ action: 'continue', daemonLockHandle: null });
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it('continues without a refusal when non-interactive credentials are available', async () => {
    const warn = vi.fn();
    const result = await waitForInitialCredentials({
      isInteractive: false,
      waitForAuthEnabled: false,
      waitForAuthTimeoutMs: 0,
      credentialsPath: '/tmp/creds',
      readCredentials: async () => ({ token: 'fixture' }),
      acquireDaemonLock: async () => null,
      releaseDaemonLock: async () => {},
      resolvesWhenShutdownRequested: new Promise(() => {}),
      logger: { debug: vi.fn(), warn },
      daemonLockHandle: null,
    });

    expect(result).toEqual({ action: 'continue', daemonLockHandle: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('exits with code 1 when non-interactive and auth wait is disabled', async () => {
    const warn = vi.fn();
    const result = await waitForInitialCredentials({
      isInteractive: false,
      waitForAuthEnabled: false,
      waitForAuthTimeoutMs: 0,
      credentialsPath: '/tmp/creds',
      readCredentials: async () => null,
      acquireDaemonLock: async () => 'lock',
      releaseDaemonLock: async () => {},
      resolvesWhenShutdownRequested: new Promise(() => {}),
      logger: { debug: vi.fn(), warn },
      daemonLockHandle: null,
      sleepMs: 0,
    });

    expect(result).toEqual({ action: 'exit', exitCode: 1, daemonLockHandle: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[daemon_authentication_required]'));
  });

  it('exits with code 0 when another waiting daemon already holds the lock', async () => {
    const result = await waitForInitialCredentials({
      isInteractive: false,
      waitForAuthEnabled: true,
      waitForAuthTimeoutMs: 0,
      credentialsPath: '/tmp/creds',
      readCredentials: async () => null,
      acquireDaemonLock: async () => null,
      releaseDaemonLock: async () => {},
      resolvesWhenShutdownRequested: new Promise(() => {}),
      logger: { debug: vi.fn(), warn: vi.fn() },
      daemonLockHandle: null,
      sleepMs: 0,
    });

    expect(result).toEqual({ action: 'exit', exitCode: 0, daemonLockHandle: null });
  });

  it.each([
    ['missing', null],
    ['obsolete', new CliReloginRequiredError()],
  ] as const)('continues when %s credentials are replaced while waiting', async (_state, refusal) => {
    const readBeforeSignIn = async () => {
      if (refusal) throw refusal;
      return null;
    };
    const readCredentials = vi
      .fn<() => Promise<unknown | null>>()
      .mockImplementationOnce(readBeforeSignIn)
      .mockImplementationOnce(readBeforeSignIn)
      .mockResolvedValueOnce({ token: 'ready' });

    const result = await waitForInitialCredentials({
      isInteractive: false,
      waitForAuthEnabled: true,
      waitForAuthTimeoutMs: 10_000,
      credentialsPath: '/tmp/creds',
      readCredentials,
      acquireDaemonLock: async () => 'lock-1',
      releaseDaemonLock: async () => {},
      resolvesWhenShutdownRequested: new Promise(() => {}),
      logger: { debug: vi.fn(), warn: vi.fn() },
      daemonLockHandle: null,
      sleepMs: 0,
    });

    expect(result).toEqual({ action: 'continue', daemonLockHandle: 'lock-1' });
    expect(readCredentials).toHaveBeenCalledTimes(3);
  });

  it('releases lock and returns shutdown when shutdown is requested while waiting', async () => {
    let triggerShutdown: (() => void) | null = null;
    const resolvesWhenShutdownRequested = new Promise<void>((resolve) => {
      triggerShutdown = resolve;
    });

    const releaseDaemonLock = vi.fn(async () => {});

    const readCredentials = vi.fn(async () => {
      triggerShutdown?.();
      return null;
    });

    const result = await waitForInitialCredentials({
      isInteractive: false,
      waitForAuthEnabled: true,
      waitForAuthTimeoutMs: 10_000,
      credentialsPath: '/tmp/creds',
      readCredentials,
      acquireDaemonLock: async () => 'lock-1',
      releaseDaemonLock,
      resolvesWhenShutdownRequested,
      logger: { debug: vi.fn(), warn: vi.fn() },
      daemonLockHandle: null,
      sleepMs: 0,
    });

    expect(result).toEqual({ action: 'shutdown', daemonLockHandle: null });
    expect(releaseDaemonLock).toHaveBeenCalledWith('lock-1');
  });
});
