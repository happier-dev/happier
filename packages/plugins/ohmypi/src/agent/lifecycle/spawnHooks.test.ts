import { describe, expect, it, vi } from 'vitest';

import { resolveOhMyPiDaemonSpawnPrerequisites } from './spawnHooks.js';

describe('OhMyPi daemon spawn prerequisites', () => {
  it('leaves account-dependent model readiness to the prepared native runtime', async () => {
    const runSystemTool = vi.fn(async () => ({ ok: true, exitCode: 0, stdout: 'No models available.', stderr: '' }));
    await expect(resolveOhMyPiDaemonSpawnPrerequisites(
      { cwd: '/repo', runtimeSelection: { env: {} } },
      { tools: { runSystemTool } },
    )).resolves.toEqual({ decision: 'allow' });
    // Account credentials are prepared by the runtime, after this hook.
    expect(runSystemTool).not.toHaveBeenCalled();
  });

  it('does not require a daemon tool context before qualified account preparation', async () => {
    await expect(resolveOhMyPiDaemonSpawnPrerequisites({ cwd: 'C:\\workspace' }))
      .resolves.toEqual({ decision: 'allow' });
  });
});
