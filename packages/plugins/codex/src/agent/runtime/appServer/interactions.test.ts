import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import type { DisposableCodexAppServerClient } from './client.js';
import { registerCodexAppServerInteractionHandlers } from './interactions.js';
import { createCodexAppServerRealtimeConversation } from './realtime.js';

type PluginInvocationUi = AgentRuntimeContext['ui'];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createFixture() {
  const requestHandlers = new Map<
    string,
    (params: unknown, message: Readonly<{ id?: unknown }>) => unknown | Promise<unknown>
  >();
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  const request = vi.fn(async (method: string) => {
    if (method === 'experimentalFeature/list') {
      return {
        data: [{ name: 'realtime_conversation', enabled: true }],
        nextCursor: null,
      };
    }
    return {};
  });
  const client: DisposableCodexAppServerClient = {
    launchFeatures: {
      realtimeConversationAdvertised: true,
      codexCliVersion: '0.145.0',
      realtimeConversationVersionSupported: true,
    },
    request,
    notify: vi.fn(async () => {}),
    registerRequestHandler(method, handler) {
      requestHandlers.set(method, handler);
      return () => requestHandlers.delete(method);
    },
    registerNotificationHandler(method, handler) {
      const handlers = notificationHandlers.get(method) ?? new Set();
      handlers.add(handler);
      notificationHandlers.set(method, handlers);
      return () => handlers.delete(handler);
    },
    onExit: () => () => {},
    dispose: vi.fn(async () => {}),
  };
  return {
    client,
    request,
    invoke(method: string, params: unknown, id: string | number = 'rpc-1') {
      const handler = requestHandlers.get(method);
      if (!handler) throw new Error(`Missing request handler: ${method}`);
      return Promise.resolve(handler(params, { id }));
    },
    publish(method: string, params: unknown) {
      for (const handler of notificationHandlers.get(method) ?? []) handler(params);
    },
    registeredMethods() {
      return [...requestHandlers.keys()].sort();
    },
  };
}

function createUi(overrides?: Partial<PluginInvocationUi>): PluginInvocationUi {
  return {
    requestApproval: vi.fn(async () => ({ status: 'approved', persistence: 'once' as const })),
    askQuestions: vi.fn(async () => ({ status: 'cancelled' as const })),
    confirm: vi.fn(async () => false),
    notify: vi.fn(async () => {}),
    status: { set: vi.fn(async () => {}) },
    widget: { set: vi.fn(async () => {}) },
    title: { set: vi.fn(async () => {}) },
    composer: { replace: vi.fn(async () => {}) },
    ...overrides,
  };
}

