import { describe, expect, it, vi } from 'vitest';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { createCursorAcpRuntimeExtensions } from './extensions.js';

type PermissionDecisionFixture = Readonly<{
  decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
  rationale?: string;
  answers?: Readonly<Record<string, string>>;
}>;

function createPluginContextFixture(params?: Readonly<{
  initialMetadata?: Readonly<Record<string, unknown>>;
  requestDecision?: (request: unknown) => Promise<PermissionDecisionFixture>;
  writeMetadata?: (request: Parameters<PluginContextV1['session']['writeMetadata']>[0]) => Promise<void>;
  writeStateField?: (request: Parameters<PluginContextV1['sessions']['writeStateField']>[0]) => Promise<void>;
}>) {
  const requestDecision = vi.fn(params?.requestDecision ?? (async () => ({ decision: 'approved' as const })));
  const sent: unknown[] = [];
  let metadata: Readonly<Record<string, unknown>> = Object.freeze(params?.initialMetadata ?? {});
  const metadataWrites: unknown[] = [];
  const writeMetadata = vi.fn(async (request: Parameters<PluginContextV1['session']['writeMetadata']>[0]) => {
    metadataWrites.push(request);
    if (params?.writeMetadata) {
      await params.writeMetadata(request);
      return;
    }
    if (request.kind === 'set') {
      metadata = request.metadata;
      return;
    }
    metadata = request.handler(metadata);
  });
  const writeStateField = vi.fn(async (request: Parameters<PluginContextV1['sessions']['writeStateField']>[0]) => {
    if (params?.writeStateField) {
      await params.writeStateField(request);
      return;
    }
    if (request.fieldId === 'runtime.workState') {
      metadata = {
        ...metadata,
        sessionWorkStateV1: request.value,
      };
    }
  });
  const debug = vi.fn();
  const ctx = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug,
    },
    session: {
      send: vi.fn(async (request: unknown) => {
        sent.push(request);
        return { ok: true };
      }),
      permissions: {
        requestDecision,
        getMode: vi.fn(() => 'default'),
      },
      writeMetadata,
      writeStateField,
    },
    sessions: {
      list: vi.fn(async () => [
        {
          sessionId: HANDLER_CONTEXT.sessionId,
          metadata,
        },
      ]),
      writeStateField,
    },
  } as unknown as PluginContextV1; // Boundary fixture: only the SDK services used by Cursor extensions are needed.
  return {
    ctx,
    requestDecision,
    sent,
    debug,
    writeMetadata,
    writeStateField,
    metadataWrites,
    readMetadata: () => metadata,
  };
}

