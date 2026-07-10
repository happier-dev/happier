import { describe, expect, it, vi } from 'vitest';

import {
  createSdkExecFixture,
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import {
  bindClaudeAgentSdkFallbackSession,
  createClaudeAgentSdkTurnOperations,
} from './session.js';
import {
  computeClaudeSubscriptionAccessTokenFingerprint,
} from '../../../auth/services/cloud/refreshBridge.js';

type SessionParamsWithCredentials =
  Parameters<typeof bindClaudeAgentSdkFallbackSession>[0]['sessionParams'] & Readonly<{
    credentials: Readonly<{
      token: string;
      encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }>;
    }>;
  }>;

describe('bindClaudeAgentSdkFallbackSession', () => {
  it('returns a public session runtime without launching the SDK process while binding', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: SessionParamsWithCredentials = {
      cwd: '/tmp/claude-project',
      permissionMode: 'default',
      credentials,
    };

    const runtime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams,
    });

    expectRuntimeEnvelope(runtime);
    expect(ctx.agentRuntime.exec.spawnClient).not.toHaveBeenCalled();
  });

  it('forwards permission responses through the host session permission service', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const requestDecision = vi.fn(async () => ({ decision: 'approved' as const }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: {
        requestDecision,
        getMode: () => 'default',
      },
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    await runtime.respondToPermission('perm-1', true);

    expect(requestDecision).toHaveBeenCalledWith({
      provider: 'claude',
      requestId: 'perm-1',
      approved: true,
    });
  });

  it('releases the in-flight SDK turn when Claude emits a result before process exit', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-session-1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      await expect(runtime.sendTurnPrompt('second prompt')).resolves.toBeUndefined();

      expect(exec.spawnClient).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('publishes live context at turn end and refreshes it on the session-control request seam', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
      publishTranscriptMessages: true,
    })).operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    const contextRequests = () => exec.written.filter((record) =>
      (record as { request?: { subtype?: string } }).request?.subtype === 'get_context_usage') as Array<{
        request_id: string;
      }>;
    const respond = async (requestId: string, usedTokens: number) => {
      await exec.emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            totalTokens: usedTokens,
            maxTokens: 200_000,
            model: 'claude-sonnet-4-6',
            isAutoCompactEnabled: true,
            categories: [{ name: 'Messages', tokens: usedTokens, color: 'blue' }],
          },
        },
      });
    };

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('measure context');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await vi.waitFor(() => expect(contextRequests()).toHaveLength(1));
      await respond(contextRequests()[0]!.request_id, 48_000);
      await vi.waitFor(() => {
        expect(runtimeEvents).toContainEqual(expect.objectContaining({
          kind: 'transcript-agent-message-committed',
          agentId: 'claude',
          body: expect.objectContaining({
            type: 'token_count',
            contextSnapshot: expect.objectContaining({
              usedTokens: 48_000,
              source: 'provider_live',
              categories: [{ key: 'Messages', label: null, tokens: 48_000 }],
            }),
          }),
        }));
      }, { timeout: 2_000 });

      const refresh = runtime.updateSessionRuntimeConfig({
        configOption: { id: 'context_usage_refresh', value: 1 },
      });
      await vi.waitFor(() => expect(contextRequests()).toHaveLength(2));
      await respond(contextRequests()[1]!.request_id, 49_000);
      await expect(refresh).resolves.toMatchObject({ status: 'applied' });
      await vi.waitFor(() => {
        expect(runtimeEvents).toContainEqual(expect.objectContaining({
          body: expect.objectContaining({
            contextSnapshot: expect.objectContaining({ usedTokens: 49_000 }),
          }),
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('resumes the Claude provider session on the second SDK turn', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      await runtime.sendTurnPrompt('second prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(2);
      });

      expect(exec.spawnClient.mock.calls[0]?.[0].launch.args).not.toContain('--resume');
      expect(exec.spawnClient.mock.calls[1]?.[0].launch.args).toEqual(expect.arrayContaining([
        '--resume',
        'claude-provider-session-1',
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('routes Claude SDK OAuth refresh control requests through session runtime auth with the previous token fingerprint', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const refreshRuntimeAuth = vi.fn()
      .mockResolvedValueOnce({
        status: 'refreshed' as const,
        result: { accessToken: 'fresh-claude-access-token' },
      })
      .mockResolvedValueOnce({
        status: 'refreshed' as const,
        result: { accessToken: 'second-fresh-claude-access-token' },
      });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionAuth: {
        services: { refreshRuntimeAuth },
      },
    });
    const selection = {
      kind: 'profile',
      serviceId: 'claude-subscription',
      profileId: 'profile-1',
    };

    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([selection]),
      },
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      expect(exec.spawnClient.mock.calls[0]?.[0].launch.env).toMatchObject({
        CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
      });

      await exec.emit({
        type: 'control_request',
        request_id: 'oauth-refresh-1',
        request: { subtype: 'oauth_token_refresh' },
      });

      expect(refreshRuntimeAuth).toHaveBeenCalledWith({
        agentId: 'claude',
        serviceId: 'claude-subscription',
        targetId: 'happy-session-1',
        env: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([selection]),
        },
        selection,
        reason: 'claude_agent_sdk_oauth_token_refresh',
        failingAccessTokenFingerprint: null,
      }, expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
      expect(exec.written).toContainEqual({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'oauth-refresh-1',
          response: {
            accessToken: 'fresh-claude-access-token',
          },
        },
      });

      await exec.emit({
        type: 'control_request',
        request_id: 'oauth-refresh-2',
        request: { subtype: 'oauth_token_refresh' },
      });

      expect(refreshRuntimeAuth).toHaveBeenLastCalledWith({
        agentId: 'claude',
        serviceId: 'claude-subscription',
        targetId: 'happy-session-1',
        env: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([selection]),
        },
        selection,
        reason: 'claude_agent_sdk_oauth_token_refresh',
        failingAccessTokenFingerprint: computeClaudeSubscriptionAccessTokenFingerprint('fresh-claude-access-token'),
      }, expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps draining background tasks but releases the SDK turn after a successful result', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });

    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
      publishSdkMessages: true,
    })).operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt that launches a background task');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
      });
      await exec.emit({
        type: 'user',
        uuid: 'background-task-result-1',
        tool_use_result: {
          assistantAutoBackgrounded: true,
          backgroundTaskId: 'agent-1',
          status: 'async_launched',
        },
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'Parent turn is done, background task continues.',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });

      await expect(runtime.waitForTurnCompletion({ timeoutMs: 1_000 })).resolves.toBeUndefined();
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-complete')).toHaveLength(1);

      runtime.beginTurnLifecycle();
      await expect(runtime.sendTurnPrompt('follow-up while background task is running')).resolves.toBeUndefined();
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(2);
      });

      await exec.emit({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
        status: 'completed',
      });

      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites).toEqual(expect.arrayContaining([
          expect.objectContaining({
            fieldId: 'runtime.activity',
            value: expect.objectContaining({
              v: 1,
              activeCount: 1,
              sourceClass: 'provider_detached_task',
            }),
          }),
        ]));
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 0,
            observedAtMs: null,
            expiresAtMs: null,
            sourceClass: null,
          },
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('clears runtime activity when a provider task update carries a terminal status', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });

    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
      publishSdkMessages: true,
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt that launches a background task');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'Parent turn is done, background task continues.',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await expect(runtime.waitForTurnCompletion({ timeoutMs: 1_000 })).resolves.toBeUndefined();

      await exec.emit({
        type: 'system',
        subtype: 'task_updated',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
        patch: { status: 'completed' },
      });

      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites).toEqual(expect.arrayContaining([
          expect.objectContaining({
            fieldId: 'runtime.activity',
            value: expect.objectContaining({
              v: 1,
              activeCount: 1,
              sourceClass: 'provider_detached_task',
            }),
          }),
        ]));
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 0,
            observedAtMs: null,
            expiresAtMs: null,
            sourceClass: null,
          },
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not mint runtime activity from replayed provider task rows', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-replay',
      publishSdkMessages: true,
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('resume prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'replayed-agent-1',
        isReplay: true,
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'Done',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      const runtimeActivityWrites = writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'runtime.activity');
      expect(runtimeActivityWrites.every((request) => request?.value?.activeCount !== 1)).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not recreate cleared runtime activity when live provider task rows replay later', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-live-then-replay',
      publishSdkMessages: true,
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });
      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-replays-later',
      });
      await exec.emit({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-replays-later',
        status: 'completed',
      });
      await vi.waitFor(() => {
        expect(writeStateField.mock.calls
          .map((call) => call[0])
          .some((request) => request?.fieldId === 'runtime.activity' && request?.value?.activeCount === 0)).toBe(true);
      });

      writeStateField.mockClear();
      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-replays-later',
        isReplay: true,
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'Done',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      const runtimeActivityWrites = writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'runtime.activity');
      expect(runtimeActivityWrites.every((request) => request?.value?.activeCount !== 1)).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('treats killed provider task rows as terminal clear-only activity', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-killed-terminal',
      publishSdkMessages: true,
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'claude-provider-session-1',
        task_id: 'unknown-killed-agent',
        status: 'killed',
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'Done',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      const runtimeActivityWrites = writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'runtime.activity');
      expect(runtimeActivityWrites.every((request) => request?.value?.activeCount !== 1)).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reconciles stale provider runtime activity to idle when a foreground result has no live task evidence', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-result-reconcile',
      publishSdkMessages: true,
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt that launches a background task');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });
      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'stale-agent-1',
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'Parent turn is done, background task continues.',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();
      await vi.waitFor(() => {
        expect(writeStateField.mock.calls
          .map((call) => call[0])
          .some((request) => request?.fieldId === 'runtime.activity' && request?.value?.activeCount === 1)).toBe(true);
      });

      writeStateField.mockClear();
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('foreground resume with no live task rows');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(2);
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'No current task evidence.',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 0,
            observedAtMs: null,
            expiresAtMs: null,
            sourceClass: null,
          },
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('passes resolved MCP servers to the Claude SDK process', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });
    const mcpServers = {
      happier: {
        type: 'stdio',
        command: 'happier',
        args: ['mcp'],
      },
    };

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
        mcpServers,
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('prompt with tools');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      const mcpConfigIndex = args.indexOf('--mcp-config');
      expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(args[mcpConfigIndex + 1] ?? '{}')).toEqual({ mcpServers });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('preserves SDK process exit stderr when Claude exits without a result', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('prompt that exits before result');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const completion = runtime.waitForTurnCompletion();
      await exec.exitWith({
        exitCode: 0,
        signal: null,
        stderr: 'Claude Code refused the SDK request: invalid MCP config',
      });

      await expect(completion).rejects.toThrow(/exitCode=0.*invalid MCP config/iu);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('redacts bearer tokens from SDK process stderr in no-result diagnostics', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('prompt that exits before result');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const completion = runtime.waitForTurnCompletion();
      await exec.exitWith({
        exitCode: 0,
        signal: null,
        stderr: 'Claude Code auth failed for Bearer sk-live-secret-token',
      });

      await expect(completion).rejects.toThrow(/Bearer \[redacted\]/u);
      await expect(completion).rejects.not.toThrow(/sk-live-secret-token/u);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('redacts common Claude auth env values from SDK no-result diagnostics', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('prompt that exits before result');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const completion = runtime.waitForTurnCompletion();
      await exec.exitWith({
        exitCode: 0,
        signal: null,
        stderr: 'Claude Code auth failed: ANTHROPIC_API_KEY=sk-ant-live-secret CLAUDE_CODE_OAUTH_TOKEN=oauth-secret',
      });

      await expect(completion).rejects.toThrow(/ANTHROPIC_API_KEY=\[redacted\]/u);
      await expect(completion).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN=\[redacted\]/u);
      await expect(completion).rejects.not.toThrow(/sk-ant-live-secret|oauth-secret/u);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('redacts common Claude auth env values from colon and JSON-shaped SDK stderr', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('prompt that exits before result');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const completion = runtime.waitForTurnCompletion();
      await exec.exitWith({
        exitCode: 0,
        signal: null,
        stderr: 'Claude Code auth failed: ANTHROPIC_AUTH_TOKEN: auth-secret {"CLAUDE_CODE_OAUTH_REFRESH_TOKEN":"refresh-secret"}',
      });

      await expect(completion).rejects.toThrow(/ANTHROPIC_AUTH_TOKEN: \[redacted\]/u);
      await expect(completion).rejects.toThrow(/"CLAUDE_CODE_OAUTH_REFRESH_TOKEN":"\[redacted\]"/u);
      await expect(completion).rejects.not.toThrow(/auth-secret|refresh-secret/u);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not expose requested resume ids before Claude reports a provider session id', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionWriteStateField: writeStateField,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    await expect(runtime.startOrLoadSession({ resumeId: 'requested-claude-session' }))
      .resolves
      .toBeNull();
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: null });
    expect(writeStateField).not.toHaveBeenCalled();
  });

  it('publishes a Claude-reported SDK session id as soon as Claude emits it', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.startOrLoadSession({ resumeId: 'requested-claude-session' });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-provider-session-1',
      });
      await vi.waitFor(() => {
        expect(writeStateField).toHaveBeenCalledWith({
          fieldId: 'identity.providerSessionId',
          value: {
            metadataKey: 'claudeSessionId',
            value: 'claude-provider-session-1',
          },
          reason: 'claude-agent-sdk-session-id',
        });
      });
      expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'claude-provider-session-1' });

      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      expect(writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'identity.providerSessionId')).toHaveLength(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not repeatedly retry provider session id publication when execution-run state has no session target', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const unsupportedStateWrite = Object.assign(new Error('no session target'), {
      code: 'execution_run_session_state_unsupported',
      result: { reason: 'no_session_target' },
    });
    const writeStateField = vi.fn(async () => {
      throw unsupportedStateWrite;
    });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteStateField: writeStateField,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-provider-session-1',
      });
      await vi.waitFor(() => {
        expect(writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'identity.providerSessionId')).toHaveLength(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-provider-session-1',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'identity.providerSessionId')).toHaveLength(1);
      expect(ctx.logger.debug).not.toHaveBeenCalledWith(
        '[ClaudeAgentSdk] failed to publish provider session id',
        unsupportedStateWrite,
      );
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies a reasoning_effort runtime update to the next SDK query', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'xhigh' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      expect(exec.spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
        '--effort',
        'xhigh',
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies an ultracode runtime update as a single inline --settings overlay on the next SDK query', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      expect(args).toEqual(expect.arrayContaining(['--settings', '{"ultracode":true}']));
      expect(args.filter((arg) => arg === '--settings')).toHaveLength(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps a [1m] model id unmutated through --model while resolving ultracode against the base model', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-fable-5[1m]' });
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      expect(args).toEqual(expect.arrayContaining(['--model', 'claude-fable-5[1m]']));
      expect(args).toEqual(expect.arrayContaining(['--settings', '{"ultracode":true}']));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('drops an ultracode request when the selected model cannot honor it', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-sonnet-4-6' });
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      expect(args).not.toContain('--settings');
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not publish SDK host status records as session runtime events', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'status',
        status: 'running',
      });

      expect(runtimeEvents).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('publishes Claude SDK tool blocks as runtime tool events alongside raw SDK deltas', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
      publishSdkMessages: true,
    })).operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'assistant',
        uuid: 'assistant-tools-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading the file.' },
            { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'README.md' } },
          ],
        },
      });
      await exec.emit({
        type: 'user',
        uuid: 'user-tool-result-1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'README contents' }],
        },
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'Done',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'message-delta',
          sessionId: 'happy-session-1',
          turnId: 'claude-agent-sdk-turn-1',
          delta: expect.objectContaining({
            agentId: 'claude',
            message: expect.objectContaining({ uuid: 'assistant-tools-1' }),
          }),
        }),
        expect.objectContaining({
          kind: 'tool-call',
          sessionId: 'happy-session-1',
          turnId: 'claude-agent-sdk-turn-1',
          toolCallId: 'toolu_read_1',
          toolName: 'Read',
          toolInput: { file_path: 'README.md' },
        }),
        expect.objectContaining({
          kind: 'tool-result',
          sessionId: 'happy-session-1',
          turnId: 'claude-agent-sdk-turn-1',
          toolCallId: 'toolu_read_1',
          output: 'README contents',
        }),
        expect.objectContaining({
          kind: 'turn-complete',
          turnId: 'claude-agent-sdk-turn-1',
        }),
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('publishes Claude SDK assistant text as committed transcript events for UI sessions', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-sonnet-4-6' });
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'assistant',
        uuid: 'assistant-message-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'READY-FROM-CLAUDE' },
            { type: 'tool_use', id: 'toolu_ui_1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      });
      await exec.emit({
        type: 'user',
        uuid: 'user-tool-result-ui-1',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_ui_1',
            content: [{ type: 'text', text: '/tmp/claude-project' }],
            is_error: false,
          }],
        },
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        uuid: 'result-usage-1',
        is_error: false,
        session_id: 'claude-provider-session-1',
        result: 'READY-FROM-CLAUDE',
        num_turns: 1,
        total_cost_usd: 0.123,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          iterations: [{
            type: 'message',
            input_tokens: 70,
            output_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 15,
          }],
        },
        modelUsage: {
          'claude-sonnet-4-6': { contextWindow: 200_000 },
        },
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'transcript-agent-message-committed',
          sessionId: 'happy-session-1',
          agentId: 'claude',
          localId: 'claude-sdk-assistant-message-1',
          body: { type: 'message', message: 'READY-FROM-CLAUDE' },
        }),
        expect.objectContaining({
          kind: 'transcript-agent-message-committed',
          sessionId: 'happy-session-1',
          agentId: 'claude',
          localId: 'claude-sdk-result-usage-result-usage-1',
          body: expect.objectContaining({
            type: 'result',
            uuid: 'result-usage-1',
            total_cost_usd: 0.123,
          }),
          meta: {
            source: 'claude-agent-sdk-result-usage',
            modelId: 'claude-sonnet-4-6',
          },
        }),
        expect.objectContaining({
          kind: 'tool-call',
          sessionId: 'happy-session-1',
          turnId: 'claude-agent-sdk-turn-1',
          toolCallId: 'toolu_ui_1',
          toolName: 'Bash',
          toolInput: { command: 'pwd' },
        }),
        expect.objectContaining({
          kind: 'tool-result',
          sessionId: 'happy-session-1',
          turnId: 'claude-agent-sdk-turn-1',
          toolCallId: 'toolu_ui_1',
          output: '/tmp/claude-project',
          isError: false,
        }),
        expect.objectContaining({
          kind: 'turn-complete',
          sessionId: 'happy-session-1',
          turnId: 'claude-agent-sdk-turn-1',
        }),
      ]));
      expect(runtimeEvents).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          localId: 'claude-sdk-result-usage-result-usage-1',
          body: expect.objectContaining({ result: 'READY-FROM-CLAUDE' }),
        }),
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('surfaces Claude SDK provider auth failures as typed failed-turn diagnostics', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      const completion = runtime.waitForTurnCompletion();
      await exec.emit({
        type: 'assistant',
        uuid: 'assistant-auth-error',
        error: 'authentication_failed',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: true,
        session_id: 'claude-provider-session-1',
        result: 'Not logged in · Please run /login',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });

      await expect(completion).rejects.toThrow(/authentication_failed.*Not logged in/u);
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'transcript-agent-message-committed',
          sessionId: 'happy-session-1',
          agentId: 'claude',
          localId: 'claude-sdk-assistant-auth-error',
          body: { type: 'message', message: 'Not logged in · Please run /login' },
        }),
        expect.objectContaining({
          kind: 'turn-failed',
          sessionId: 'happy-session-1',
          turnId: 'claude-agent-sdk-turn-1',
          issue: expect.objectContaining({
            code: 'claude_authentication_failed',
            source: 'auth_error',
            agentId: 'claude',
            sanitizedPreview: expect.stringContaining('Not logged in'),
          }),
        }),
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});
