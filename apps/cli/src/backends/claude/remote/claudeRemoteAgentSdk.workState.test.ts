import { describe, expect, it, vi } from 'vitest';

import { claudeRemoteAgentSdk } from './claudeRemoteAgentSdk';
import { makeMode } from './claudeRemoteAgentSdk.testkit';

function createQueryFromMessages(messages: readonly unknown[]) {
  return vi.fn(() => ({
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
    },
    close: vi.fn(),
    setPermissionMode: vi.fn(),
    setModel: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
    supportedCommands: vi.fn(async () => []),
    supportedModels: vi.fn(async () => []),
  } as any));
}

async function runAgentSdkMessagesForRateLimitTest(params: Readonly<{
  messages: readonly unknown[];
  onMessage: (message: unknown) => void;
  onRateLimitEvent: (details: unknown) => void;
  onQuotaEvidence?: (details: unknown) => void;
  onRuntimeAuthFailureEvent?: (error: unknown) => void;
}>): Promise<void> {
  const createQuery = createQueryFromMessages(params.messages);
  let didSendFirst = false;

  await claudeRemoteAgentSdk({
    sessionId: null,
    transcriptPath: null,
    path: '/tmp',
    claudeArgs: [],
    claudeExecutablePath: '/tmp/claude',
    canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    isAborted: () => false,
    nextMessage: async () => {
      if (didSendFirst) return null;
      didSendFirst = true;
      return { message: 'hello', mode: makeMode({ permissionMode: 'default' }) };
    },
    onReady: () => {},
    onSessionFound: () => {},
    onMessage: params.onMessage,
    onRateLimitEvent: params.onRateLimitEvent,
    onQuotaEvidence: params.onQuotaEvidence,
    onRuntimeAuthFailureEvent: params.onRuntimeAuthFailureEvent,
    createQuery,
  });
}

