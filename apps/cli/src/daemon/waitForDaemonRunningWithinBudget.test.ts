import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hasObservableDaemonStartProcessExited,
  waitForDaemonRunningWithinBudget,
} from './waitForDaemonRunningWithinBudget';

describe('waitForDaemonRunningWithinBudget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('observes POSIX daemon process exits without treating the Windows launcher exit as fatal', () => {
    const exited = { exitCode: 1, signalCode: null };

    expect(hasObservableDaemonStartProcessExited(exited, 'darwin')).toBe(true);
    expect(hasObservableDaemonStartProcessExited(exited, 'linux')).toBe(true);
    expect(hasObservableDaemonStartProcessExited(exited, 'win32')).toBe(false);
    expect(hasObservableDaemonStartProcessExited({ exitCode: null, signalCode: null }, 'darwin'))
      .toBe(false);
  });

  it('checks once more after the final sleep before giving up on the budget', async () => {
    const isRunning = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn(async () => undefined);

    await expect(waitForDaemonRunningWithinBudget({
      isRunning,
      timeoutMs: 200,
      pollMs: 100,
      sleep,
    })).resolves.toBe(true);

    expect(isRunning).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it('stops polling when the spawned daemon process has already exited', async () => {
    const isRunning = vi.fn(async () => false);
    const shouldAbort = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const sleep = vi.fn(async () => undefined);

    await expect(waitForDaemonRunningWithinBudget({
      isRunning,
      shouldAbort,
      timeoutMs: 900_000,
      pollMs: 100,
      sleep,
    })).resolves.toBe(false);

    expect(isRunning).toHaveBeenCalledTimes(2);
    expect(shouldAbort).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
