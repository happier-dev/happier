import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isConnectedServiceRestartSignalStaleProcessError,
  requestConnectedServiceSessionRestartSignal,
} from './requestConnectedServiceSessionRestartSignal';

describe('requestConnectedServiceSessionRestartSignal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for a delayed restart signal before resolving', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    let settled = false;
    const promise = requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 50,
      onSignalFailure: () => {},
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(settled).toBe(true);
  });

  it('rejects when a non-stale restart signal fails', async () => {
    const error = new Error('operation not permitted');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const onSignalFailure = vi.fn();

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure,
    })).rejects.toThrow(error);

    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(onSignalFailure).toHaveBeenCalledWith(error);
  });

  it('treats an already-missing process as a completed restart request', async () => {
    const error = new Error('no such process');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const onSignalFailure = vi.fn();
    const onProcessAlreadyMissing = vi.fn();
    const records: unknown[] = [];

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure,
      onProcessAlreadyMissing,
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic: {
        trigger: 'automatic_group_switch',
        sessionId: 'session-1',
        agentId: 'codex',
        serviceId: 'openai-codex',
        profileId: 'codex1',
        groupId: 'happier',
        generation: 70,
        reason: 'usage_limit',
      },
    })).resolves.toEqual({ status: 'process_already_missing' });

    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(onSignalFailure).not.toHaveBeenCalled();
    expect(onProcessAlreadyMissing).toHaveBeenCalledOnce();
    expect(records).toEqual([
      expect.objectContaining({
        status: 'requested',
        sessionId: 'session-1',
        pid: 123,
      }),
      expect.objectContaining({
        status: 'process_already_missing',
        sessionId: 'session-1',
        pid: 123,
      }),
    ]);
  });

  it('classifies missing process signal failures without treating every signal error as stale', () => {
    const staleByCode = new Error('kill ESRCH');
    Object.assign(staleByCode, { code: 'ESRCH' });

    expect(isConnectedServiceRestartSignalStaleProcessError(staleByCode)).toBe(true);
    expect(isConnectedServiceRestartSignalStaleProcessError(new Error('no such process'))).toBe(true);
    expect(isConnectedServiceRestartSignalStaleProcessError(new Error('operation not permitted'))).toBe(false);
  });

  it('records a uniform daemon restart diagnostic after signaling so the final gate stays last', async () => {
    const events: string[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      events.push('signal');
      return true;
    });
    const records: unknown[] = [];

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      preferProcessGroup: true,
      onSignalFailure: () => {},
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => {
        events.push('diagnostic');
        records.push(record);
      },
      restartDiagnostic: {
        trigger: 'manual_switch',
        sessionId: 'session-1',
        agentId: 'claude',
        serviceId: 'claude-subscription',
        profileId: 'work',
        groupId: null,
        generation: null,
        reason: 'manual',
      },
    })).resolves.toEqual({ status: 'requested' });

    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
    expect(events).toEqual(['signal', 'diagnostic']);
    expect(records).toEqual([{
      type: 'connected_service_daemon_restart',
      trigger: 'manual_switch',
      status: 'requested',
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'work',
      groupId: null,
      generation: null,
      reason: 'manual',
      pid: 123,
      processGroupPid: 123,
      delayMs: 0,
      atMs: 10_000,
    }]);
  });

  it('records a signal-failed daemon restart diagnostic when non-stale signaling fails', async () => {
    const error = new Error('operation not permitted');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const records: unknown[] = [];

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      onSignalFailure: () => {},
      nowMs: () => 10_000,
      recordRestartDiagnostic: (record: unknown) => records.push(record),
      restartDiagnostic: {
        trigger: 'runtime_auth_recovery_restart',
        sessionId: 'session-1',
        agentId: 'codex',
        serviceId: 'openai-codex',
        profileId: 'primary',
        groupId: 'main',
        generation: 2,
        reason: 'auth_expired',
      },
    })).rejects.toThrow(error);

    expect(records).toEqual([
      expect.objectContaining({
        type: 'connected_service_daemon_restart',
        trigger: 'runtime_auth_recovery_restart',
        status: 'requested',
        sessionId: 'session-1',
        pid: 123,
      }),
      expect.objectContaining({
        type: 'connected_service_daemon_restart',
        trigger: 'runtime_auth_recovery_restart',
        status: 'signal_failed',
        sessionId: 'session-1',
        pid: 123,
      }),
    ]);
  });

  it('prefers the daemon-spawned process group when requested', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      preferProcessGroup: true,
      onSignalFailure: () => {},
    })).resolves.toEqual({ status: 'requested' });

    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(123, 'SIGTERM');
  });

  it('falls back to the session pid when process-group signalling fails', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -123) throw new Error('group unavailable');
      return true;
    });

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      preferProcessGroup: true,
      onSignalFailure: () => {},
    })).resolves.toEqual({ status: 'requested' });

    expect(kill).toHaveBeenNthCalledWith(1, -123, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 123, 'SIGTERM');
  });

  it('rechecks the exact signal witness after process-group failure before pid fallback', async () => {
    let exactSignalWitnessIsCurrent = true;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -123) {
        exactSignalWitnessIsCurrent = false;
        throw new Error('group unavailable');
      }
      return true;
    });
    const shouldSignal = vi.fn(() => exactSignalWitnessIsCurrent);

    await expect(requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 0,
      preferProcessGroup: true,
      shouldSignal,
      onSignalFailure: () => {},
    })).resolves.toEqual({ status: 'skipped_stale_owner' });

    expect(shouldSignal).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(123, 'SIGTERM');
  });

  it('skips a delayed signal when the session no longer owns the pid', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const shouldSignal = vi.fn(() => false);

    const promise = requestConnectedServiceSessionRestartSignal({
      pid: 123,
      delayMs: 50,
      shouldSignal,
      onSignalFailure: () => {},
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toEqual({ status: 'skipped_stale_owner' });

    expect(shouldSignal).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });
});
