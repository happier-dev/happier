import { describe, expect, it, vi } from 'vitest';

const isPidSafeHappySessionProcess = vi.fn(async () => true);
vi.mock('../pidSafety', () => ({
  isPidSafeHappySessionProcess,
}));

describe('createStopSession', () => {
  it('stops all tracked pids that match the same sessionId', async () => {
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
    expect(pidToTrackedSession.size).toBe(0);
  });

  it('falls back to killing the daemon child pid when process group kill fails', async () => {
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
    expect(pidToTrackedSession.size).toBe(0);
  });

  it('matches in-flight attaches via spawnOptions.existingSessionId', async () => {
    const { createStopSession } = await import('./stopSession');

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>([
      [333, { startedBy: 'terminal', pid: 333, spawnOptions: { existingSessionId: 'sess-2' }, processCommandHash: 'h3' }],
    ]);

    const stop = createStopSession({ pidToTrackedSession });
    const ok = await stop('sess-2');

    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGTERM');
    expect(pidToTrackedSession.size).toBe(0);
  });
});
