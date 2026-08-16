import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConnectionIdSchema,
  registerSensitiveDiagnosticValues,
} from '@happier-dev/protocol';
import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
import type {
  AgentTranscriptFileFollowInput as TranscriptFileFollowInputV1,
} from '@happier-dev/plugin-sdk/agent-runtime';

import {
  createSdkExecFixture,
  createEventsFixture,
  createPluginContextFixture,
  createSessionHooksFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import {
  bindClaudeAgentSdkFallbackSession,
  createClaudeAgentSdkTurnOperations,
} from './session.testkit.js';
import {
  createClaudeAgentSdkTurnOperations as createClaudeAgentSdkProviderOperations,
} from './session.js';
import {
  computeClaudeSubscriptionAccessTokenFingerprint,
} from '../../../auth/services/cloud/refreshBridge.js';
import { createSessionProviderInputOutcomeNormalizer } from '../../../../../../../../apps/cli/src/agent/runtime/session/input/providerInputOutcome.js';

type SessionParamsWithCredentials =
  Parameters<typeof bindClaudeAgentSdkFallbackSession>[0]['sessionParams'] & Readonly<{
    credentials: Readonly<{
      token: string;
      encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }>;
    }>;
  }>;

describe('bindClaudeAgentSdkFallbackSession', () => {
  it('reuses the Agent SDK query after an exact user-requested interruption result', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkProviderOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-interrupted-query-reuse',
    });

    try {
      operations.beginProviderTurn();
      await expect(operations.sendProviderTurnPrompt('initial prompt')).resolves.toEqual({
        kind: 'accepted',
      });
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledOnce());
      const interruptedCompletion = operations.waitForProviderTurnCompletion({ timeoutMs: 1_000 });

      await operations.cancelProviderTurn();
      await exec.emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: 'provider-session-interrupted',
        result: 'Request interrupted by user',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await expect(interruptedCompletion).resolves.toBeUndefined();

      operations.beginProviderTurn();
      await expect(operations.sendProviderTurnPrompt('continue after interruption')).resolves.toEqual({
        kind: 'accepted',
      });
      expect(exec.spawnClient).toHaveBeenCalledOnce();
      expect(exec.written).toContainEqual({
        type: 'user',
        message: { role: 'user', content: 'continue after interruption' },
      });
    } finally {
      await operations.disposeProviderSession();
    }
  });

  it('targets task-id-only background work once instead of broadly interrupting the foreground query', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkProviderOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-targeted-cancel',
    });

    try {
      operations.beginProviderTurn();
      await operations.sendProviderTurnPrompt('launch background work');
      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-without-session',
        task_type: 'local_agent',
      });

      const cancellation = operations.cancelProviderTurn();
      await vi.waitFor(() => {
        expect(exec.written.some((record) => (
          (record as any)?.request?.subtype === 'stop_task'
        ))).toBe(true);
      });
      const stopRequest = exec.written.find((record) => (
        (record as any)?.request?.subtype === 'stop_task'
      )) as any;
      await exec.emit({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: stopRequest.request_id,
          response: {},
        },
      });
      await cancellation;
      await operations.cancelProviderTurn();

      expect(exec.written.filter((record) => (
        (record as any)?.request?.subtype === 'stop_task'
      ))).toEqual([expect.objectContaining({
        request: { subtype: 'stop_task', task_id: 'task-without-session' },
      })]);
      expect(exec.written.some((record) => (record as any)?.request?.subtype === 'interrupt')).toBe(false);
    } finally {
      await operations.disposeProviderSession();
    }
  });

  it('returns the provider operation owner directly without a public runtime envelope', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkProviderOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-native-operations',
    });

    expect(operations.subscribeProviderEvents).toBeTypeOf('function');
    expect(operations.sendProviderTurnPrompt).toBeTypeOf('function');
    expect(operations.startProviderSession).toBeTypeOf('function');
    expect('resetOrDisposeRuntime' in operations).toBe(false);
    expect('events' in operations).toBe(false);
    expect('send' in operations).toBe(false);
    expect('identity' in operations).toBe(false);

    await operations.disposeProviderSession();
  });

  it('publishes Provider-bound SDK usage without Claude pricing estimates', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkProviderOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-provider-usage',
      initialModelId: 'deepseek-ai/DeepSeek-V3.1',
      providerModel: {
        id: 'deepseek-ai/DeepSeek-V3.1',
        name: 'DeepSeek V3.1',
        capabilities: { reasoningControls: 'unknown' },
      },
    });
    const observations: Array<{
      source: string;
      modelId: string | null;
      cost: Readonly<Record<string, unknown>> | null;
    }> = [];
    operations.subscribeUsageObservation((observation) => observations.push(observation));

    try {
      operations.beginProviderTurn();
      await operations.sendProviderTurnPrompt('prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });
      await exec.emit({
        type: 'assistant',
        uuid: 'assistant-provider-usage',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          model: 'deepseek-ai/DeepSeek-V3.1',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        uuid: 'result-provider-usage',
        is_error: false,
        session_id: 'provider-session-usage',
        result: 'done',
        num_turns: 1,
        total_cost_usd: 0.123,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
        },
        modelUsage: {
          'deepseek-ai/DeepSeek-V3.1': { contextWindow: 128_000 },
        },
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await operations.waitForProviderTurnCompletion();

      expect(observations).toEqual([
        expect.objectContaining({
          source: 'claude-assistant-usage',
          modelId: 'deepseek-ai/DeepSeek-V3.1',
          cost: null,
        }),
        expect.objectContaining({
          source: 'claude-sdk-result',
          modelId: 'deepseek-ai/DeepSeek-V3.1',
          cost: expect.objectContaining({
            reportedUsd: 0.123,
            estimatedUsd: 0,
            costSource: 'provider_reported',
          }),
        }),
      ]);
    } finally {
      await operations.disposeProviderSession();
    }
  });

  it('uses the successfully applied Provider descriptor for the next SDK reasoning controls', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkProviderOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-provider-reasoning-switch',
      initialModelId: 'deepseek-ai/DeepSeek-V3.1',
      providerModel: {
        id: 'deepseek-ai/DeepSeek-V3.1',
        name: 'DeepSeek V3.1',
        capabilities: { reasoningControls: 'unknown' },
      },
    });
    const nextBinding = {
      connectionId: ProviderConnectionIdSchema.parse('pc_deepseek'),
      model: {
        id: 'deepseek-ai/DeepSeek-V3.2',
        name: 'DeepSeek V3.2',
        capabilities: { reasoningControls: 'supported' as const },
        modelOptions: [{
          id: 'ultracode',
          name: 'Ultracode',
          type: 'boolean',
          currentValue: 'false',
        }],
      },
      materialization: { v: 1 as const, kind: 'spawnEnv' as const },
    };

    try {
      await operations.updateProviderConfiguration({
        modelId: nextBinding.model.id,
        configOption: { id: 'ultracode', value: true },
        providerBinding: nextBinding,
      });
      operations.beginProviderTurn();
      await operations.sendProviderTurnPrompt('prompt');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));

      expect(exec.spawnClient.mock.calls[0]?.[0].launch.args)
        .toEqual(expect.arrayContaining([
          '--model',
          nextBinding.model.id,
          '--settings',
          '{"ultracode":true}',
        ]));
    } finally {
      await operations.disposeProviderSession();
    }
  });

  it('applies released advanced options at the native Agent SDK provider launch', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkProviderOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: { EXISTING_ENV: 'kept' },
      advancedOptions: {
        plugins: [{ type: 'local', path: '/tmp/released-plugin' }],
        maxBudgetUsd: 2.5,
        systemPrompt: 'Released account override',
      },
      permissionMode: 'default',
      happierSessionId: 'happy-native-advanced-options',
    });

    try {
      await operations.sendProviderTurnPrompt('hello');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
      expect(exec.spawnClient.mock.calls[0]?.[0].launch).toMatchObject({
        env: { EXISTING_ENV: 'kept' },
        args: expect.arrayContaining([
          '--plugin-dir',
          '/tmp/released-plugin',
          '--max-budget-usd',
          '2.5',
          '--system-prompt',
          'Released account override',
        ]),
      });
    } finally {
      await operations.cancelProviderTurn('test_complete').catch(() => undefined);
      await operations.disposeProviderSession('test_complete').catch(() => undefined);
    }
  });

  it('publishes provider identity and effective model evidence through native semantic seams', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkTurnOperations({
      nativeOperationsOnly: true,
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-native-provider-identity',
    });
    const runtimeEvents: AgentSessionRuntimeEvent[] = [];
    const effectiveModels: Array<Readonly<{ modelId: string; contextWindowTokens?: number | null }>> = [];
    operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
    operations.subscribeEffectiveModel((evidence) => effectiveModels.push(evidence));

    try {
      await operations.sendTurnPrompt('hello');
      await exec.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-provider-native',
      });
      await exec.emit({
        type: 'assistant',
        uuid: 'assistant-effective-model',
        message: {
          role: 'assistant',
          model: 'claude-effective-runtime',
          content: [{ type: 'text', text: 'ready' }],
        },
      });

      expect(runtimeEvents).toContainEqual(expect.objectContaining({
        kind: 'session-id-publish',
        publishedSessionId: 'claude-provider-native',
      }));
      expect(effectiveModels).toEqual([{ modelId: 'claude-effective-runtime' }]);
    } finally {
      await operations.resetOrDisposeRuntime();
    }
  });

  it('proves native resume continuity without publishing the private transcript path as metadata', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const writeMetadata = vi.fn(async () => undefined);
    const follows: TranscriptFileFollowInputV1[] = [];
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: sessionHooks.service,
      sessionWriteMetadata: writeMetadata,
      transcripts: {
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async () => ({ id: 'claude-native-proof', dispose: vi.fn(async () => undefined) })),
        fileFollow: {
          follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
            follows.push(input);
            return {
              id: `follow-${follows.length}`,
              drainNow: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            };
          }),
        },
      },
    });
    const operations = createClaudeAgentSdkTurnOperations({
      nativeOperationsOnly: true,
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-native-resume',
      enableSessionResumability: true,
    });
    try {
      await operations.sendTurnPrompt('native exact prompt');
      await vi.waitFor(() => expect(sessionHooks.service.startServer).toHaveBeenCalledTimes(1));
      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
        onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
      }> | undefined;
      if (!hookRequest?.onSessionHook) throw new Error('Claude Agent SDK session hook server was not started');
      await hookRequest.onSessionHook('claude-native-session', {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'claude-native-session',
        transcript_path: '/tmp/claude-project/claude-native-session.jsonl',
      });
      await hookRequest.onSessionHook('claude-native-session', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-native-session',
        prompt: 'native exact prompt',
      });
      const proofFollow = follows[0];
      if (!proofFollow) throw new Error('missing native transcript proof follow');
      await proofFollow.onLine({
        line: JSON.stringify({
          type: 'user',
          uuid: 'native-exact-row',
          timestamp: new Date().toISOString(),
          sessionId: 'claude-native-session',
          message: { role: 'user', content: 'native exact prompt' },
        }),
        sourcePath: proofFollow.path,
        sequence: 1,
      });
      await operations.cancelTurn();

      await operations.sendTurnPrompt('native follow-up');
      expect(exec.spawnClient.mock.calls[1]?.[0].launch.args).toEqual(expect.arrayContaining([
        '--resume',
        'claude-native-session',
      ]));
      expect(writeMetadata).not.toHaveBeenCalled();
    } finally {
      await operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('resumes a restarted native session from the host-provided provider identity', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: createSessionHooksFixture().service,
    });
    const operations = createClaudeAgentSdkTurnOperations({
      nativeOperationsOnly: true,
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-native-restarted',
      initialProviderSessionId: 'claude-provider-before-restart',
      enableSessionResumability: true,
    });

    try {
      await operations.sendTurnPrompt('continue after restart');
      expect(exec.spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
        '--resume',
        'claude-provider-before-restart',
      ]));
    } finally {
      await operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('installs authenticated Activity hooks without resumability and observes exact Agent lifecycle', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: sessionHooks.service,
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-activity-hooks',
      publishSdkMessages: true,
    })).operations;
    const runtimeActivityEvents: AgentSessionRuntimeEvent[] = [];
    runtime.subscribeCanonicalAgentSessionEvents((event) => runtimeActivityEvents.push(event));

    try {
      await runtime.sendTurnPrompt('launch background work');
      expect(sessionHooks.service.startServer).toHaveBeenCalledTimes(1);
      expect(sessionHooks.service.createPluginDir).toHaveBeenCalledTimes(1);
      expect(exec.spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
        '--plugin-dir',
        '/tmp/happier-claude-hook-plugin',
        '--include-hook-events',
      ]));

      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
        onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
      }> | undefined;
      if (!hookRequest?.onSessionHook) throw new Error('Claude Agent SDK session hook server was not started');
      await hookRequest.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'PostToolUse',
        session_id: 'claude-provider-session-1',
        tool_name: 'Agent',
        tool_input: { description: 'background by default' },
        tool_response: { status: 'async_launched', agentId: 'agent-1' },
      });
      await vi.waitFor(() => {
        expect(runtimeActivityEvents.at(-1)).toEqual(expect.objectContaining({
          state: 'active', activeCount: 1,
        }));
      });

      await hookRequest.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'SubagentStop',
        session_id: 'claude-provider-session-1',
        agent_id: 'agent-1',
      });
      await vi.waitFor(() => {
        expect(runtimeActivityEvents.at(-1)).toEqual(expect.objectContaining({
          state: 'idle', activeCount: 0,
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('turns exact non-success Activity hook responses into observation loss without clearing known work', async () => {
    const createCase = async (sessionId: string) => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const exec = createSdkExecFixture();
      const sessionHooks = createSessionHooksFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        exec: exec.service,
        sessionHooks: sessionHooks.service,
      });
      const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        launchEnv: {},
        permissionMode: 'default',
        happierSessionId: `happy-${sessionId}`,
        publishSdkMessages: true,
      })).operations;
      const activityEvents: AgentSessionRuntimeEvent[] = [];
      runtime.subscribeCanonicalAgentSessionEvents((event) => activityEvents.push(event));
      await runtime.sendTurnPrompt('exercise hook response');
      await exec.emit({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
      });
      return { activityEvents, exec, runtime };
    };

    for (const [hookEvent, outcome] of [
      ['PostToolUse', 'error'],
      ['SubagentStart', 'cancelled'],
      ['SubagentStop', 'error'],
    ] as const) {
      const testCase = await createCase(`session-${hookEvent}`);
      try {
        await testCase.exec.emit({
          type: 'system',
          subtype: 'hook_response',
          hook_name: `${hookEvent}:probe`,
          hook_event: hookEvent,
          outcome,
          exit_code: 41,
          output: '',
          stdout: '',
          stderr: '',
          session_id: `session-${hookEvent}`,
          uuid: `hook-${hookEvent}`,
        });
        await vi.waitFor(() => expect(testCase.activityEvents.at(-1)).toEqual(expect.objectContaining({
          kind: 'runtime-activity-snapshot',
          state: 'unknown',
          activeCount: 0,
        })));
      } finally {
        await testCase.runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    }

    for (const row of [
      { hook_event: 'PostToolUse', outcome: 'success', session_id: 'session-inert' },
      { hook_event: 'SessionStart', outcome: 'error', session_id: 'session-inert' },
      { hook_event: 'PostToolUse', outcome: 'error', session_id: 'other-session' },
    ] as const) {
      const testCase = await createCase('session-inert');
      try {
        await testCase.exec.emit({
          type: 'system',
          subtype: 'hook_response',
          hook_name: `${row.hook_event}:probe`,
          exit_code: row.outcome === 'success' ? 0 : 41,
          output: '',
          stdout: '',
          stderr: '',
          uuid: `hook-inert-${row.hook_event}`,
          ...row,
        });
        expect(testCase.activityEvents.some((event) => (
          event.kind === 'runtime-activity-snapshot' && event.state === 'unknown'
        ))).toBe(false);
        expect(testCase.runtime.readSessionIdentity()).toEqual({ sessionId: 'session-inert' });
      } finally {
        await testCase.runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    }

    const activeCase = await createCase('session-active');
    try {
      await activeCase.exec.emit({
        type: 'system',
        subtype: 'task_started',
        task_type: 'local_workflow',
        task_id: 'workflow-active',
        session_id: 'session-active',
      });
      await vi.waitFor(() => expect(activeCase.activityEvents.at(-1)).toEqual(expect.objectContaining({
        state: 'active', activeCount: 1,
      })));
      await activeCase.exec.emit({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'PostToolUse:probe',
        hook_event: 'PostToolUse',
        outcome: 'error',
        exit_code: 41,
        output: '',
        stdout: '',
        stderr: '',
        session_id: 'session-active',
        uuid: 'hook-active-error',
      });
      await vi.waitFor(() => expect(activeCase.activityEvents.at(-1)).toEqual(expect.objectContaining({
        state: 'active', activeCount: 1,
      })));
    } finally {
      await activeCase.runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reserves the SDK turn while authenticated hook setup is pending', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    let releaseAssets: (() => void) | null = null;
    const assetsPending = new Promise<void>((resolve) => {
      releaseAssets = resolve;
    });
    sessionHooks.service.resolveForwarderAssets.mockImplementation(async () => {
      await assetsPending;
      return {
        nodeExecutable: '/bin/node',
        sessionForwarderScript: '/app/session_hook_forwarder.cjs',
        permissionForwarderScript: '/app/permission_hook_forwarder.cjs',
      };
    });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: sessionHooks.service,
    });
    const runtime = expectRuntimeEnvelope(await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        sessionId: 'happy-session-hook-setup-reservation',
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    })).operations;

    try {
      const firstPrompt = runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => expect(sessionHooks.service.resolveForwarderAssets).toHaveBeenCalledTimes(1));
      const overlappingPrompt = runtime.sendTurnPrompt('overlapping prompt');
      releaseAssets?.();
      await firstPrompt;
      await expect(overlappingPrompt).resolves.toEqual({
        kind: 'rejected_before_effect',
        reason: 'Claude Agent SDK turn is already running.',
      });
      expect(exec.spawnClient).toHaveBeenCalledTimes(1);
    } finally {
      releaseAssets?.();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('waits for pending hook setup and prevents post-reset query launch', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    let releaseAssets: (() => void) | null = null;
    const assetsPending = new Promise<void>((resolve) => {
      releaseAssets = resolve;
    });
    sessionHooks.service.resolveForwarderAssets.mockImplementation(async () => {
      await assetsPending;
      return {
        nodeExecutable: '/bin/node',
        sessionForwarderScript: '/app/session_hook_forwarder.cjs',
        permissionForwarderScript: '/app/permission_hook_forwarder.cjs',
      };
    });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: sessionHooks.service,
    });
    const runtime = expectRuntimeEnvelope(await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        sessionId: 'happy-session-hook-setup-reset',
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    })).operations;

    try {
      const prompt = runtime.sendTurnPrompt('prompt racing reset');
      await vi.waitFor(() => expect(sessionHooks.service.resolveForwarderAssets).toHaveBeenCalledTimes(1));
      let resetSettled = false;
      const reset = runtime.resetOrDisposeRuntime().then(() => {
        resetSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(resetSettled).toBe(false);

      releaseAssets?.();
      await expect(prompt).resolves.toEqual({
        kind: 'rejected_before_effect',
        reason: 'Claude Agent SDK runtime is disposed.',
      });
      await reset;
      expect(exec.spawnClient).not.toHaveBeenCalled();
      expect(sessionHooks.service.disposePluginDir).toHaveBeenCalledWith('/tmp/happier-claude-hook-plugin');
      expect(sessionHooks.serverDispose).toHaveBeenCalledTimes(1);
    } finally {
      releaseAssets?.();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('waits for a re-keyed goal-tail follower to close during reset', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const follows: TranscriptFileFollowInputV1[] = [];
    let goalTailCloseDidStart = false;
    let releaseGoalTailClose: (() => void) | null = null;
    let markGoalTailCloseStarted: (() => void) | null = null;
    const goalTailClosePending = new Promise<void>((resolve) => {
      releaseGoalTailClose = resolve;
    });
    const goalTailCloseStarted = new Promise<void>((resolve) => {
      markGoalTailCloseStarted = resolve;
    });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: sessionHooks.service,
      sessionWriteMetadata: vi.fn(async () => undefined),
      transcripts: {
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async () => ({ id: 'claude-proof', dispose: vi.fn(async () => undefined) })),
        fileFollow: {
          follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
            follows.push(input);
            const index = follows.length - 1;
            return {
              id: `follow-${index}`,
              drainNow: vi.fn(async () => undefined),
              close: vi.fn(async () => {
                if (index !== 1) return;
                goalTailCloseDidStart = true;
                markGoalTailCloseStarted?.();
                await goalTailClosePending;
              }),
            };
          }),
        },
      },
    });
    const runtime = expectRuntimeEnvelope(await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        sessionId: 'happy-session-rekey-tail-reset',
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    })).operations;

    try {
      await runtime.sendTurnPrompt('prompt before compact');
      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
        onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
      }> | undefined;
      if (!hookRequest?.onSessionHook) throw new Error('Claude Agent SDK session hook server was not started');
      await hookRequest.onSessionHook('old-session', {
        hook_event_name: 'SessionStart',
        session_id: 'old-session',
        transcript_path: '/tmp/claude-project/old-session.jsonl',
      });
      await hookRequest.onSessionHook('old-session', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'old-session',
        prompt: 'prompt before compact',
      });
      const identityFollow = follows[0];
      if (!identityFollow) throw new Error('missing identity transcript follow');
      await identityFollow.onLine({
        line: JSON.stringify({
          type: 'user',
          uuid: 'old-session-row',
          timestamp: new Date().toISOString(),
          sessionId: 'old-session',
          message: { role: 'user', content: 'prompt before compact' },
        }),
        sourcePath: identityFollow.path,
        sequence: 1,
      });
      await vi.waitFor(() => expect(follows).toHaveLength(2));

      await hookRequest.onSessionHook('old-session', {
        hook_event_name: 'SessionStart',
        source: 'compact',
        session_id: 'old-session',
        transcript_path: '/tmp/claude-project/new-session.jsonl',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(goalTailCloseDidStart).toBe(true);
      await goalTailCloseStarted;
      let resetSettled = false;
      const reset = runtime.resetOrDisposeRuntime().then(() => {
        resetSettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(resetSettled).toBe(false);

      releaseGoalTailClose?.();
      await reset;
    } finally {
      releaseGoalTailClose?.();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('drains pending transcript proof before choosing continuity for the next turn', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const follows: TranscriptFileFollowInputV1[] = [];
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: sessionHooks.service,
      sessionWriteMetadata: vi.fn(async (request: Readonly<{
        handler: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
      }>) => { request.handler({ retained: true }); }),
      transcripts: {
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async () => ({ id: 'claude-proof', dispose: vi.fn(async () => undefined) })),
        fileFollow: {
          follow: vi.fn(async (input: TranscriptFileFollowInputV1) => {
            follows.push(input);
            return {
              id: `follow-${follows.length}`,
              drainNow: vi.fn(async () => {
                await input.onLine({
                  line: JSON.stringify({
                    type: 'user',
                    uuid: 'first-turn-row',
                    timestamp: new Date().toISOString(),
                    sessionId: 'first-session',
                    message: { role: 'user', content: 'first prompt' },
                  }),
                  sourcePath: input.path,
                  sequence: 1,
                });
              }),
              close: vi.fn(async () => undefined),
            };
          }),
        },
      },
    });
    const runtime = expectRuntimeEnvelope(await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        sessionId: 'happy-session-proof-drain',
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    })).operations;

    try {
      await runtime.sendTurnPrompt('first prompt');
      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
        onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
      }> | undefined;
      if (!hookRequest?.onSessionHook) throw new Error('Claude Agent SDK session hook server was not started');
      await hookRequest.onSessionHook('first-session', {
        hook_event_name: 'SessionStart',
        session_id: 'first-session',
        transcript_path: '/tmp/claude-project/first.jsonl',
      });
      await hookRequest.onSessionHook('first-session', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'first-session',
        prompt: 'first prompt',
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'first-session',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      await runtime.sendTurnPrompt('second prompt');

      expect(follows[0]?.startAt).toBe('end');
      expect(exec.spawnClient.mock.calls[1]?.[0].launch.args).toEqual(expect.arrayContaining([
        '--resume',
        'first-session',
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

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

  it('does not resume from authenticated identity until transcript continuity is proven', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionHooks: sessionHooks.service,
    });
    const runtime = expectRuntimeEnvelope(await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        sessionId: 'happy-session-unproven-resume',
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
      },
    })).operations;

    try {
      await runtime.sendTurnPrompt('first unproven prompt');
      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
        onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
      }> | undefined;
      if (!hookRequest?.onSessionHook) throw new Error('Claude Agent SDK session hook server was not started');
      await hookRequest.onSessionHook('authenticated-but-unproven', {
        hook_event_name: 'SessionStart',
        source: 'startup',
        session_id: 'authenticated-but-unproven',
        transcript_path: '/tmp/claude-project/authenticated-but-unproven.jsonl',
      });
      expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'authenticated-but-unproven' });

      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'authenticated-but-unproven',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();
      await expect(runtime.updateSessionRuntimeConfig({
        configOption: { id: 'context_usage_refresh', value: 1 },
      })).resolves.toMatchObject({ status: 'unsupported' });
      expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      await runtime.sendTurnPrompt('second prompt must remain fresh');

      expect(exec.spawnClient.mock.calls[1]?.[0].launch.args).not.toContain('--resume');
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
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

      await expect(runtime.sendTurnPrompt('second prompt')).resolves.toEqual({ kind: 'accepted' });

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

  it('retains stream-reported resume continuity for non-session execution runtimes', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
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

  it('normalizes an ambiguous SDK writeRecord failure as effect-possible Pending uncertainty', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const spawnClient = exec.spawnClient.getMockImplementation();
    if (!spawnClient) throw new Error('Claude SDK exec fixture omitted its spawn implementation');
    const writeRecord = vi.fn(async () => {
      throw new Error('write completion lost after transport attempt');
    });
    exec.spawnClient.mockImplementation(async (...args: unknown[]) => {
      const handle = await spawnClient(...args);
      return {
        ...handle,
        client: {
          ...handle.client,
          writeRecord,
        },
      };
    });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });
    const runtimeEnvelope = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      happierSessionId: 'happy-session-transport-uncertain',
    }));
    const settlements: unknown[] = [];
    runtimeEnvelope.nativeRuntime.setOnPromptDeliveryOutcome?.(
      createSessionProviderInputOutcomeNormalizer({
        getTarget: () => ({
          sessionId: 'happy-session-transport-uncertain',
          hasPendingProviderInput: (localId) => localId === 'pending-transport-uncertain',
          observeProviderInputSettlement: (outcome) => settlements.push(outcome),
        }),
      }),
    );

    try {
      await runtimeEnvelope.operations.sendTurnPrompt('ambiguous transport prompt', {
        localId: 'pending-transport-uncertain',
        userMessageSeq: 17,
      });

      await vi.waitFor(() => expect(writeRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user',
          message: { role: 'user', content: 'ambiguous transport prompt' },
        }),
        expect.any(Object),
      ));
      await vi.waitFor(() => expect(settlements).toEqual([
        expect.objectContaining({
          kind: 'effect_may_have_occurred',
          localId: 'pending-transport-uncertain',
          userMessageSeq: 17,
          issue: expect.objectContaining({
            code: 'claude_sdk_prompt_transport_ambiguous',
            severity: 'error',
          }),
        }),
      ]));
      expect(settlements).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'accepted' }),
        expect.objectContaining({ kind: 'rejected_before_effect' }),
      ]));
    } finally {
      await runtimeEnvelope.operations.resetOrDisposeRuntime().catch(() => undefined);
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
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
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
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        refreshAttemptId: expect.stringMatching(/^claude-auth-refresh-/u),
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
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        refreshAttemptId: expect.stringMatching(/^claude-auth-refresh-/u),
        reason: 'claude_agent_sdk_oauth_token_refresh',
        failingAccessTokenFingerprint: computeClaudeSubscriptionAccessTokenFingerprint('fresh-claude-access-token'),
      }, expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
      expect(refreshRuntimeAuth.mock.calls[1]?.[0].refreshAttemptId)
        .not.toBe(refreshRuntimeAuth.mock.calls[0]?.[0].refreshAttemptId);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reuses one refresh attempt for duplicate pending Claude SDK callbacks', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const refreshRuntimeAuth = vi.fn(async (request: { refreshAttemptId: string }) => ({
      status: 'pending' as const,
      refreshAttemptId: request.refreshAttemptId,
    }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionAuth: { services: { refreshRuntimeAuth } },
    });
    const selection = {
      kind: 'profile',
      serviceId: 'claude-subscription',
      profileId: 'profile-1',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    };
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: { HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([selection]) },
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
      await Promise.all([
        exec.emit({ type: 'control_request', request_id: 'oauth-refresh-duplicate-1', request: { subtype: 'oauth_token_refresh' } }),
        exec.emit({ type: 'control_request', request_id: 'oauth-refresh-duplicate-2', request: { subtype: 'oauth_token_refresh' } }),
      ]);

      expect(refreshRuntimeAuth).toHaveBeenCalledTimes(2);
      expect(refreshRuntimeAuth.mock.calls[0]?.[0].refreshAttemptId)
        .toMatch(/^claude-auth-refresh-/u);
      expect(refreshRuntimeAuth.mock.calls[1]?.[0].refreshAttemptId)
        .toBe(refreshRuntimeAuth.mock.calls[0]?.[0].refreshAttemptId);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('fails closed without an authoritative launch credential revision', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const refreshRuntimeAuth = vi.fn();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionAuth: { services: { refreshRuntimeAuth } },
    });
    const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'profile-1',
        }]),
      },
      permissionMode: 'default',
      happierSessionId: 'happy-session-1',
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('prompt');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
      expect(exec.spawnClient.mock.calls[0]?.[0].launch.env)
        .not.toHaveProperty('CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH');
      expect(refreshRuntimeAuth).not.toHaveBeenCalled();
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
    const runtimeActivityEvents: AgentSessionRuntimeEvent[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });
    runtime.subscribeCanonicalAgentSessionEvents((event) => runtimeActivityEvents.push(event));

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
        task_type: 'local_workflow',
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
      await expect(runtime.sendTurnPrompt('follow-up while background task is running')).resolves.toEqual({
        kind: 'accepted',
      });
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
        expect(runtimeActivityEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtime-activity-snapshot',
            state: 'active',
            activeCount: 1,
          }),
        ]));
        expect(runtimeActivityEvents.at(-1)).toEqual(expect.objectContaining({
          kind: 'runtime-activity-snapshot',
          state: 'idle',
          activeCount: 0,
        }));
      });
      expect(writeStateField).not.toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'runtime.activity' }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('clears runtime activity on killed task_updated and keeps duplicate task_notification inert', async () => {
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
    const runtimeActivityEvents: AgentSessionRuntimeEvent[] = [];
    runtime.subscribeCanonicalAgentSessionEvents((event) => runtimeActivityEvents.push(event));

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
        task_type: 'local_workflow',
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
        patch: { status: 'killed' },
      });

      await vi.waitFor(() => {
        expect(runtimeActivityEvents.at(-1)).toEqual(expect.objectContaining({
          state: 'idle',
          activeCount: 0,
        }));
      });
      const eventsAfterTaskUpdated = runtimeActivityEvents.length;

      await exec.emit({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
        status: 'completed',
      });

      expect(runtimeActivityEvents).toHaveLength(eventsAfterTaskUpdated);
      expect(runtimeActivityEvents.at(-1)).toEqual(expect.objectContaining({
        state: 'idle',
        activeCount: 0,
      }));
      expect(writeStateField).not.toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'runtime.activity' }));
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
    const runtimeActivityEvents: AgentSessionRuntimeEvent[] = [];
    runtime.subscribeCanonicalAgentSessionEvents((event) => runtimeActivityEvents.push(event));

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
        task_type: 'local_workflow',
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

      expect(runtimeActivityEvents.every((event) => event.kind !== 'runtime-activity-snapshot' || event.state !== 'active')).toBe(true);
      expect(writeStateField).not.toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'runtime.activity' }));
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
    const runtimeActivityEvents: AgentSessionRuntimeEvent[] = [];
    runtime.subscribeCanonicalAgentSessionEvents((event) => runtimeActivityEvents.push(event));

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
        task_type: 'local_workflow',
      });
      await exec.emit({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-replays-later',
        status: 'completed',
      });
      await vi.waitFor(() => {
        expect(runtimeActivityEvents.at(-1)).toEqual(expect.objectContaining({
          kind: 'runtime-activity-snapshot',
          state: 'idle',
          activeCount: 0,
        }));
      });

      writeStateField.mockClear();
      const eventsBeforeReplay = runtimeActivityEvents.length;
      await exec.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-replays-later',
        task_type: 'local_workflow',
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

      expect(runtimeActivityEvents.slice(eventsBeforeReplay).every(
        (event) => event.kind !== 'runtime-activity-snapshot' || event.state !== 'active',
      )).toBe(true);
      expect(writeStateField).not.toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'runtime.activity' }));
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
    const runtimeActivityEvents: AgentSessionRuntimeEvent[] = [];
    runtime.subscribeCanonicalAgentSessionEvents((event) => runtimeActivityEvents.push(event));

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

      expect(runtimeActivityEvents.every((event) => event.kind !== 'runtime-activity-snapshot' || event.state !== 'active')).toBe(true);
      expect(writeStateField).not.toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'runtime.activity' }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('preserves stale affirmative provider truth when a foreground result has no terminal evidence', async () => {
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
    const runtimeActivityEvents: AgentSessionRuntimeEvent[] = [];
    runtime.subscribeCanonicalAgentSessionEvents((event) => runtimeActivityEvents.push(event));

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
        task_type: 'local_workflow',
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
        expect(runtimeActivityEvents.some((event) => (
          event.kind === 'runtime-activity-snapshot'
          && event.state === 'active'
          && event.activeCount === 1
        ))).toBe(true);
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
        expect(runtimeActivityEvents.at(-1)).toEqual(expect.objectContaining({
          kind: 'runtime-activity-snapshot',
          state: 'active',
          activeCount: 1,
        }));
      });
      expect(writeStateField).not.toHaveBeenCalledWith(expect.objectContaining({ fieldId: 'runtime.activity' }));
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

  it('redacts an exact runtime provider credential from SDK process diagnostics', async () => {
    const credential = 'claude provider credential with spaces !';
    const lease = registerSensitiveDiagnosticValues([credential]);
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
        stderr: `provider rejected ${credential}`,
      });

      await expect(completion).rejects.toThrow(/provider rejected \[REDACTED\]/u);
      await expect(completion).rejects.not.toThrow(credential);
    } finally {
      lease.close();
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

    await expect(runtime.startProviderSession({ resumeId: 'requested-claude-session' }))
      .resolves
      .toBeNull();
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: null });
    expect(writeStateField).not.toHaveBeenCalled();
  });

  it('does not allow Claude SDK stream messages to re-key a session-bound runtime', async () => {
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
      await runtime.startProviderSession({ resumeId: 'requested-claude-session' });
      await runtime.sendTurnPrompt('first prompt');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-provider-session-1',
      });
      expect(writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'identity.providerSessionId')).toHaveLength(0);
      expect(runtime.readSessionIdentity()).toEqual({ sessionId: null });

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
        .filter((request) => request?.fieldId === 'identity.providerSessionId')).toHaveLength(0);
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

  it.each([
    { label: 'create', initialProviderSessionId: null },
    { label: 'resume', initialProviderSessionId: 'provider-session-resume' },
  ])('omits unsupported effort controls from the first SDK query for $label', async ({ initialProviderSessionId }) => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });
    const operations = createClaudeAgentSdkProviderOperations({
      ctx,
      directory: '/tmp/claude-project',
      launchEnv: {},
      permissionMode: 'default',
      supportsEffort: false,
      initialModelId: 'claude-opus-4-8',
      initialEffort: 'xhigh',
      initialUltracode: true,
      initialProviderSessionId,
    });

    try {
      await expect(operations.updateProviderConfiguration({
        configOption: { id: 'reasoning_effort', value: 'xhigh' },
      })).resolves.toMatchObject({ status: 'unsupported' });
      await operations.sendProviderTurnPrompt('first prompt');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));

      const args = exec.spawnClient.mock.calls[0]?.[0].launch.args as string[];
      expect(args).not.toContain('--effort');
      expect(args.join(' ')).not.toContain('ultracode');
    } finally {
      await operations.cancelProviderTurn('test_complete').catch(() => undefined);
      await operations.disposeProviderSession('test_complete').catch(() => undefined);
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

  it('publishes exactly one canonical terminal event for every accepted SDK turn outcome', async () => {
    const terminalKinds = new Set(['turn-complete', 'turn-failed', 'turn-cancelled']);

    const runResultError = async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const exec = createSdkExecFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, { exec: exec.service });
      const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        launchEnv: {},
        permissionMode: 'default',
        happierSessionId: 'happy-session-result-error',
        publishSdkMessages: true,
        publishTranscriptMessages: true,
      })).operations;
      const runtimeEvents: Array<{ kind: string }> = [];
      runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
      try {
        runtime.beginTurnLifecycle();
        await runtime.sendTurnPrompt('result error');
        await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
        const completion = runtime.waitForTurnCompletion();
        await exec.emit({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'claude-provider-session-result-error',
          errors: ['provider failed'],
          num_turns: 1,
          total_cost_usd: 0,
          duration_ms: 10,
          duration_api_ms: 8,
        });
        await expect(completion).rejects.toThrow();
        return runtimeEvents.filter((event) => terminalKinds.has(event.kind));
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    };

    const runSuccess = async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const exec = createSdkExecFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, { exec: exec.service });
      const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        launchEnv: {},
        permissionMode: 'default',
        happierSessionId: 'happy-session-success',
        publishSdkMessages: true,
        publishTranscriptMessages: true,
      })).operations;
      const runtimeEvents: Array<{ kind: string }> = [];
      runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
      try {
        runtime.beginTurnLifecycle();
        await runtime.sendTurnPrompt('success');
        await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
        await exec.emit({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'claude-provider-session-success',
          result: 'done',
          num_turns: 1,
          total_cost_usd: 0,
          duration_ms: 10,
          duration_api_ms: 8,
        });
        await runtime.waitForTurnCompletion();
        return runtimeEvents.filter((event) => terminalKinds.has(event.kind));
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    };

    const runCancellation = async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const exec = createSdkExecFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, { exec: exec.service });
      const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        launchEnv: {},
        permissionMode: 'default',
        happierSessionId: 'happy-session-cancelled',
        publishTranscriptMessages: true,
      })).operations;
      const runtimeEvents: Array<{ kind: string }> = [];
      runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
      try {
        runtime.beginTurnLifecycle();
        await runtime.sendTurnPrompt('cancel me');
        await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
        const completion = runtime.waitForTurnCompletion();
        await runtime.cancelTurn();
        await expect(completion).rejects.toThrow();
        return runtimeEvents.filter((event) => terminalKinds.has(event.kind));
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    };

    const runExit = async (exitCode: number) => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const exec = createSdkExecFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, { exec: exec.service });
      const runtime = expectRuntimeEnvelope(createClaudeAgentSdkTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        launchEnv: {},
        permissionMode: 'default',
        happierSessionId: `happy-session-exit-${exitCode}`,
        publishTranscriptMessages: true,
      })).operations;
      const runtimeEvents: Array<{ kind: string }> = [];
      runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
      try {
        runtime.beginTurnLifecycle();
        await runtime.sendTurnPrompt(`exit ${exitCode}`);
        await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
        const completion = runtime.waitForTurnCompletion();
        await exec.exitWith({ exitCode, signal: null, stderr: exitCode === 0 ? '' : 'unexpected exit' });
        await expect(completion).rejects.toThrow();
        return runtimeEvents.filter((event) => terminalKinds.has(event.kind));
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    };

    await expect(runSuccess()).resolves.toEqual([expect.objectContaining({ kind: 'turn-complete' })]);
    await expect(runResultError()).resolves.toEqual([expect.objectContaining({ kind: 'turn-failed' })]);
    await expect(runExit(0)).resolves.toEqual([expect.objectContaining({ kind: 'turn-failed' })]);
    await expect(runExit(1)).resolves.toEqual([expect.objectContaining({ kind: 'turn-failed' })]);
    await expect(runCancellation()).resolves.toEqual([expect.objectContaining({ kind: 'turn-cancelled' })]);
  });
});
