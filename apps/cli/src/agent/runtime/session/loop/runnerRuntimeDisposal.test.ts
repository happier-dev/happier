import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  abortAndDisposeRunnerRuntime,
  requestExplicitRunnerStop,
  resolveRunnerRuntimeDisposalReason,
} from './runnerRuntimeDisposal';

describe('runner runtime disposal', () => {
  it('releases native process custody and terminates while native cancellation never settles', async () => {
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    // The native process is the OS boundary; cancellation and host disposal logic stay real.
    const nativeProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const nativeExit = new Promise<void>((resolve, reject) => {
      nativeProcess.once('exit', () => resolve());
      nativeProcess.once('error', reject);
    });
    let settled = false;
    let terminationRequested = false;
    const stopping = requestExplicitRunnerStop({
      abortActiveTurn: () => cancellation,
      disposeRuntime: async (reason) => {
        expect(reason).toBe('session_closed');
        nativeProcess.kill();
        await nativeExit;
      },
      requestTermination: () => { terminationRequested = true; },
      whenTerminated: Promise.resolve(),
    }).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(
        nativeProcess.exitCode !== null || nativeProcess.signalCode !== null,
      ).toBe(true));
      await vi.waitFor(() => expect(terminationRequested).toBe(true));
      await stopping;
      expect(settled).toBe(true);
    } finally {
      releaseCancellation();
      await stopping;
      if (nativeProcess.exitCode === null && nativeProcess.signalCode === null) nativeProcess.kill();
      await nativeExit;
    }
  });

  it('disposes as session_closed before explicit runner termination', async () => {
    const order: string[] = [];

    await requestExplicitRunnerStop({
      abortActiveTurn: async () => {
        order.push('turn_aborted');
      },
      disposeRuntime: async (reason) => {
        order.push(`runtime_disposed:${reason}`);
      },
      requestTermination: () => {
        order.push('termination_requested');
      },
      whenTerminated: Promise.resolve(),
    });

    expect(order).toEqual([
      'turn_aborted',
      'runtime_disposed:session_closed',
      'termination_requested',
    ]);
  });

  it('fails closed when explicit runtime disposal fails', async () => {
    const disposalError = new Error('injected runtime disposal failure');
    const requestTermination = vi.fn();

    await expect(requestExplicitRunnerStop({
      abortActiveTurn: async () => undefined,
      disposeRuntime: async () => {
        throw disposalError;
      },
      requestTermination,
      whenTerminated: Promise.resolve(),
    })).rejects.toBe(disposalError);

    expect(requestTermination).not.toHaveBeenCalled();
  });

  it('finishes signal cleanup after disposal without waiting for native cancellation', async () => {
    let disposed = false;
    let finished = false;
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const cleanup = abortAndDisposeRunnerRuntime({
      abortActiveTurn: () => cancellation,
      disposeRuntime: async (reason) => {
        expect(reason).toBe('host_shutdown');
        disposed = true;
      },
      reason: 'host_shutdown',
    }).then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(disposed).toBe(true));
      await vi.waitFor(() => expect(finished).toBe(true));
    } finally {
      releaseCancellation();
      await cleanup;
    }
  });

  it('still disposes and terminates when native cancellation rejects', async () => {
    let disposed = false;
    let terminationRequested = false;
    await requestExplicitRunnerStop({
      abortActiveTurn: async () => { throw new Error('native cancel rejected'); },
      disposeRuntime: async () => { disposed = true; },
      requestTermination: () => { terminationRequested = true; },
      whenTerminated: Promise.resolve(),
    });
    expect(disposed).toBe(true);
    expect(terminationRequested).toBe(true);
  });

  it('maps killSession to destroy and signal/crash termination to preservation reasons', () => {
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'killSession' })).toBe('session_closed');
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'signal', signal: 'SIGTERM' })).toBe('host_shutdown');
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'uncaughtException', error: new Error('boom') }))
      .toBe('host_shutdown');
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'unhandledRejection', reason: new Error('boom') }))
      .toBe('host_shutdown');
  });
});