describe('claudeRemoteAgentSdk work-state projection', () => {
  it('consumes a rejected rate_limit_event as quota evidence, not a parent failure, before transcript conversion drops it', async () => {
    const onRateLimitEvent = vi.fn();
    const onQuotaEvidence = vi.fn();
    const onMessage = vi.fn();

    await runAgentSdkMessagesForRateLimitTest({
      messages: [
        {
          type: 'rate_limit_event',
          uuid: 'rate-limit-1',
          session_id: 'claude-session-1',
          rate_limit_info: {
            status: 'rejected',
            resetsAt: 1_768_100_000_000,
            rateLimitType: 'five_hour',
            utilization: 100,
            unifiedWindows: {
              five_hour: { utilization: 1, resetsAt: 1_768_100_000 },
              seven_day: { utilization: 0.42, resetsAt: 1_768_500_000 },
            },
          },
        },
        { type: 'result' },
      ],
      onMessage,
      onRateLimitEvent,
      onQuotaEvidence,
    });

    // Availability telemetry never fails the parent turn; only the provider's result or error does.
    expect(onRateLimitEvent).not.toHaveBeenCalled();
    // Every window the event reported travels with the evidence, so its snapshot keeps them all.
    expect(onQuotaEvidence).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ providerLimitId: 'five_hour', utilization: 100 }),
      expect.objectContaining({ providerLimitId: 'seven_day', utilization: 42 }),
    ]));
    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rate_limit_event' }));
  });

  it('does not surface allowed rate_limit_event telemetry as a runtime limit', async () => {
    const onRateLimitEvent = vi.fn();
    const onQuotaEvidence = vi.fn();
    const onMessage = vi.fn();

    await runAgentSdkMessagesForRateLimitTest({
      messages: [
        {
          type: 'rate_limit_event',
          uuid: 'rate-limit-allowed',
          session_id: 'claude-session-allowed',
          rate_limit_info: {
            status: 'allowed',
            resetsAt: 1_779_097_200,
            rateLimitType: 'five_hour',
            overageStatus: 'rejected',
            overageDisabledReason: 'org_level_disabled',
            isUsingOverage: false,
          },
        },
        { type: 'result' },
      ],
      onMessage,
      onRateLimitEvent,
      onQuotaEvidence,
    });

    expect(onRateLimitEvent).not.toHaveBeenCalled();
    expect(onQuotaEvidence).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rate_limit_event' }));
  });

  it('harvests allowed-warning Claude rate-limit utilization as passive quota evidence', async () => {
    const onRateLimitEvent = vi.fn();
    const onQuotaEvidence = vi.fn();
    const onMessage = vi.fn();

    await runAgentSdkMessagesForRateLimitTest({
      messages: [
        {
          type: 'rate_limit_event',
          uuid: 'rate-limit-warning',
          session_id: 'claude-session-warning',
          rate_limit_info: {
            status: 'allowed_warning',
            resetsAt: 1_779_097_200_000,
            rateLimitType: 'seven_day',
            utilization: 0.92,
          },
        },
        { type: 'result' },
      ],
      onMessage,
      onRateLimitEvent,
      onQuotaEvidence,
    });

    expect(onRateLimitEvent).not.toHaveBeenCalled();
    expect(onQuotaEvidence).toHaveBeenCalledWith([{
      v: 1,
      resetAtMs: 1_779_097_200_000,
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
      providerLimitId: 'seven_day',
      planType: null,
      utilization: 92,
      overage: null,
      action: null,
      connectedService: null,
    }]);
    expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rate_limit_event' }));
  });

  it('harvests every unified Claude quota window from allowed rate-limit telemetry', async () => {
    const onRateLimitEvent = vi.fn();
    const onQuotaEvidence = vi.fn();

    await runAgentSdkMessagesForRateLimitTest({
      messages: [
        {
          // Claude Code 2.1.282 shape: the top level carries no utilization; each window's used
          // fraction (above 1 once usage runs past the cap) lives under `unifiedWindows`.
          type: 'rate_limit_event',
          uuid: 'rate-limit-unified',
          session_id: 'claude-session-unified',
          rate_limit_info: {
            status: 'allowed',
            resetsAt: 1_790_378_400,
            rateLimitType: 'five_hour',
            overageStatus: 'rejected',
            overageDisabledReason: 'org_level_disabled',
            isUsingOverage: false,
            unifiedWindows: {
              five_hour: { utilization: 0.05, resetsAt: 1_790_378_400 },
              seven_day: { utilization: 1.2, resetsAt: 1_790_928_000 },
            },
          },
        },
        { type: 'result' },
      ],
      onMessage: vi.fn(),
      onRateLimitEvent,
      onQuotaEvidence,
    });

    expect(onRateLimitEvent).not.toHaveBeenCalled();
    expect(onQuotaEvidence).toHaveBeenCalledTimes(1);
    expect(onQuotaEvidence).toHaveBeenCalledWith([
      expect.objectContaining({ providerLimitId: 'five_hour', utilization: 5, resetAtMs: 1_790_378_400_000 }),
      expect.objectContaining({ providerLimitId: 'seven_day', utilization: 100, resetAtMs: 1_790_928_000_000 }),
    ]);
  });

  it('surfaces synthetic API-error rate-limit assistant records before transcript conversion', async () => {
    const onRateLimitEvent = vi.fn();
    const onMessage = vi.fn();

    await runAgentSdkMessagesForRateLimitTest({
      messages: [
        {
          type: 'assistant',
          uuid: 'api-error-assistant-1',
          isApiErrorMessage: true,
          error: {
            type: 'rate_limit_error',
            code: 'rate_limit',
            message: 'Claude API rate limit exceeded',
            api_error_status: 429,
            reset_at: '2026-05-17T12:00:00.000Z',
          },
        },
        { type: 'result' },
      ],
      onMessage,
      onRateLimitEvent,
    });

    expect(onRateLimitEvent).toHaveBeenCalledWith(expect.objectContaining({
      resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
    }), []);
    expect(onRateLimitEvent.mock.calls[0]?.[0]).not.toHaveProperty('providerLimitId');
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant',
      isApiErrorMessage: true,
    }));
  });

  it('routes synthetic Claude auth API errors to runtime auth recovery without usage-limit mapping', async () => {
    const onRateLimitEvent = vi.fn();
    const onRuntimeAuthFailureEvent = vi.fn();
    const onMessage = vi.fn();
    const authError = {
      type: 'assistant',
      uuid: 'api-error-auth-1',
      isApiErrorMessage: true,
      api_error_status: 401,
      error: {
        type: 'authentication_error',
        message: 'Invalid authentication credentials',
      },
      response: {
        headers: {
          'retry-after': '30',
          'anthropic-ratelimit-requests-reset': '2030-01-01T00:00:00.000Z',
        },
      },
    };

    await runAgentSdkMessagesForRateLimitTest({
      messages: [authError, { type: 'result' }],
      onMessage,
      onRateLimitEvent,
      onRuntimeAuthFailureEvent,
    });

    expect(onRateLimitEvent).not.toHaveBeenCalled();
    expect(onRuntimeAuthFailureEvent).toHaveBeenCalledWith(authError);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant',
      isApiErrorMessage: true,
    }));
  });

  it('keeps provider-owned Claude SDK 401 retries out of runtime auth recovery', async () => {
    const onRateLimitEvent = vi.fn();
    const onRuntimeAuthFailureEvent = vi.fn();
    const onMessage = vi.fn();
    const authError = {
      type: 'system',
      subtype: 'api_error',
      attempt: 1,
      max_retries: 11,
      retry_delay_ms: 1_000,
      error_status: 401,
      error: 'Connection error.',
    };

    await runAgentSdkMessagesForRateLimitTest({
      messages: [authError, { type: 'result' }],
      onMessage,
      onRateLimitEvent,
      onRuntimeAuthFailureEvent,
    });

    expect(onRateLimitEvent).not.toHaveBeenCalled();
    expect(onRuntimeAuthFailureEvent).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining(authError));
  });

  it('routes exhausted Claude SDK 401 retry events to runtime auth recovery', async () => {
    const onRateLimitEvent = vi.fn();
    const onRuntimeAuthFailureEvent = vi.fn();
    const onMessage = vi.fn();
    const authError = {
      type: 'system',
      subtype: 'api_error',
      attempt: 11,
      max_retries: 11,
      retry_delay_ms: 1_000,
      error_status: 401,
      error: 'Connection error.',
    };

    await runAgentSdkMessagesForRateLimitTest({
      messages: [authError, { type: 'result' }],
      onMessage,
      onRateLimitEvent,
      onRuntimeAuthFailureEvent,
    });

    expect(onRateLimitEvent).not.toHaveBeenCalled();
    expect(onRuntimeAuthFailureEvent).toHaveBeenCalledWith(authError);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining(authError));
  });

  it('stops processing provider messages after a connected auth failure', async () => {
    const onRateLimitEvent = vi.fn();
    const onRuntimeAuthFailureEvent = vi.fn();
    const onMessage = vi.fn();
    const authError = {
      type: 'assistant',
      uuid: 'api-error-auth-1',
      isApiErrorMessage: true,
      api_error_status: 401,
      error: {
        type: 'authentication_error',
        message: 'Invalid authentication credentials',
      },
    };
    const laterQuotaError = {
      type: 'rate_limit_event',
      uuid: 'rate-limit-after-auth',
      session_id: 'claude-session-1',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: 1_768_100_000_000,
        rateLimitType: 'weekly',
        utilization: 100,
      },
    };

    await runAgentSdkMessagesForRateLimitTest({
      messages: [authError, laterQuotaError, { type: 'result' }],
      onMessage,
      onRateLimitEvent,
      onRuntimeAuthFailureEvent,
    });

    expect(onRuntimeAuthFailureEvent).toHaveBeenCalledWith(authError);
    expect(onRateLimitEvent).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant',
      isApiErrorMessage: true,
    }));
  });

  it('includes Agent SDK result errors in execution failures', async () => {
    await expect(runAgentSdkMessagesForRateLimitTest({
      messages: [
        {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['Cannot resume the requested Claude conversation.'],
        },
      ],
      onMessage: vi.fn(),
      onRateLimitEvent: vi.fn(),
    })).rejects.toThrow(/Cannot resume the requested Claude conversation/u);
  });

  it('does not publish background task lifecycle system messages as user-facing work-state snapshots', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        description: 'grep -rn "thing"',
        task_type: 'local_bash',
        session_id: 'claude-session-1',
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).not.toHaveBeenCalled();
  });

  it('publishes TodoWrite tool inputs as todo work-state snapshots', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_todo_1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Wire send path', activeForm: 'Wiring send path', status: 'in_progress' },
                  { content: 'Run tests', status: 'pending' },
                ],
              },
            },
          ],
        },
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'claude',
      ownedSourceFamilies: ['todo:derived:claude.todo'],
      items: [
        expect.objectContaining({
          kind: 'todo',
          status: 'active',
          title: 'Wire send path',
          summary: 'Wiring send path',
        }),
        expect.objectContaining({
          kind: 'todo',
          status: 'pending',
          title: 'Run tests',
        }),
      ],
    }));
  });

  it('publishes empty TodoWrite snapshots so completed todo lists clear stale todos', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_todo_empty',
              name: 'TodoWrite',
              input: { todos: [] },
            },
          ],
        },
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'claude',
      ownedSourceFamilies: ['todo:derived:claude.todo'],
      items: [],
      primaryItemId: null,
    }));
  });

  it('publishes Claude TaskCreate and TaskUpdate tool uses as task-list work-state snapshots', async () => {
    const onWorkStateSnapshot = vi.fn();
    const createQuery = createQueryFromMessages([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_create_1',
              name: 'TaskCreate',
              input: {
                subject: 'Patch task projection',
                activeForm: 'Patching task projection',
              },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_create_1',
              content: '{"task":{"id":"task_real_1","subject":"Patch task projection","status":"pending"}}',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_update_1',
              name: 'TaskUpdate',
              input: {
                taskId: 'task_real_1',
                status: 'in_progress',
                subject: 'Run tests',
              },
            },
          ],
        },
      },
      { type: 'result' },
    ]);
    let didSendFirst = false;

    await claudeRemoteAgentSdk({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      claudeArgs: [],
      claudeExecutablePath: '/tmp/claude',
      canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      isAborted: () => false,
      nextMessage: async () => {
        if (didSendFirst) return null;
        didSendFirst = true;
        return { message: 'hello', mode: makeMode({ permissionMode: 'default' } as any) };
      },
      onReady: () => {},
      onSessionFound: () => {},
      onMessage: () => {},
      onWorkStateSnapshot,
      createQuery,
    } as any);

    expect(onWorkStateSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      backendId: 'claude',
      ownedSourceFamilies: ['task:derived:claude.task'],
      items: [
        expect.objectContaining({
          id: 'task:derived:claude.task:task_real_1',
          kind: 'task',
          status: 'active',
          title: 'Run tests',
        }),
      ],
    }));
  });
});
