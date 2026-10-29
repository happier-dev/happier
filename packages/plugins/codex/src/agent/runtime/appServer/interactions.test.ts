import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { DisposableCodexAppServerClient } from './client.js';
import { createCodexNativeEventFixture } from './client.test-support.js';
import { registerCodexAppServerInteractionHandlers } from './interactions.js';
import { createCodexAppServerRealtimeConversation } from './realtime.js';

type PluginInteractions = AgentSessionRuntimeContext['services']['interactions'];
type SessionMcp = NonNullable<AgentSessionRuntimeContext['services']['sessions']['current']>['mcp'];

let interactionSequence = 0;

function approvalResult(
  status: 'approved' | 'declined' | 'userCancelled' | 'unavailable',
  persistence?: 'once' | 'session',
) {
  interactionSequence += 1;
  return {
    requestId: `approval-${interactionSequence}`,
    kind: 'approval' as const,
    status,
    ...(status === 'approved' && persistence ? { persistence } : {}),
  };
}

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
  const nativeReceipts = createCodexNativeEventFixture();
  const client: DisposableCodexAppServerClient = {
    onNativeEvent: nativeReceipts.onNativeEvent,
    launchFeatures: {
      realtimeConversationAdvertised: true,
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
      nativeReceipts.publish(method, params);
      return Promise.resolve(handler(params, { id }));
    },
    publish(method: string, params: unknown) {
      nativeReceipts.publish(method, params);
      for (const handler of notificationHandlers.get(method) ?? []) handler(params);
    },
    registeredMethods() {
      return [...requestHandlers.keys()].sort();
    },
  };
}

function createUi(overrides?: Partial<PluginInteractions>): PluginInteractions {
  return {
    requestApproval: vi.fn(async () => approvalResult('approved', 'once')),
    askQuestions: vi.fn(async () => ({
      requestId: 'questions-cancelled',
      kind: 'questions' as const,
      status: 'userCancelled' as const,
    })),
    confirm: vi.fn(async () => ({
      requestId: 'confirmation-declined',
      kind: 'confirmation' as const,
      status: 'declined' as const,
    })),
    approvals: {
      request: vi.fn(async () => ({ approvalRequestId: 'approval-1' })),
      get: vi.fn(async () => null),
      list: vi.fn(async () => ({ items: [] })),
      watch: vi.fn(async () => ({ dispose() {} })),
    },
    ...overrides,
  };
}

