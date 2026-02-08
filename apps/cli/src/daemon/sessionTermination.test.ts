import { describe, expect, it, vi } from 'vitest';
import type { TrackedSession } from './types';

describe('daemon session termination reporting', () => {
  it('emits session-end when sessionId is known', async () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
    };

    const { reportDaemonObservedSessionExit } = await import('./sessionTermination');

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 123,
      happySessionId: 'sess_1',
    };

    const now = 1710000000000;
    reportDaemonObservedSessionExit({
      apiMachine,
      trackedSession: tracked,
      now: () => now,
      exit: { reason: 'process-missing' },
    });

    expect(apiMachine.emitSessionEnd).toHaveBeenCalledWith({
      sid: 'sess_1',
      time: now,
      exit: expect.objectContaining({
        observedBy: 'daemon',
        reason: 'process-missing',
        pid: 123,
      }),
    });
  });

  it('does not emit session-end when sessionId is unknown', async () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
    };

    const { reportDaemonObservedSessionExit } = await import('./sessionTermination');

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 123,
    };

    reportDaemonObservedSessionExit({
      apiMachine,
      trackedSession: tracked,
      now: () => 1,
      exit: { reason: 'process-missing' },
    });

    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
  });

  it('does not emit session-end when sessionId is empty', async () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
    };

    const { reportDaemonObservedSessionExit } = await import('./sessionTermination');

    const tracked: TrackedSession = {
      startedBy: 'daemon',
      pid: 456,
      happySessionId: '',
    };

    reportDaemonObservedSessionExit({
      apiMachine,
      trackedSession: tracked,
      now: () => 2,
      exit: { reason: 'signal', signal: 'SIGTERM' },
    });

    expect(apiMachine.emitSessionEnd).not.toHaveBeenCalled();
  });

  it('propagates explicit exit code and signal when provided', async () => {
    const apiMachine = {
      emitSessionEnd: vi.fn(),
    };

    const { reportDaemonObservedSessionExit } = await import('./sessionTermination');

    const tracked: TrackedSession = {
      startedBy: 'terminal',
      pid: 999,
      happySessionId: 'sess_2',
    };

    reportDaemonObservedSessionExit({
      apiMachine,
      trackedSession: tracked,
      now: () => 3,
      exit: { reason: 'process-exited', code: 137, signal: 'SIGKILL' },
    });

    expect(apiMachine.emitSessionEnd).toHaveBeenCalledWith({
      sid: 'sess_2',
      time: 3,
      exit: expect.objectContaining({
        observedBy: 'daemon',
        pid: 999,
        reason: 'process-exited',
        code: 137,
        signal: 'SIGKILL',
      }),
    });
  });
});
