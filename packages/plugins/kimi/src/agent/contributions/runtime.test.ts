import { describe, expect, it, vi } from 'vitest';

import { KIMI_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Kimi agent runtime contribution', () => {
  it('exposes provider-owned daemon spawn prerequisites for ACP compatibility validation', async () => {
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      exitCode: 1,
      stdout: '',
      stderr: 'error: unknown option --work-dir\n',
    }));

    const result = await KIMI_AGENT_RUNTIME_CONTRIBUTION.daemonSpawnHooks?.resolveRuntimePrerequisites?.({
      cwd: '/repo',
      tools: { runSystemTool },
    });

    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'kimi_acp_unavailable',
      errorMessage: expect.stringContaining('ACP-compatible Kimi CLI'),
    });
  });
});
