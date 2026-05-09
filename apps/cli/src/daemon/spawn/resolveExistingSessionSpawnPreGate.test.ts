import { describe, expect, it, vi } from 'vitest';

import { resolveExistingSessionSpawnPreGate } from './resolveExistingSessionSpawnPreGate';

describe('resolveExistingSessionSpawnPreGate', () => {
  it('returns the already-running existing session before spawning a new attach process', async () => {
    const isSessionRunnerActive = vi.fn(async () => true);
    const logDebug = vi.fn();
    const onAlreadyRunning = vi.fn(async () => {});

    const resolved = await resolveExistingSessionSpawnPreGate({
      existingSessionId: 'sess-live',
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
        sessionId: 'sess-live',
      },
    });
    expect(isSessionRunnerActive).toHaveBeenCalledWith('sess-live');
    expect(logDebug).toHaveBeenCalledWith('[DAEMON RUN] Resume requested for sess-live, but session is already running');
    expect(onAlreadyRunning).toHaveBeenCalledWith('sess-live');
  });
});
