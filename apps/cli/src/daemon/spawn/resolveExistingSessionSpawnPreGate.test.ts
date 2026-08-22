import { describe, expect, it, vi } from 'vitest';

import { resolveExistingSessionSpawnPreGate } from './resolveExistingSessionSpawnPreGate';

function serializeLogCalls(calls: readonly unknown[][]): string {
  return JSON.stringify(calls, (_key, value) => value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : value);
}

describe('resolveExistingSessionSpawnPreGate', () => {
  it('fences a restart survivor before activity probing and admits one replacement after retirement', async () => {
    const isSessionRunnerActive = vi.fn(async () => false);
    const onAlreadyRunning = vi.fn(async () => ({ action: 'use_existing' as const }));
    const pidToTrackedSession = new Map([[
      85855,
      {
        pid: 85855,
        startedBy: 'daemon' as const,
        happySessionId: 'sess-restart-unavailable',
        reattachedFromDiskMarker: true,
        agentRuntimeRunnerRestartDisposition: 'runner_authority_unavailable' as const,
      },
    ]]);

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-restart-unavailable',
      pidToTrackedSession,
      isSessionRunnerActive,
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug: vi.fn(),
      onAlreadyRunning,
    });

    expect(resolved.shortCircuitResult).toMatchObject({
      type: 'error',
      errorMessage: expect.stringContaining('restart'),
    });
    expect(isSessionRunnerActive).not.toHaveBeenCalled();
    expect(onAlreadyRunning).not.toHaveBeenCalled();

    pidToTrackedSession.delete(85855);
    await expect(resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-restart-unavailable',
      pidToTrackedSession,
      isSessionRunnerActive,
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug: vi.fn(),
      onAlreadyRunning,
    })).resolves.toEqual({ shortCircuitResult: null });
    expect(isSessionRunnerActive).toHaveBeenCalledOnce();
    expect(onAlreadyRunning).not.toHaveBeenCalled();
  });

  it('returns the already-running existing session before spawning a new attach process', async () => {
    const isSessionRunnerActive = vi.fn(async () => true);
    const logDebug = vi.fn();
    const onAlreadyRunning = vi.fn(async () => {});
    const privateSessionId = 'private-existing-session-sentinel';

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: privateSessionId,
      pidToTrackedSession: new Map(),
      isSessionRunnerActive,
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug,
      onAlreadyRunning,
    });

    expect(resolved).toEqual({
      shortCircuitResult: {
        type: 'success',
        sessionId: privateSessionId,
      },
    });
    expect(isSessionRunnerActive).toHaveBeenCalledWith(privateSessionId);
    expect(onAlreadyRunning).toHaveBeenCalledWith(privateSessionId);
    expect(serializeLogCalls(logDebug.mock.calls)).not.toContain(privateSessionId);
  });

  it('keeps an unavailable activity probe advisory without logging private probe details', async () => {
    const privateSessionId = 'private-probe-session-sentinel';
    const privateProbeError = 'private-probe-error-sentinel';
    const logDebug = vi.fn();

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: privateSessionId,
      pidToTrackedSession: new Map(),
      isSessionRunnerActive: vi.fn(async () => {
        throw new Error(privateProbeError);
      }),
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug,
    });

    expect(resolved).toEqual({ shortCircuitResult: null });
    const serializedLogs = serializeLogCalls(logDebug.mock.calls);
    expect(serializedLogs).not.toContain(privateSessionId);
    expect(serializedLogs).not.toContain(privateProbeError);
  });

  it('continues to replacement spawn when the already-running hook reports an unservable runner', async () => {
    const isSessionRunnerActive = vi.fn(async () => true);
    const logDebug = vi.fn();
    const onAlreadyRunning = vi.fn(async () => ({ action: 'spawn_replacement' as const }));

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-live',
      pidToTrackedSession: new Map(),
      isSessionRunnerActive,
      waitForExitTimeoutMs: 0,
      waitForExitPollIntervalMs: 50,
      logDebug,
      onAlreadyRunning,
    });

    expect(resolved).toEqual({ shortCircuitResult: null });
    expect(onAlreadyRunning).toHaveBeenCalledWith('sess-live');
  });
});
