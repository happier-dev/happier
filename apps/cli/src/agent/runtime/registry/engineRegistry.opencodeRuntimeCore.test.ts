import { describe, expect, it } from 'vitest';

describe('engineRegistry (opencode runtimeCore)', () => {
  it('resolves the plugin-owned OpenCode execution-run runtimeCore without consulting the legacy execution-run registry', async () => {
    const { resolveBackendEngineAdapterResolution } = await import('./engineRegistry');

    const resolution = await resolveBackendEngineAdapterResolution('opencode');
    expect(resolution?.backendId).toBe('opencode');

    expect(resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
      cwd: process.cwd(),
      backendId: 'opencode',
      permissionMode: 'read_only',
    })).toEqual(expect.objectContaining({
      readResumeSupport: expect.any(Function),
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      waitForTurnCompletion: expect.any(Function),
      probeTurnLiveness: expect.any(Function),
      dispose: expect.any(Function),
    }));
  }, 60_000);
});
