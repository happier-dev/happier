import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('activate', () => {
  it('opens Cursor through the native ACP composer and host-owned interaction/work-state services', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });

    expect(activation.registrations()).toContainEqual({ family: 'agents', localId: 'cursor' });
    const factory = activation.registration('agents', 'cursor')?.factory;
    expect(factory).toEqual(expect.any(Function));
    if (!factory) throw new Error('Expected Cursor Agent factory');
    const runtime = await factory({
      plugin: { id: 'happier.agent.cursor', version: '0.0.0' },
      agent: { id: 'cursor' },
      signal: new AbortController().signal,
    });
    const composedSession: AgentSessionRuntime = {
      send: vi.fn(async () => ({ status: 'admitted' as const })),
      watch: () => ({ dispose: () => undefined }),
      dispose: vi.fn(),
    };
    const open = vi.fn(async (
      _request: AgentSessionOpenRequest,
      _options: AgentAcpRuntimeOptions,
    ) => composedSession);
    const askQuestions = vi.fn(async () => ({
      status: 'answered' as const,
      answers: {
        choice: { type: 'single' as const, answer: { type: 'choice' as const, choiceId: 'beta-id' } },
      },
    }));
    const confirm = vi.fn(async () => true);
    const publish = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 'work-state-1',
      sourceSequence: 1,
    }));
    const publisher = vi.fn(() => ({ publish }));
    const request: AgentSessionOpenRequest = {
      kind: 'resume',
      sessionId: 'session-cursor',
      providerSessionId: 'cursor-provider-session',
      cwd: '/workspace',
      launchEnvironment: {
        values: {
          CURSOR_API_KEY: 'host-authorized-secret',
          HAPPIER_CURSOR_API_ENDPOINT: 'https://legacy-launch-env.example.test',
        },
        unset: [],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 10 },
        model: { value: 'composer-2.5', updatedAtMs: 11 },
        permissionIntent: { value: 'safe-yolo', updatedAtMs: 12 },
        options: {},
      },
    };
    const context = {
      protocols: { acp: { open } },
      session: { id: request.sessionId },
      ui: { askQuestions, confirm },
      workState: { publisher },
      services: {
        logger: { debug: vi.fn() },
        settings: {
          get: vi.fn(async (id: string) => (
            id === 'cursorApiEndpoint'
              ? 'https://cursor.example.test'
              : null
          )),
        },
        sessions: {
          current: { media: { registerSourceRoot: vi.fn() } },
          subagents: { observe: vi.fn() },
        },
      },
    } as unknown as AgentSessionRuntimeContext;

    const session = await runtime.sessions.open(request, context);

    const [composedRequest, options] = open.mock.calls[0] ?? [];
    expect(composedRequest).toBe(request);
    expect(options).toMatchObject({
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'cursor-agent' },
        args: [
          '-e',
          'https://cursor.example.test',
          '--force',
          '--sandbox',
          'enabled',
          'acp',
        ],
      },
      definition: {
        auth: { methodId: 'cursor_login' },
        parameterizedModelPicker: true,
        modelConfigOptionId: 'model',
        toolNameResolver: expect.any(Function),
        sanitizeToolUpdateContent: expect.any(Function),
        mcp: { policy: 'pass_through' },
      },
      extensions: {
        requests: expect.objectContaining({
          'cursor/ask_question': expect.any(Function),
          'cursor/create_plan': expect.any(Function),
          'cursor/update_todos': expect.any(Function),
        }),
      },
    });

    const extensionContext = {
      method: 'cursor/ask_question',
      requestId: 'ask-rpc-1',
      signal: new AbortController().signal,
    };
    await expect(options?.extensions?.requests?.['cursor/ask_question']?.({
      questions: [{
        id: 'choice',
        prompt: 'Pick one',
        options: [{ id: 'alpha-id', label: 'Alpha' }, { id: 'beta-id', label: 'Beta' }],
      }],
    }, extensionContext)).resolves.toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'choice', selectedOptionIds: ['beta-id'] }],
      },
    });
    expect(askQuestions).toHaveBeenCalledWith([{
      id: 'choice',
      prompt: 'Pick one',
      type: 'single',
      choices: [
        { id: 'alpha-id', label: 'Alpha', description: 'Alpha' },
        { id: 'beta-id', label: 'Beta', description: 'Beta' },
      ],
    }], { title: 'Question' });

    await expect(options?.extensions?.requests?.['cursor/create_plan']?.({
      name: 'Native migration',
      plan: '# Plan',
      todos: [{ id: 'migrate', content: 'Migrate Cursor', status: 'in_progress' }],
    }, { ...extensionContext, method: 'cursor/create_plan' })).resolves.toEqual({
      outcome: { outcome: 'accepted' },
    });
    expect(publisher).toHaveBeenCalledWith('todos');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      sourceSequence: 1,
      primaryLocalId: 'todo:cursor:migrate',
      items: [expect.objectContaining({
        localId: 'todo:cursor:migrate',
        providerRef: 'migrate',
        status: 'active',
        title: 'Migrate Cursor',
      })],
    }), { signal: extensionContext.signal });
    expect(confirm).toHaveBeenCalledWith('# Plan', { title: 'Native migration' });

    expect(session).not.toBe(composedSession);
    await activation.dispose();
  });
});