describe('Codex app-server canonical interaction bridge', () => {
  it('registers all current app-server interaction methods and maps approvals without a provider-owned store', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn()
      .mockResolvedValueOnce({ status: 'approved', persistence: 'session' })
      .mockResolvedValueOnce({ status: 'denied' })
      .mockResolvedValueOnce({ status: 'approved', persistence: 'once' });
    const ui = createUi({ requestApproval });
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui,
      getThreadId: () => 'thread-1',
    });

    expect(fixture.registeredMethods()).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
    ]);
    await expect(fixture.invoke('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'command-1',
      startedAtMs: 1,
      environmentId: null,
      reason: 'Network access is required.',
      command: 'git fetch origin',
      cwd: '/workspace',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    })).resolves.toEqual({ decision: 'acceptForSession' });
    await expect(fixture.invoke('item/fileChange/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'file-1',
      startedAtMs: 2,
      reason: 'Write outside the workspace.',
      grantRoot: '/tmp/export',
    })).resolves.toEqual({ decision: 'decline' });
    const permissions = {
      fileSystem: { read: ['/workspace'], write: ['/tmp/export'] },
      network: { enabled: true },
    };
    await expect(fixture.invoke('item/permissions/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'permissions-1',
      startedAtMs: 3,
      environmentId: null,
      cwd: '/workspace',
      reason: 'Additional access is required.',
      permissions,
    })).resolves.toEqual({
      permissions,
      scope: 'turn',
    });
    expect(requestApproval).toHaveBeenCalledTimes(3);

    await expect(fixture.invoke('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'amendment-only-command',
      startedAtMs: 4,
      environmentId: null,
      availableDecisions: [
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'fetch'] } },
        'decline',
      ],
    })).resolves.toEqual({ decision: 'decline' });
    expect(requestApproval).toHaveBeenCalledTimes(3);
  });

  it('prompts for a session-only command decision and never emits a disallowed accept-once', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn()
      .mockResolvedValueOnce({ status: 'approved', persistence: 'once' })
      .mockResolvedValueOnce({ status: 'approved', persistence: 'session' })
      .mockResolvedValueOnce({ status: 'approved', persistence: 'session' })
      .mockResolvedValueOnce({ status: 'approved', persistence: 'once' });
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      getThreadId: () => 'thread-1',
    });
    const request = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'session-only-command',
      startedAtMs: 1,
      environmentId: null,
      command: 'git fetch origin',
      availableDecisions: ['acceptForSession', 'decline'],
    };

    await expect(fixture.invoke(
      'item/commandExecution/requestApproval',
      request,
      'session-only-once',
    )).resolves.toEqual({ decision: 'decline' });
    await expect(fixture.invoke(
      'item/commandExecution/requestApproval',
      request,
      'session-only-session',
    )).resolves.toEqual({ decision: 'acceptForSession' });
    const acceptOnlyRequest = {
      ...request,
      itemId: 'accept-only-command',
      availableDecisions: ['accept', 'decline'],
    };
    await expect(fixture.invoke(
      'item/commandExecution/requestApproval',
      acceptOnlyRequest,
      'accept-only-session',
    )).resolves.toEqual({ decision: 'decline' });
    await expect(fixture.invoke(
      'item/commandExecution/requestApproval',
      acceptOnlyRequest,
      'accept-only-once',
    )).resolves.toEqual({ decision: 'accept' });
    expect(requestApproval).toHaveBeenCalledTimes(4);
  });

  it('uses canonical structured questions for request-user-input and MCP form elicitation', async () => {
    const fixture = createFixture();
    const askQuestions = vi.fn()
      .mockResolvedValueOnce({
        status: 'answered',
        answers: {
          environment: { type: 'single', answer: { type: 'choice', choiceId: 'staging' } },
          note: { type: 'text', value: 'Deploy after tests' },
        },
      })
      .mockResolvedValueOnce({
        status: 'answered',
        answers: {
          region: { type: 'single', answer: { type: 'choice', choiceId: 'eu' } },
          retries: { type: 'text', value: '3' },
        },
      });
    const requestApproval = vi.fn(async () => ({
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    const ui = createUi({ askQuestions, requestApproval });
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui,
      getThreadId: () => 'thread-1',
    });

    await expect(fixture.invoke('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'question-1',
      autoResolutionMs: null,
      questions: [
        {
          id: 'environment',
          header: 'Environment',
          question: 'Where should this deploy?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'staging', description: 'Shared staging' },
            { label: 'production', description: 'Live users' },
          ],
        },
        {
          id: 'note',
          header: 'Note',
          question: 'Any release note?',
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
    })).resolves.toEqual({
      answers: {
        environment: { answers: ['staging'] },
        note: { answers: ['Deploy after tests'] },
      },
    });
    await expect(fixture.invoke('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'approval-question-1',
      autoResolutionMs: null,
      questions: [{
        id: 'mcp_tool_call_approval_1',
        header: 'Approval',
        question: 'Allow this MCP tool call?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Approve Once', description: 'Run once' },
          { label: 'Deny', description: 'Do not run' },
        ],
      }],
    })).resolves.toEqual({
      answers: {
        mcp_tool_call_approval_1: { answers: ['Approve Once'] },
      },
    });

    await expect(fixture.invoke('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'deployment',
      mode: 'form',
      _meta: null,
      message: 'Configure deployment',
      requestedSchema: {
        type: 'object',
        properties: {
          region: {
            type: 'string',
            title: 'Region',
            enum: ['eu', 'us'],
          },
          retries: {
            type: 'integer',
            title: 'Retries',
          },
        },
        required: ['region'],
      },
    })).resolves.toEqual({
      action: 'accept',
      content: { region: 'eu', retries: 3 },
      _meta: null,
    });
    await expect(fixture.invoke('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'deployment',
      mode: 'url',
      _meta: null,
      message: 'Open deployment authorization',
      url: 'https://example.invalid/authorize',
      elicitationId: 'elicitation-1',
    })).resolves.toEqual({
      action: 'accept',
      content: null,
      _meta: null,
    });
    expect(askQuestions).toHaveBeenCalledTimes(2);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('fails foreign-thread requests closed before reaching canonical UI custody', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn(async () => ({ status: 'approved', persistence: 'once' as const }));
    const ui = createUi({ requestApproval });
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui,
      getThreadId: () => 'thread-1',
    });

    await expect(fixture.invoke('item/commandExecution/requestApproval', {
      threadId: 'foreign-thread',
      turnId: 'turn-1',
      itemId: 'command-1',
      startedAtMs: 1,
      environmentId: null,
    })).resolves.toEqual({ decision: 'decline' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('keeps a canonical pending approval reachable after the Voice attachment ends', async () => {
    const fixture = createFixture();
    const decision = deferred<Awaited<ReturnType<PluginInvocationUi['requestApproval']>>>();
    const requestApproval = vi.fn(async () => await decision.promise);
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      getThreadId: () => 'thread-1',
    });
    const conversation = createCodexAppServerRealtimeConversation({
      getClient: async () => fixture.client,
      getThreadId: () => 'thread-1',
      isDisposed: () => false,
    });
    const starting = conversation.start({
      transport: { kind: 'webrtc', offerSdp: 'offer' },
    });
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledWith(
      'thread/realtime/start',
      expect.any(Object),
    ));
    fixture.publish('thread/realtime/started', {
      threadId: 'thread-1',
      realtimeSessionId: null,
      version: 'v3',
    });
    fixture.publish('thread/realtime/sdp', {
      threadId: 'thread-1',
      sdp: 'answer',
    });
    const started = await starting;
    expect(started.status).toBe('started');
    if (started.status !== 'started') throw new Error('Expected realtime to start.');

    const pendingApproval = fixture.invoke('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'command-1',
      startedAtMs: 1,
      environmentId: null,
      command: 'git fetch origin',
    });
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(1));
    await expect(started.handle.stop()).resolves.toEqual({ status: 'stopped' });
    await expect(Promise.race([
      pendingApproval.then(() => 'settled'),
      Promise.resolve('pending'),
    ])).resolves.toBe('pending');

    decision.resolve({ status: 'approved', persistence: 'once' });
    await expect(pendingApproval).resolves.toEqual({ decision: 'accept' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });
});
