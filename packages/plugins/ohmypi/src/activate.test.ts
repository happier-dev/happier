import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

describe('OhMyPi plugin activation', () => {
  it('registers the backend engine and provider-owned spawn prerequisite hook', async () => {
    const registerAgentRuntime = vi.fn();
    const registerHook = vi.fn();

    activate({ registerAgentRuntime, registerHook });

    expect(registerAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'ohMyPi',
      create: expect.any(Function),
    }));
    expect(registerHook).toHaveBeenCalledWith(expect.objectContaining({
      hookId: 'agent.resolvePrerequisites',
      category: 'decision',
      scope: 'agent',
      filters: { agentId: 'ohMyPi' },
      executionKind: 'decide',
      handler: expect.any(Function),
    }));

    const registration = registerHook.mock.calls[0]?.[0];
    const result = await registration.handler({
      payload: {
        cwd: '/repo',
      },
    }, {
      tools: {
        runSystemTool: async () => ({
          ok: true,
          exitCode: 0,
          stdout: 'No models available. Set API keys in environment variables.\n',
          stderr: '',
        }),
      },
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: 'ohmypi_models_unavailable',
    });
  });

  it('passes direct activation-hook payloads through to the spawn prerequisite owner', async () => {
    const registerAgentRuntime = vi.fn();
    const registerHook = vi.fn();
    const runSystemTool = vi.fn(async () => ({
      ok: true,
      exitCode: 0,
      stdout: 'No models available. Set API keys in environment variables.\n',
      stderr: '',
    }));

    activate({ registerAgentRuntime, registerHook });

    const registration = registerHook.mock.calls[0]?.[0];
    const result = await registration.handler({
      cwd: '/repo',
      directory: '/repo',
    }, {
      tools: {
        runSystemTool,
      },
    });

    expect(runSystemTool).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
    }));
    expect(result).toMatchObject({
      allowed: false,
      reasonCode: 'ohmypi_models_unavailable',
    });
  });
});
