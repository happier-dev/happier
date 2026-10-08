import { describe, expect, it } from 'vitest';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { isExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

describe('engineRegistry (opencode runtimeCore)', () => {
  it('resolves the plugin-owned OpenCode execution-run runtimeCore without consulting the legacy execution-run registry', async () => {
    const { resolveBackendEngineAdapterResolution } = await import('./engineRegistry');

    const fixture = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: ['happier.agent.opencode'] },
    });
    try {
      const resolution = await resolveBackendEngineAdapterResolution('opencode', { runtimeRegistry: fixture.registry });
      expect(resolution?.backendId).toBe('opencode');

      const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
        scope: 'detached',
        runId: 'opencode-runtime-owner',
        start: { intent: 'review', profileId: 'review' },
        cwd: process.cwd(),
        backendId: 'opencode',
        permissionMode: 'read_only',
      });
      expect(isExecutionRunHostRuntime(runtime)).toBe(true);
      expect(runtime).toEqual(expect.objectContaining({
        readResumeSupport: expect.any(Function),
        provisionRuntime: expect.any(Function),
        deliverInput: expect.any(Function),
        getRuntimeLifetimeSignal: expect.any(Function),
        waitForTurnCompletion: expect.any(Function),
        cancel: expect.any(Function),
        subscribeMessages: expect.any(Function),
        dispose: expect.any(Function),
      }));
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
