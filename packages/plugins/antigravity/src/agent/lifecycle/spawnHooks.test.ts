import { describe, expect, it, vi } from 'vitest';

import { resolveAntigravityDaemonSpawnPrerequisites } from './spawnHooks.js';

describe('Antigravity daemon spawn prerequisites', () => {
  it('requires the managed localharness sidecar for explicit SDK mode', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: false,
      errorMessage: 'Antigravity localharness is not installed.',
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'sdk' },
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      tools: { resolveManagedInstallable },
    })).resolves.toMatchObject({
      allowed: false,
      reasonCode: 'antigravity_localharness_unavailable',
      errorMessage: expect.stringContaining('Antigravity localharness is not installed'),
    });

    expect(resolveManagedInstallable).toHaveBeenCalledWith(expect.objectContaining({
      installableId: 'dep.antigravity.localharness',
      sourcePreference: 'managed-first',
    }));
  });

  it('allows explicit SDK mode after resolving the managed sidecar', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: true,
      command: '/managed/localharness',
      args: [],
    }));

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'sdk' },
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      tools: { resolveManagedInstallable },
    })).resolves.toEqual({ allowed: true });
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
      allowed: false,
      reasonCode: 'antigravity_cli_print_unavailable',
      errorMessage: expect.stringContaining('agy was not found'),
    });

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'antigravity',
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
    })).resolves.toEqual({ allowed: true });

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
    })).resolves.toEqual({ allowed: true });

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
    })).resolves.toEqual({ allowed: true });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });

  it('allows auto mode through SDK when agy is unavailable but localharness is available', async () => {
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
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toEqual({ allowed: true });

    expect(resolveManagedInstallable).toHaveBeenCalledWith(expect.objectContaining({
      installableId: 'dep.antigravity.localharness',
    }));
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
      allowed: false,
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

  it('uses providerExtra runtimeHandle from persisted descriptors before provider runtime selection', async () => {
    const resolveManagedInstallable = vi.fn(async () => ({
      ok: true as const,
      command: '/managed/localharness',
      args: [],
    }));
    const runSystemTool = vi.fn(async () => {
      throw new Error('cliPrint should not be probed for a persisted sdk descriptor');
    });

    await expect(resolveAntigravityDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'cliPrint' },
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
                runtimeHandle: {
                  runtimeMode: 'sdk',
                },
              },
            },
          },
        },
      },
    }, {
      tools: { resolveManagedInstallable, runSystemTool },
    })).resolves.toEqual({ allowed: true });

    expect(resolveManagedInstallable).toHaveBeenCalledTimes(1);
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
      allowed: false,
      reasonCode: 'antigravity_runtime_unavailable',
      errorMessage: expect.stringContaining('Gemini API-key or Vertex credentials'),
    });

    expect(resolveManagedInstallable).not.toHaveBeenCalled();
  });
});
