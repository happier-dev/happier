import { describe, expect, it, vi } from 'vitest';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import type {
  AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agent-runtime';

import { activate, createGrokAgentRuntime } from './activate.js';

describe('Grok native activation', () => {
  it('registers a native runtime and opens exact Grok ACP stdio launch facts', async () => {
    const register = vi.fn();
    activate({ agents: { register } } as unknown as PluginApi);
    expect(register).toHaveBeenCalledWith('grok', createGrokAgentRuntime);

    const opened = Object.freeze({ dispose() {}, watch: () => ({ dispose() {} }), send: async () => ({ status: 'admitted' as const }) });
    const open = vi.fn(async () => opened);
    const request = {
      kind: 'create' as const,
      sessionId: 'host-session',
      cwd: '/workspace',
      launchEnvironment: { values: { XAI_API_KEY: ' secret ' }, unset: [] },
    };
    const runtime = createGrokAgentRuntime({} as never);
    const result = await runtime.sessions.open(request, {
      protocols: { acp: { open } },
      ui: { askQuestions: vi.fn() },
    } as unknown as AgentSessionRuntimeContext);

    expect(result).toBe(opened);
    expect(open).toHaveBeenCalledWith(request, expect.objectContaining({
      transport: {
        kind: 'stdio', executable: { kind: 'systemTool', id: 'grok-cli' },
        args: ['--no-auto-update', 'agent', 'stdio'],
      },
      definition: expect.objectContaining({
        acceptsVerifiedImageInput: true,
        toolNameInference: expect.objectContaining({
          patterns: expect.arrayContaining([
            expect.objectContaining({ name: 'read', patterns: expect.arrayContaining(['read_file']) }),
          ]),
        }),
        models: expect.objectContaining({
          projectModel: expect.any(Function), projectUpdate: expect.any(Function),
        }),
        mcp: { policy: 'pass_through' },
      }),
      extensions: expect.objectContaining({
        requests: expect.objectContaining({ 'x.ai/ask_user_question': expect.any(Function) }),
        notifications: expect.objectContaining({
          'x.ai/session/prompt_complete': expect.any(Function),
          '_x.ai/session/prompt_complete': expect.any(Function),
        }),
      }),
    }));
  });

  it('rejects an xAI question that is not bound to the active host turn', async () => {
    const askQuestions = vi.fn(async () => ({ status: 'cancelled' as const }));
    const open = vi.fn(async (_request, options) => {
      const handler = options.extensions.requests['x.ai/ask_user_question'];
      await expect(handler({
        sessionId: 'provider-session',
        toolCallId: 'tool-1',
        mode: 'default',
        questions: [{ question: 'Continue?', options: [] }],
      }, {
        method: 'x.ai/ask_user_question',
        signal: new AbortController().signal,
        providerSessionId: 'provider-session',
      })).rejects.toThrow('active ACP turn');
      return Object.freeze({ dispose() {}, watch: () => ({ dispose() {} }), send: async () => ({ status: 'admitted' as const }) });
    });
    const runtime = createGrokAgentRuntime({} as never);

    await runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session',
      cwd: '/workspace',
      launchEnvironment: { values: {}, unset: [] },
    }, {
      protocols: { acp: { open } },
      ui: { askQuestions },
    } as unknown as AgentSessionRuntimeContext);

    expect(askQuestions).not.toHaveBeenCalled();
  });
});
