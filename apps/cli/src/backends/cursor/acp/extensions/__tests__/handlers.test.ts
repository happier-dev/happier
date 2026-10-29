import { withParsedAcpExtensionHandler } from '@/agent/acp/testkit/extensionHandlerHarness';
import { describe, expect, it } from 'vitest';

import type { ClientApp } from '@agentclientprotocol/sdk';
import type {
  AcpExtensionHandlerContext,
  AcpExtensionHandlers,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';

import { buildCursorExtensionHandlers } from '../handlers';

type ExtensionCallback = (context: Readonly<{
  params: Record<string, unknown>;
  signal: AbortSignal;
}>) => unknown | Promise<unknown>;

async function invokeExtension(params: Readonly<{
  handlers: AcpExtensionHandlers;
  kind: 'request' | 'notification';
  method: string;
  payload: Record<string, unknown>;
  context: AcpExtensionHandlerContext;
}>): Promise<unknown> {
  const registration = params.handlers.find((candidate) => (
    candidate.kind === params.kind && candidate.method === params.method
  ));
  if (!registration) throw new Error(`Missing ${params.kind} handler for ${params.method}`);

  const captured: { callback: ExtensionCallback | null } = { callback: null };
  const app = {
    onRequest: (_method: string, parser: unknown, handler: unknown) => {
      captured.callback = withParsedAcpExtensionHandler(parser, handler as ExtensionCallback);
      return app;
    },
    onNotification: (_method: string, parser: unknown, handler: unknown) => {
      captured.callback = withParsedAcpExtensionHandler(parser, handler as ExtensionCallback);
      return app;
    },
  };
  // Boundary fixture captures SDK registration without mocking descriptor/domain logic.
  registration.register(app as unknown as ClientApp, () => params.context);
  if (!captured.callback) throw new Error(`Descriptor did not register ${params.method}`);
  return await captured.callback({ params: params.payload, signal: params.context.signal });
}

const context = {
  method: 'cursor/test',
  sessionId: 'session-1',
  signal: new AbortController().signal,
  agentName: 'cursor',
  turnId: 'turn-1',
  plans: {
    project: async (_snapshot: unknown) => ({ kind: 'published' as const }),
  },
} as const;

describe('Cursor extension descriptor composition', () => {
  it('registers update_todos in both source-real request and notification forms', () => {
    const handlers = buildCursorExtensionHandlers({
      permissionHandler: { async handleToolCall() { return { decision: 'approved' }; } },
    });
    expect(handlers.map(({ kind, method }) => `${kind}:${method}`)).toEqual([
      'request:cursor/ask_question',
      'request:cursor/create_plan',
      'request:cursor/update_todos',
      'notification:cursor/update_todos',
      'request:cursor/task',
      'notification:cursor/task',
      'request:cursor/generate_image',
      'notification:cursor/generate_image',
    ]);
  });

  it('acknowledges source-real request-form task and generated-image deliveries', async () => {
    const handlers = buildCursorExtensionHandlers({
      permissionHandler: { async handleToolCall() { return { decision: 'approved' }; } },
    });

    await expect(invokeExtension({
      handlers,
      kind: 'request',
      method: 'cursor/task',
      payload: {
        toolCallId: 'task-1',
        description: 'Inspect state',
        prompt: 'Sanitized prompt',
        subagentType: { custom: 'specialist' },
      },
      context,
    })).resolves.toEqual({});
    await expect(invokeExtension({
      handlers,
      kind: 'request',
      method: 'cursor/generate_image',
      payload: {
        toolCallId: 'image-1',
        description: 'Generate diagram',
        filePath: '/workspace/generated.png',
        referenceImagePaths: ['/workspace/reference.png'],
      },
      context,
    })).resolves.toEqual({});
  });

  it('invokes the same canonical plan owner through both request and notification descriptors', async () => {
    const toolCalls: Array<Readonly<{ id: string; toolName: string; input: unknown }>> = [];
    const projected: unknown[] = [];
    const permissionHandler: AcpPermissionHandler = {
      async handleToolCall(id, toolName, input) {
        toolCalls.push({ id, toolName, input });
        return { decision: 'approved' };
      },
    };
    const handlers = buildCursorExtensionHandlers({ permissionHandler });
    const planContext = {
      ...context,
      plans: { project: async (snapshot: unknown) => {
        projected.push(snapshot);
        return { kind: 'published' as const };
      } },
    };
    const payload = {
      toolCallId: 'todos-1',
      todos: [{ id: '1', content: 'Inspect state', status: 'pending' }],
    };

    await expect(invokeExtension({
      handlers,
      kind: 'notification',
      method: 'cursor/update_todos',
      payload,
      context: planContext,
    })).resolves.toBeUndefined();
    await expect(invokeExtension({
      handlers,
      kind: 'request',
      method: 'cursor/update_todos',
      payload,
      context: planContext,
    })).resolves.toEqual({});

    expect(toolCalls).toEqual([]);
    expect(projected).toHaveLength(2);
  });

  it('surfaces create-plan todos before requesting the plan decision', async () => {
    const toolCalls: Array<Readonly<{ id: string; toolName: string; input: unknown }>> = [];
    const projected: unknown[] = [];
    const handlers = buildCursorExtensionHandlers({
      permissionHandler: {
        async handleToolCall(id, toolName, input) {
          toolCalls.push({ id, toolName, input });
          return { decision: 'approved' };
        },
      },
    });

    await expect(invokeExtension({
      handlers,
      kind: 'request',
      method: 'cursor/create_plan',
      payload: {
        toolCallId: 'plan-1',
        name: 'Implement Cursor contracts',
        plan: '# Plan',
        todos: [{ id: 'todo-1', content: 'Add exact envelopes', status: 'pending' }],
      },
      context: {
        ...context,
        plans: { project: async (snapshot: unknown) => {
          projected.push(snapshot);
          return { kind: 'published' as const };
        } },
      },
    })).resolves.toEqual({ outcome: { outcome: 'accepted' } });

    expect(projected).toHaveLength(1);
    expect(toolCalls.map(({ id, toolName }) => ({ id, toolName }))).toEqual([
      { id: 'plan-1', toolName: 'ExitPlanMode' },
    ]);
  });

  it('fails create-plan handling when the canonical plan owner is unavailable', async () => {
    const toolCalls: string[] = [];
    const handlers = buildCursorExtensionHandlers({
      permissionHandler: {
        async handleToolCall(_id, toolName) {
          toolCalls.push(toolName);
          return { decision: 'approved' };
        },
      },
    });

    await expect(invokeExtension({
      handlers,
      kind: 'request',
      method: 'cursor/create_plan',
      payload: {
        toolCallId: 'plan-missing-owner',
        plan: '# Plan',
        todos: [{ id: 'todo-1', content: 'Must be visible', status: 'pending' }],
      },
      context: {
        method: 'cursor/create_plan',
        sessionId: 'session-1',
        signal: new AbortController().signal,
        agentName: 'cursor',
      },
    })).rejects.toThrow('ACP plan projection is unavailable');
    expect(toolCalls).toEqual([]);
  });
});
