import { describe, expect, it, vi } from 'vitest';

import {
  requestExplicitRunnerStop,
  resolveRunnerRuntimeDisposalReason,
} from './runnerRuntimeDisposal';

describe('runner runtime disposal', () => {
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

  it('maps killSession to destroy and signal/crash termination to preservation reasons', () => {
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'killSession' })).toBe('session_closed');
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'signal', signal: 'SIGTERM' })).toBe('host_shutdown');
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'uncaughtException', error: new Error('boom') }))
      .toBe('host_shutdown');
    expect(resolveRunnerRuntimeDisposalReason({ kind: 'unhandledRejection', reason: new Error('boom') }))
      .toBe('host_shutdown');
  });
});
