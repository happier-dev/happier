import { describe, expect, it, vi } from 'vitest';

const isPidSafeHappySessionProcess = vi.fn(async () => true);
vi.mock('../pidSafety', () => ({
  isPidSafeHappySessionProcess,
}));

describe('createStopSession', () => {
  it('keeps matched tracked sessions until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    const killDaemonChild = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [111, { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1', childProcess: { kill: killDaemonChild }, processCommandHash: 'h1' }],
      [222, { startedBy: 'terminal', pid: 222, happySessionId: 'sess-1', processCommandHash: 'h2' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(true);
    expect(killDaemonChild).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(2);
    expect(pidToTrackedSession.has(111)).toBe(true);
    expect(pidToTrackedSession.has(222)).toBe(true);
  });

  it('keeps tracked daemon sessions when falling back to child-process SIGTERM', async () => {
    const { createStopSession } = await import('./stopSession');

    const killDaemonChild = vi.fn();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (typeof pid === 'number' && pid < 0) {
        throw new Error('no process group');
      }
      return true as any;
    });

    const pidToTrackedSession = new Map<number, any>([
      [111, { startedBy: 'daemon', pid: 111, happySessionId: 'sess-1', childProcess: { kill: killDaemonChild }, processCommandHash: 'h1' }],
      [222, { startedBy: 'terminal', pid: 222, happySessionId: 'sess-1', processCommandHash: 'h2' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(222, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(2);
    expect(pidToTrackedSession.has(111)).toBe(true);
    expect(pidToTrackedSession.has(222)).toBe(true);
  });

  it('keeps daemon-owned tracking when both process-group and child-process termination fail', async () => {
    const { createStopSession } = await import('./stopSession');

    const killDaemonChild = vi.fn(() => {
      throw new Error('child kill failed');
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (typeof pid === 'number' && pid < 0) {
        throw new Error('no process group');
      }
      return true as any;
    });

    const trackedSession = {
      startedBy: 'daemon',
      pid: 111,
      happySessionId: 'sess-1',
      childProcess: { kill: killDaemonChild },
      processCommandHash: 'h1',
    };
    const pidToTrackedSession = new Map<number, any>([
      [111, trackedSession],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-1');

    expect(ok).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
    expect(killDaemonChild).toHaveBeenCalledWith('SIGTERM');
    expect(pidToTrackedSession.get(111)).toBe(trackedSession);
  });

  it('keeps tracked in-flight attaches until exit is observed', async () => {
    const { createStopSession } = await import('./stopSession');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, spawnOptions: { existingSessionId: 'sess-2' }, processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-2');

    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(1);
    expect(pidToTrackedSession.has(333)).toBe(true);
  });
});