const HANDLER_CONTEXT = {
  method: 'cursor/update_todos',
  sessionId: 'happier-session-1',
  backendId: 'cursor',
  agentName: 'Cursor',
  signal: new AbortController().signal,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function handlerContext(method: string, requestId: string) {
  return {
    ...HANDLER_CONTEXT,
    method,
    requestId,
  };
}

describe('createCursorAcpRuntimeExtensions', () => {
  it('maps ask_question through the real host permission route before returning answers', async () => {
    const { ctx, requestDecision } = createPluginContextFixture({
      requestDecision: async (request) => {
        if (
          isRecord(request)
          && typeof request.toolCallId === 'string'
          && request.toolName === 'AskUserQuestion'
        ) {
          return {
            decision: 'approved',
            answers: {
              choice: 'Beta',
              'Free form': 'typed answer',
            },
          };
        }
        return { decision: 'approved_for_session' };
      },
    });
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/ask_question']?.({
      title: 'Need input',
      questions: [
        {
          id: 'choice',
          prompt: 'Pick one',
          options: [{ label: 'Alpha' }, { label: 'Beta' }],
        },
        {
          id: 'free',
          prompt: 'Free form',
          allowMultiple: true,
          options: [],
        },
      ],
    }, handlerContext('cursor/ask_question', 'ask-rpc-1'))).resolves.toEqual({
      answers: {
        choice: 'Beta',
        free: 'typed answer',
      },
    });

    expect(requestDecision).toHaveBeenCalledWith({
      provider: 'cursor',
      requestId: 'ask-rpc-1',
      toolCallId: 'cursor:cursor/ask_question:AskUserQuestion:ask-rpc-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            id: 'choice',
            header: 'Need input',
            question: 'Pick one',
            multiSelect: false,
            options: [
              { label: 'Alpha', description: 'Alpha' },
              { label: 'Beta', description: 'Beta' },
            ],
          },
          {
            id: 'free',
            header: 'Need input',
            question: 'Free form',
            multiSelect: true,
            options: [{ label: 'OK', description: 'Continue' }],
          },
        ],
      },
    }, {
      signal: HANDLER_CONTEXT.signal,
    });
  });

  it('maps update_todos request and notification to canonical work-state telemetry with merge state', async () => {
    const { ctx, requestDecision, writeMetadata, writeStateField, readMetadata } = createPluginContextFixture();
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/update_todos']?.({
      todos: [{ id: 'a', content: 'ship cursor', status: 'in_progress' }],
    }, handlerContext('cursor/update_todos', 'todos-rpc-1'))).resolves.toEqual({});
    await extensions.notifications?.['cursor/update_todos']?.({
      merge: true,
      todos: [
        { id: 'a', content: 'ship cursor', status: 'completed' },
        { id: 'b', content: 'verify cursor', status: 'pending' },
      ],
    }, {
      ...HANDLER_CONTEXT,
      method: 'cursor/update_todos',
    });

    expect(requestDecision).not.toHaveBeenCalled();
    expect(writeMetadata).not.toHaveBeenCalled();
    expect(writeStateField).toHaveBeenCalledTimes(2);
    expect(writeStateField).toHaveBeenLastCalledWith(expect.objectContaining({
      fieldId: 'runtime.workState',
      reason: 'cursor_todos_updated',
    }));
    expect(readMetadata()).toMatchObject({
      sessionWorkStateV1: {
        v: 1,
        backendId: 'cursor',
        agentId: 'cursor',
        items: [
          {
            id: 'todo:cursor:b',
            kind: 'todo',
            origin: 'vendor',
            status: 'pending',
            title: 'verify cursor',
            backendId: 'cursor',
            agentId: 'cursor',
            vendorRef: 'b',
            order: 1,
          },
          {
            id: 'todo:cursor:a',
            kind: 'todo',
            origin: 'vendor',
            status: 'complete',
            title: 'ship cursor',
            backendId: 'cursor',
            agentId: 'cursor',
            vendorRef: 'a',
            order: 0,
          },
        ],
        primaryItemId: 'todo:cursor:b',
      },
    });
  });

  it('clears stale Cursor-owned work-state when update_todos sends an empty replacement snapshot', async () => {
    const { ctx, requestDecision, readMetadata } = createPluginContextFixture({
      initialMetadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'cursor',
          updatedAt: 50,
          items: [
            {
              id: 'todo:cursor:stale',
              kind: 'todo',
              origin: 'vendor',
              backendId: 'cursor',
              status: 'active',
              title: 'Stale Cursor todo',
              updatedAt: 50,
            },
            {
              id: 'todo:claude:keep',
              kind: 'todo',
              origin: 'vendor',
              backendId: 'claude',
              status: 'pending',
              title: 'Keep Claude todo',
              updatedAt: 50,
            },
          ],
        },
      },
    });
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/update_todos']?.({
      todos: [{ id: 'a', content: 'ship cursor', status: 'pending' }],
    }, handlerContext('cursor/update_todos', 'todos-rpc-2'))).resolves.toEqual({});
    await expect(extensions.requests?.['cursor/update_todos']?.({
      todos: [],
    }, handlerContext('cursor/update_todos', 'todos-rpc-3'))).resolves.toEqual({});

    expect(requestDecision).not.toHaveBeenCalled();
    expect(readMetadata()).toMatchObject({
      sessionWorkStateV1: {
        items: [
          {
            id: 'todo:claude:keep',
            kind: 'todo',
            origin: 'vendor',
            backendId: 'claude',
            status: 'pending',
            title: 'Keep Claude todo',
          },
        ],
      },
    });
    expect(JSON.stringify(readMetadata())).not.toContain('todo:cursor:');
  });

  it('normalizes source-real Cursor todo statuses before writing work-state', async () => {
    const { ctx, readMetadata } = createPluginContextFixture();
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/update_todos']?.({
      todos: [
        { id: 'active', content: 'active Cursor todo', status: 'inProgress' },
        { id: 'fallback', content: 'fallback Cursor todo', status: 'waiting_on_vendor' },
      ],
    }, handlerContext('cursor/update_todos', 'todos-rpc-4'))).resolves.toEqual({});

    expect(readMetadata()).toMatchObject({
      sessionWorkStateV1: {
        items: [
          {
            id: 'todo:cursor:active',
            status: 'active',
            title: 'active Cursor todo',
          },
          {
            id: 'todo:cursor:fallback',
            status: 'pending',
            title: 'fallback Cursor todo',
          },
        ],
        primaryItemId: 'todo:cursor:active',
      },
    });
  });

  it('ignores malformed update_todos payloads without clearing current work-state', async () => {
    const { ctx, debug, readMetadata, writeMetadata, writeStateField } = createPluginContextFixture();
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/update_todos']?.({
      todos: [{ id: 'a', content: 'ship cursor', status: 'pending' }],
    }, handlerContext('cursor/update_todos', 'todos-rpc-5'))).resolves.toEqual({});
    await expect(extensions.requests?.['cursor/update_todos']?.({
      reason: 'bad provider payload',
    }, handlerContext('cursor/update_todos', 'todos-rpc-6'))).resolves.toEqual({});

    expect(writeMetadata).not.toHaveBeenCalled();
    expect(writeStateField).toHaveBeenCalledTimes(1);
    expect(readMetadata()).toMatchObject({
      sessionWorkStateV1: {
        items: [
          {
            id: 'todo:cursor:a',
            status: 'pending',
            title: 'ship cursor',
          },
        ],
      },
    });
    expect(debug).toHaveBeenCalledWith('Cursor ACP update_todos ignored malformed payload', {
      keys: ['reason'],
    });
  });

  it('maps create_plan to work-state todo projection plus ExitPlanMode approval surface', async () => {
    const { ctx, requestDecision, writeMetadata, writeStateField, readMetadata } = createPluginContextFixture();
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/create_plan']?.({
      title: 'Implement Cursor',
      name: 'Cursor Runtime',
      overview: 'Shared ACP runtime composition',
      isProject: true,
      phases: [
        {
          name: 'Runtime',
          todos: [{ id: 'runtime', content: 'compose ACP runtime', status: 'pending' }],
        },
      ],
      text: 'Proceed with the Cursor plan?',
    }, handlerContext('cursor/create_plan', 'plan-rpc-1'))).resolves.toEqual({ accepted: true });

    expect(writeMetadata).not.toHaveBeenCalled();
    expect(writeStateField).toHaveBeenCalledTimes(1);
    expect(readMetadata()).toMatchObject({
      sessionWorkStateV1: {
        backendId: 'cursor',
        items: [
          {
            id: 'todo:cursor:runtime',
            title: 'Runtime: compose ACP runtime',
            status: 'pending',
          },
        ],
      },
    });
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(requestDecision).toHaveBeenNthCalledWith(1, {
      provider: 'cursor',
      requestId: 'plan-rpc-1',
      toolCallId: 'cursor:cursor/create_plan:ExitPlanMode:plan-rpc-1',
      toolName: 'ExitPlanMode',
      input: {
        title: 'Implement Cursor',
        name: 'Cursor Runtime',
        overview: 'Shared ACP runtime composition',
        isProject: true,
        plan: 'Proceed with the Cursor plan?',
      },
    }, {
      signal: HANDLER_CONTEXT.signal,
    });
  });

  it('keeps create_plan approval available when optional todo metadata projection fails', async () => {
    const { ctx, requestDecision } = createPluginContextFixture({
      writeStateField: async () => {
        throw new Error('todo metadata unavailable');
      },
    });
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/create_plan']?.({
      title: 'Implement Cursor',
      phases: [
        {
          name: 'Runtime',
          todos: [{ id: 'runtime', content: 'compose ACP runtime', status: 'pending' }],
        },
      ],
      plan: '# Plan\n\nProceed with the Cursor plan?',
    }, handlerContext('cursor/create_plan', 'plan-rpc-2'))).resolves.toEqual({ accepted: true });

    expect(requestDecision).toHaveBeenNthCalledWith(1, {
      provider: 'cursor',
      requestId: 'plan-rpc-2',
      toolCallId: 'cursor:cursor/create_plan:ExitPlanMode:plan-rpc-2',
      toolName: 'ExitPlanMode',
      input: {
        title: 'Implement Cursor',
        plan: '# Plan\n\nProceed with the Cursor plan?',
      },
    }, {
      signal: HANDLER_CONTEXT.signal,
    });
  });

  it('keeps diagnostic-only extension logs bounded to payload keys', async () => {
    const { ctx, debug } = createPluginContextFixture();
    const extensions = createCursorAcpRuntimeExtensions({ ctx });

    await expect(extensions.requests?.['cursor/task']?.({
      taskId: 'task-1',
      secretPrompt: 'do not log this prompt',
    }, {
      ...HANDLER_CONTEXT,
      method: 'cursor/task',
    })).resolves.toEqual({});
    await extensions.notifications?.['cursor/generate_image']?.({
      prompt: 'do not log this image prompt',
      seed: 123,
    }, {
      ...HANDLER_CONTEXT,
      method: 'cursor/generate_image',
    });

    expect(debug).toHaveBeenNthCalledWith(1, 'Cursor ACP task extension is diagnostic-only in V1', {
      keys: ['secretPrompt', 'taskId'],
    });
    expect(debug).toHaveBeenNthCalledWith(2, 'Cursor ACP image generation notification is diagnostic-only in V1', {
      keys: ['prompt', 'seed'],
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain('do not log');
  });
});
