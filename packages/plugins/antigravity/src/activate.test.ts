import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { activate } from './activate.js';

describe('Antigravity plugin activation', () => {
  it('registers the canonical Antigravity backend engine through the public plugin API', async () => {
    const registerAgentRuntime = vi.fn();
    const registerHook = vi.fn();

    activate({ registerAgentRuntime, registerHook });

    expect(registerAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'antigravity',
      create: expect.any(Function),
    }));
    expect(registerHook).toHaveBeenCalledWith(expect.objectContaining({
      hookId: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      filters: { agentId: 'antigravity' },
      executionKind: 'decide',
      handler: expect.any(Function),
    }));

    const registration = registerAgentRuntime.mock.calls[0]?.[0];
    const engine = await registration.create({
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContextV1);

    expect(engine.runtimeCore).toEqual(expect.objectContaining({
      createSessionRuntime: expect.any(Function),
      createExecutionRunBackend: expect.any(Function),
    }));
    expect(engine.terminalRuntimeSurface).toEqual(expect.objectContaining({
      launch: expect.any(Function),
    }));
  });

  it('registers the SDK spawn prerequisite hook handler', async () => {
    const registerAgentRuntime = vi.fn();
    const registerHook = vi.fn();

    activate({ registerAgentRuntime, registerHook });

    const registration = registerHook.mock.calls[0]?.[0];
    const result = await registration.handler({
      payload: {
        runtimeSelection: {
          providerRuntimeSelection: { antigravityRuntimeMode: 'sdk' },
          env: { GEMINI_API_KEY: 'sdk-key' },
        },
      },
    }, {
      tools: {
        resolveManagedInstallable: async () => ({
          ok: false,
          errorMessage: 'missing localharness',
        }),
      },
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: 'antigravity_localharness_unavailable',
      errorMessage: 'missing localharness',
    });
  });

  it('passes direct activation-hook payloads through to the spawn prerequisite owner', async () => {
    const registerAgentRuntime = vi.fn();
    const registerHook = vi.fn();
    const runSystemTool = vi.fn(async () => ({
      ok: true as const,
      command: '/usr/local/bin/agy',
      args: ['models'],
      exitCode: 0,
      signal: null,
      stdout: 'Gemini 3.5 Flash (Medium)\n',
      stderr: '',
    }));

    activate({ registerAgentRuntime, registerHook });

    const registration = registerHook.mock.calls[0]?.[0];
    const result = await registration.handler({
      runtimeSelection: {
        providerRuntimeSelection: { antigravityRuntimeMode: 'cliPrint' },
        cwd: '/repo',
        env: { SAFE_TEST_ENV: 'kept' },
      },
    }, {
      tools: {
        runSystemTool,
        resolveManagedInstallable: async () => ({
          ok: false,
          errorMessage: 'localharness unavailable',
        }),
      },
    });

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept' },
    }));
    expect(result).toEqual({ allowed: true });
  });
});
