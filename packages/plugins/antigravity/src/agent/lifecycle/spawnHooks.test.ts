import { describe, expect, it, vi } from 'vitest';

import { resolveAntigravityDaemonSpawnPrerequisites } from './spawnHooks.js';

describe('Antigravity daemon spawn prerequisites', () => {
  it('denies explicit SDK mode when the canonical managed-dependency owner cannot ensure localharness', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false,
      errorMessage: 'Antigravity localharness is not installed.',
    }));
    const ensure = vi.fn(async () => {
      throw new Error('Antigravity localharness is not installed.');
    });

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'sdk' },
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      tools: { resolveManagedInstallable },
      services: { managedServices: { dependencies: { ensure } } },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'antigravity_localharness_unavailable',
      errorMessage: 'Antigravity localharness is not installed.',
    });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith('localharness', undefined);
  });

  it('allows explicit SDK mode after the canonical managed-dependency owner ensures localharness', async () => {
    const ensure = vi.fn(async () => ({ state: 'ready' as const }));
    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'sdk' },
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      services: { managedServices: { dependencies: { ensure } } },
    })).resolves.toEqual({ decision: 'allow' });
    expect(ensure).toHaveBeenCalledWith('localharness', undefined);
  });

  it('requires the agy executable for explicit cliPrint mode without resolving the Python wheel', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'unexpected localharness lookup',
    }));
    const runSystemTool = vi.fn(async () => ({
      ok: false as const,
      reasonCode: 'tool_unavailable' as const,
      errorMessage: 'agy was not found.',
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'cliPrint' },
          cwd: '/repo',
          env: {
            GEMINI_API_KEY: 'sdk-secret',
            HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'cliPrint',
            SAFE_TEST_ENV: 'kept',
          },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'antigravity_cli_print_unavailable',
      errorMessage: expect.stringContaining('agy was not found'),
    });

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'antigravity-cli',
      lookupNames: ['agy'],
      sourcePreference: 'system-first',
      args: ['models'],
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept' },
    }));
    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });

  it('allows explicit cliPrint mode when agy models succeeds', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'unexpected localharness lookup',
    }));
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      command: '/usr/local/bin/agy',
      args: ['models'],
      source: 'system' as const,
      exitCode: 0,
      signal: null,
      stdout: 'Gemini 3.5 Flash (Medium)\n',
      stderr: '',
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'cliPrint' },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toEqual({ decision: 'allow' });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });

  it('uses the slow-tolerant Antigravity CLI models readiness timeout for cliPrint spawn checks', async () => {
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      command: '/usr/local/bin/agy',
      args: ['models'],
      source: 'system' as const,
      exitCode: 0,
      signal: null,
      stdout: 'Gemini 3.5 Flash (Medium)\n',
      stderr: '',
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'cliPrint' },
        },
      },
    }, {
      tools: {
        runSystemTool,
        resolveManagedInstallable: async () => ({
          ok: false,
          errorMessage: 'unexpected localharness lookup',
        }),
      },
    })).resolves.toEqual({ decision: 'allow' });

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      args: ['models'],
      timeoutMs: 15_000,
    }));
  });

  it('allows auto mode with cliPrint even when the localharness sidecar is missing', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'localharness unavailable',
    }));
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      command: '/usr/local/bin/agy',
      args: ['models'],
      source: 'system' as const,
      exitCode: 0,
      signal: null,
      stdout: 'Gemini 3.5 Flash (Medium)\n',
      stderr: '',
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'auto' },
          env: { GEMINI_API_KEY: 'sdk-key', HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'auto' },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toEqual({ decision: 'allow' });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });

  it('allows auto mode through SDK when agy is unavailable without consulting the predecessor install owner', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: true as const,
      command: '/managed/localharness',
      args: [],
    }));
    const runSystemTool = vi.fn(async () => ({
      ok: false as const,
      reasonCode: 'tool_unavailable' as const,
      errorMessage: 'agy unavailable',
    }));
    const ensure = vi.fn(async () => ({ state: 'ready' as const }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'auto' },
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
      services: { managedServices: { dependencies: { ensure } } },
    })).resolves.toEqual({ decision: 'allow' });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith('localharness', undefined);
  });

  it('returns diagnostics for both branches when auto mode has neither cliPrint nor SDK prerequisites', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false as const,
      errorMessage: 'localharness unavailable',
    }));
    const runSystemTool = vi.fn(async () => ({
      ok: false as const,
      reasonCode: 'tool_unavailable' as const,
      errorMessage: 'agy unavailable',
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'auto' },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'antigravity_runtime_unavailable',
      errorMessage: expect.stringContaining('agy unavailable'),
    });
    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'auto' },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toMatchObject({
      errorMessage: expect.stringContaining('Gemini API-key or Vertex credentials'),
    });
  });

  it('uses the host semantic projection instead of reparsing a conflicting raw descriptor', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: true as const,
      command: '/managed/localharness',
      args: [],
    }));
    const runSystemTool = vi.fn(async () => {
      throw new Error('cliPrint should not be probed for a persisted sdk descriptor');
    });
    const ensure = vi.fn(async () => ({ state: 'ready' as const }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'sdk' },
          env: { GEMINI_API_KEY: 'sdk-key' },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'antigravity',
            provider: {
              runtimeMode: 'cliPrint',
              providerExtra: {
                owner: 'antigravity',
                schemaId: 'antigravity.agentRuntimeDescriptorExtra',
                v: 1,
                runtimeHandle: { runtimeMode: 'cliPrint' },
              },
            },
          },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
      services: { managedServices: { dependencies: { ensure } } },
    })).resolves.toEqual({ decision: 'allow' });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledWith('localharness', undefined);
    expect(runSystemTool).not.toHaveBeenCalled();
  });

  it('does not allow auto SDK fallback from sidecar availability alone when SDK credentials are missing', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: true as const,
      command: '/managed/localharness',
      args: [],
    }));
    const runSystemTool = vi.fn(async () => ({
      ok: false as const,
      reasonCode: 'tool_unavailable' as const,
      errorMessage: 'agy unavailable',
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'auto' },
          env: {},
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'antigravity_runtime_unavailable',
      errorMessage: expect.stringContaining('Gemini API-key or Vertex credentials'),
    });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });
});