describe('Codex app-server canonical interaction bridge', () => {
  it('maps async multi-question agent messages through shared interactions and sends one Codex reply', async () => {
    const fixture = createFixture();
    const askQuestions = vi.fn<PluginInteractions['askQuestions']>(async () => ({
      requestId: 'async-questions-1',
      kind: 'questions' as const,
      status: 'answered' as const,
      answers: {
        'async-question-0': { kind: 'singleChoice' as const, answer: { kind: 'choice' as const, choiceId: 'Production' } },
        'async-question-1': { kind: 'text' as const, value: 'Ship after tests' },
      },
    }));
    const sendUserMessage = vi.fn(async () => {});
    const handleAsyncQuestionNotification = registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ askQuestions }),
      sendUserMessage,
      getThreadId: () => 'thread-1',
    });

    handleAsyncQuestionNotification({
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'message-1',
        type: 'agentMessage',
        delivery: 'async',
        text: 'Choose an environment\n- Staging\n- Production\n\nAdd release context',
        questions: [
          { title: 'Choose an environment', options: ['Staging', 'Production'] },
          { title: 'Add release context' },
        ],
      },
    });

    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
    expect(askQuestions.mock.calls[0]?.[1]).toEqual({ signal: undefined, lifetime: 'occurrence' });
    expect(askQuestions.mock.calls[0]?.[0]).toEqual({
      kind: 'questions',
      title: 'Codex has questions',
      questions: [
        {
          id: 'async-question-0',
          prompt: 'Choose an environment',
          type: 'singleChoice',
          required: true,
          choices: [
            { id: 'Staging', label: 'Staging' },
            { id: 'Production', label: 'Production' },
          ],
          allowCustom: true,
        },
        {
          id: 'async-question-1',
          prompt: 'Add release context',
          type: 'text',
          required: true,
        },
      ],
    });
    expect(sendUserMessage).toHaveBeenCalledWith({
      idempotencyKey: expect.stringMatching(/^codex-async-question:/),
      toolCallId: 'message-1',
      text: '<send_user_message_question_reply>\n'
        + '[{"answer":"Production","question":"Choose an environment","questionItemId":"[\\"request_user_input_async\\",\\"message-1\\",0]"},{"answer":"Ship after tests","question":"Add release context","questionItemId":"[\\"request_user_input_async\\",\\"message-1\\",1]"}]\n'
        + '</send_user_message_question_reply>',
    });
  });

  it('uses shared form limits and the Codex option projection for oversized async input', async () => {
    const fixture = createFixture();
    const askQuestions = vi.fn();
    const sendUserMessage = vi.fn();
    const handleAsyncQuestionNotification = registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ askQuestions }),
      sendUserMessage,
      getThreadId: () => 'thread-1',
    });

    expect(handleAsyncQuestionNotification({
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'message-oversized',
        type: 'agentMessage',
        delivery: 'async',
        text: 'An oversized form',
        questions: Array.from({ length: 33 }, (_, index) => ({ title: `Question ${index + 1}` })),
      },
    })).toBe(false);
    expect(askQuestions).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();

    expect(handleAsyncQuestionNotification({
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'message-too-many-options',
        type: 'agentMessage',
        delivery: 'async',
        text: 'A form with too many choices',
        questions: [{
          title: 'Choose one',
          options: Array.from({ length: 65 }, (_, index) => `Option ${index + 1}`),
        }],
      },
    })).toBe(true);
    await vi.waitFor(() => expect(askQuestions).toHaveBeenCalledTimes(1));
    const request = askQuestions.mock.calls[0]?.[0];
    expect(request?.kind).toBe('questions');
    if (request?.kind !== 'questions') throw new Error('Expected a questions request');
    const question = request.questions[0];
    expect(question?.type).toBe('singleChoice');
    if (question?.type !== 'singleChoice' && question?.type !== 'multipleChoice') {
      throw new Error('Expected a choice question');
    }
    expect(question.choices).toHaveLength(32);
    expect(question.choices[0]?.label).toBe('Option 1');
    expect(question.choices[31]?.label).toBe('Option 32');
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('reports an unexpected async question service failure', async () => {
    const fixture = createFixture();
    const askQuestions = vi.fn(async () => {
      throw new Error('interaction service failed');
    });
    const sendUserMessage = vi.fn();
    const onAsyncQuestionDeliveryError = vi.fn();
    const handleAsyncQuestionNotification = registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ askQuestions }),
      sendUserMessage,
      onAsyncQuestionDeliveryError,
      getThreadId: () => 'thread-1',
    });

    expect(handleAsyncQuestionNotification({
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'message-interaction-failure',
        type: 'agentMessage',
        delivery: 'async',
        text: 'Choose one',
        questions: [{ title: 'Choose one', options: ['First', 'Second'] }],
      },
    })).toBe(true);
    await vi.waitFor(() => expect(onAsyncQuestionDeliveryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'interaction service failed' }),
    ));
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('maps current app-server approvals into canonical tool subjects', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn()
      .mockResolvedValueOnce(approvalResult('approved', 'session'))
      .mockResolvedValueOnce(approvalResult('declined'))
      .mockResolvedValueOnce(approvalResult('approved', 'once'));
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
    const patchChanges = [
      {
        path: 'src/example.ts',
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n-before\n+after\n',
      },
    ];
    fixture.publish('item/fileChange/patchUpdated', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'file-1',
      changes: patchChanges,
    });
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
    expect(requestApproval.mock.calls[0]?.[0]).toMatchObject({
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: {
          command: 'git fetch origin',
          cwd: '/workspace',
          reason: 'Network access is required.',
        },
      },
    });
    expect(requestApproval.mock.calls[0]?.[0].subject.input).not.toHaveProperty('threadId');
    expect(requestApproval.mock.calls[1]?.[0]).toMatchObject({
      subject: {
        kind: 'tool',
        name: 'Patch',
        input: {
          changes: patchChanges,
          grantRoot: '/tmp/export',
          reason: 'Write outside the workspace.',
        },
      },
    });
    expect(requestApproval.mock.calls[1]?.[0].subject.input).not.toHaveProperty('turnId');

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
      .mockResolvedValueOnce(approvalResult('approved', 'once'))
      .mockResolvedValueOnce(approvalResult('approved', 'session'))
      .mockResolvedValueOnce(approvalResult('approved', 'session'))
      .mockResolvedValueOnce(approvalResult('approved', 'once'));
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

  it('uses canonical structured questions for request-user-input and delegates MCP elicitation to the Session owner', async () => {
    const fixture = createFixture();
    const askQuestions = vi.fn()
      .mockResolvedValueOnce({
        requestId: 'questions-1',
        kind: 'questions',
        status: 'answered',
        answers: {
          environment: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'staging' } },
          note: { kind: 'text', value: 'Deploy after tests' },
        },
      });
    const requestApproval = vi.fn(async () => approvalResult('approved', 'once'));
    const elicit = vi.fn<SessionMcp['elicit']>()
      .mockResolvedValueOnce({
        status: 'accepted',
        decision: 'approved',
        content: {
          enabled: true,
          region: 'eu',
          retries: 3,
          tags: ['lint', 'test'],
        },
      })
      .mockResolvedValueOnce({
        status: 'accepted',
        decision: 'approved',
        content: { ignoredForUrlMode: true },
      })
      .mockResolvedValueOnce({ status: 'cancelled', decision: 'abort' });
    const ui = createUi({ askQuestions, requestApproval });
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui,
      mcp: { elicit },
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
    expect(askQuestions).toHaveBeenCalledTimes(1);
    expect(askQuestions.mock.calls[0]?.[0]).toEqual({
      kind: 'questions',
      title: 'Codex question',
      questions: [{
        id: 'environment',
        prompt: 'Where should this deploy?',
        type: 'singleChoice',
        required: true,
        choices: [
          { id: 'staging', label: 'staging', description: 'Shared staging' },
          { id: 'production', label: 'production', description: 'Live users' },
        ],
      }, {
        id: 'note',
        prompt: 'Any release note?',
        type: 'text',
        required: true,
      }],
    });
    expect(askQuestions.mock.calls[0]?.[1]).toEqual({ signal: expect.any(AbortSignal) });
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
          enabled: {
            type: 'boolean',
            title: 'Enabled',
          },
          region: {
            type: 'string',
            title: 'Region',
            enum: ['eu', 'us'],
          },
          retries: {
            type: 'integer',
            title: 'Retries',
          },
          tags: {
            type: 'array',
            title: 'Checks',
            items: {
              anyOf: [
                { const: 'lint', title: 'Lint' },
                { const: 'test', title: 'Tests' },
              ],
            },
          },
        },
        required: ['enabled', 'region', 'retries'],
      },
    })).resolves.toEqual({
      action: 'accept',
      content: {
        enabled: true,
        region: 'eu',
        retries: 3,
        tags: ['lint', 'test'],
      },
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
    await expect(fixture.invoke('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'deployment',
      _meta: null,
      message: 'Provide deployment input',
    })).resolves.toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
    expect(elicit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestId: 'rpc-1',
      serverName: 'deployment',
      toolName: 'elicitation',
      prompt: 'Configure deployment',
      schema: expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          enabled: expect.objectContaining({ type: 'boolean' }),
          retries: expect.objectContaining({ type: 'integer' }),
          region: expect.objectContaining({ enum: ['eu', 'us'] }),
          tags: expect.objectContaining({ type: 'array' }),
        }),
      }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(elicit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestId: 'rpc-1',
      serverName: 'deployment',
      toolName: 'elicitation',
      prompt: 'Open deployment authorization',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(elicit.mock.calls[1]?.[0]).not.toHaveProperty('schema');
    expect(elicit.mock.calls[2]?.[0]).not.toHaveProperty('schema');
    expect(askQuestions).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('fails invalid and empty MCP forms closed through the Session owner without generic approval fallback', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn(async () => approvalResult('approved', 'once'));
    const elicit = vi.fn<SessionMcp['elicit']>(async (request) => {
      const schema = request.schema as Readonly<Record<string, unknown>> | undefined;
      const properties = schema?.properties as Readonly<Record<string, unknown>> | undefined;
      if (schema === undefined) return { status: 'accepted', decision: 'approved' };
      return properties && Object.keys(properties).length === 0
        ? { status: 'declined', decision: 'denied' }
        : { status: 'failed', reason: 'mcp_elicitation_schema_invalid' };
    });
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      mcp: { elicit },
      getThreadId: () => 'thread-1',
    });

    const request = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      serverName: 'deployment',
      mode: 'form',
      _meta: null,
      message: 'Configure deployment',
    };
    await expect(fixture.invoke('mcpServer/elicitation/request', request, 'missing-form'))
      .resolves.toEqual({
        action: 'cancel',
        content: null,
        _meta: null,
      });
    await expect(fixture.invoke('mcpServer/elicitation/request', {
      ...request,
      requestedSchema: { type: 'array' },
    }, 'invalid-form')).resolves.toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
    await expect(fixture.invoke('mcpServer/elicitation/request', {
      ...request,
      requestedSchema: { type: 'object', properties: {} },
    }, 'empty-form')).resolves.toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });
    expect(elicit).toHaveBeenCalledTimes(2);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('fails foreign-thread requests closed before reaching canonical UI custody', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn(async () => approvalResult('approved', 'once'));
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
    const decision = deferred<Awaited<ReturnType<PluginInteractions['requestApproval']>>>();
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
      { timeoutMs: null },
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

    decision.resolve(approvalResult('approved', 'once'));
    await expect(pendingApproval).resolves.toEqual({ decision: 'accept' });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('never serializes a declined approval as the only positive option', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn(async () => approvalResult('declined'));
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      getThreadId: () => 'thread-1',
    });

    await expect(fixture.invoke('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'approval-only-positive',
      autoResolutionMs: null,
      questions: [{
        id: 'mcp_tool_call_approval_1',
        header: 'Approval',
        question: 'Allow this MCP tool call?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'Approve Once', description: 'Run once' }],
      }],
    })).resolves.toEqual({ answers: {} });
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('maps every non-approval settlement to an explicit negative option', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn()
      .mockResolvedValueOnce(approvalResult('declined'))
      .mockResolvedValueOnce(approvalResult('userCancelled'))
      .mockResolvedValueOnce(approvalResult('unavailable'));
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      getThreadId: () => 'thread-1',
    });
    const request = (itemId: string) => fixture.invoke('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId,
      autoResolutionMs: null,
      questions: [{
        id: 'mcp_tool_call_approval_1',
        header: 'Approval',
        question: 'Allow this MCP tool call?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Approve Once', description: 'Run once' },
          { label: 'Approve this Session', description: 'Run for the session' },
          { label: 'Deny', description: 'Do not run' },
          { label: 'Cancel', description: 'Cancel this tool call' },
        ],
      }],
    });

    await expect(request('declined-1')).resolves.toEqual({
      answers: { mcp_tool_call_approval_1: { answers: ['Deny'] } },
    });
    await expect(request('cancelled-1')).resolves.toEqual({
      answers: { mcp_tool_call_approval_1: { answers: ['Cancel'] } },
    });
    await expect(request('unavailable-1')).resolves.toEqual({
      answers: { mcp_tool_call_approval_1: { answers: ['Deny'] } },
    });
  });

  it('answers the exact approval question and never cross-associates a sibling option', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn(async () => approvalResult('approved', 'once'));
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      getThreadId: () => 'thread-1',
    });

    await expect(fixture.invoke('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'approval-with-sibling',
      autoResolutionMs: null,
      questions: [
        {
          id: 'note',
          header: 'Note',
          question: 'Any release note?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'Approve the design doc', description: 'Unrelated wording' }],
        },
        {
          id: 'mcp_tool_call_approval_1',
          header: 'Approval',
          question: 'Allow this MCP tool call?',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Approve Once', description: 'Run once' },
            { label: 'Deny', description: 'Do not run' },
          ],
        },
      ],
    })).resolves.toEqual({
      answers: { mcp_tool_call_approval_1: { answers: ['Approve Once'] } },
    });
  });

  it('keeps a once-scoped approval from escalating to a session-scoped option', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn(async () => approvalResult('approved', 'once'));
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      getThreadId: () => 'thread-1',
    });

    await expect(fixture.invoke('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'approval-scope',
      autoResolutionMs: null,
      questions: [{
        id: 'mcp_tool_call_approval_1',
        header: 'Approval',
        question: 'Allow this MCP tool call?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Approve this Session', description: 'Run for the session' },
          { label: 'Approve Once', description: 'Run once' },
          { label: 'Deny', description: 'Do not run' },
        ],
      }],
    })).resolves.toEqual({
      answers: { mcp_tool_call_approval_1: { answers: ['Approve Once'] } },
    });
  });

  it('dismisses the exact pending interaction when another Codex client resolves it', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn<PluginInteractions['requestApproval']>(async (_request, options) => {
      return await new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => {
          resolve({
            requestId: 'approval-aborted',
            kind: 'approval',
            status: 'requesterAborted',
          });
        }, { once: true });
      });
    });
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval }),
      getThreadId: () => 'thread-1',
    });

    const pending = fixture.invoke('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'command-external',
      startedAtMs: 1,
      environmentId: null,
      command: 'git fetch origin',
    }, 'rpc-external');
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledTimes(1));

    fixture.publish('serverRequest/resolved', {
      threadId: 'thread-1',
      requestId: 'rpc-external',
    });

    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('interaction was not dismissed')), 100)),
    ])).resolves.toEqual({ decision: 'cancel' });
    expect(requestApproval.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('asks a genuine multi-question form instead of treating cross-question wording as one approval', async () => {
    const fixture = createFixture();
    const requestApproval = vi.fn(async () => approvalResult('approved', 'once'));
    const askQuestions = vi.fn(async () => ({
      requestId: 'questions-1',
      kind: 'questions' as const,
      status: 'answered' as const,
      answers: {
        'review-note': {
          kind: 'singleChoice' as const,
          answer: { kind: 'choice' as const, choiceId: 'Approve the design doc' },
        },
        'rollout-note': {
          kind: 'singleChoice' as const,
          answer: { kind: 'choice' as const, choiceId: 'Deny the rollout request' },
        },
      },
    }));
    registerCodexAppServerInteractionHandlers({
      client: fixture.client,
      ui: createUi({ requestApproval, askQuestions }),
      getThreadId: () => 'thread-1',
    });

    await expect(fixture.invoke('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'multi-question-form',
      autoResolutionMs: null,
      questions: [
        {
          id: 'review-note',
          header: 'Review',
          question: 'Which review note applies?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'Approve the design doc', description: 'Unrelated wording' }],
        },
        {
          id: 'rollout-note',
          header: 'Rollout',
          question: 'Which rollout note applies?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'Deny the rollout request', description: 'Unrelated wording' }],
        },
      ],
    })).resolves.toEqual({
      answers: {
        'review-note': { answers: ['Approve the design doc'] },
        'rollout-note': { answers: ['Deny the rollout request'] },
      },
    });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(askQuestions).toHaveBeenCalledTimes(1);
  });
});
