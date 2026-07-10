import { describe, expect, it, vi } from 'vitest';

import { resolveKimiDaemonSpawnPrerequisites } from './spawnHooks.js';

type RunSystemToolResult =
  | Readonly<{
    ok: true;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>
  | Readonly<{
    ok: false;
    reasonCode?: string;
    errorMessage: string;
    stdout?: string;
    stderr?: string;
  }>;

function createHookContext(result: RunSystemToolResult) {
  const runSystemTool = vi.fn(async () => result);
  return {
    context: { tools: { runSystemTool } },
    runSystemTool,
  };
}

describe('Kimi daemon spawn prerequisites', () => {
  it('denies daemon spawn before shell creation when the installed CLI does not support the ACP launch contract', async () => {
    const fixture = createHookContext({
      ok: true,
      exitCode: 1,
      stdout: '',
      stderr: 'error: too many arguments. Expected 0 arguments but got 1.\n',
    });

    await expect(resolveKimiDaemonSpawnPrerequisites({
      payload: {
        cwd: '/repo',
      },
    }, fixture.context)).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'kimi_acp_unavailable',
      errorMessage: expect.stringContaining('ACP-compatible Kimi CLI'),
    });

    expect(fixture.runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'kimi',
      lookupNames: ['kimi'],
      args: ['--work-dir', '/repo', 'acp'],
      cwd: '/repo',
    }));
  });

  it('allows daemon spawn when the CLI accepts the required ACP launch argv and waits for protocol input', async () => {
    const fixture = createHookContext({
      ok: false,
      reasonCode: 'timeout',
      errorMessage: 'Tool "kimi" timed out before daemon spawn prerequisites completed.',
      stdout: '',
      stderr: '',
    });

    await expect(resolveKimiDaemonSpawnPrerequisites({
      payload: {
        cwd: '/repo',
      },
    }, fixture.context)).resolves.toEqual({ allowed: true });
  });

  it('passes runtime-selection env to the ACP compatibility preflight', async () => {
    const fixture = createHookContext({
      ok: false,
      reasonCode: 'timeout',
      errorMessage: 'Tool "kimi" timed out before daemon spawn prerequisites completed.',
      stdout: '',
      stderr: '',
    });

    await expect(resolveKimiDaemonSpawnPrerequisites({
      payload: {
        cwd: '/repo',
        runtimeSelection: {
          env: {
            HAPPIER_KIMI_ACP_SELECTOR: 'poll',
            EMPTY_VALUE: '',
            NON_STRING_VALUE: 123,
          },
        },
      },
    }, fixture.context)).resolves.toEqual({ allowed: true });

    expect(fixture.runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        HAPPIER_KIMI_ACP_SELECTOR: 'poll',
        CI: '1',
      },
    }));
  });
});
