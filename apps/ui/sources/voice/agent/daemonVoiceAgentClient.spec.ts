import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol';
import { createSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { installVoiceAgentCommonModuleMocks } from './voiceAgentTestHelpers';
import { createMachineFixture, createSessionFixture } from '@/dev/testkit';

const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerAccountScope: vi.fn(),
}));

const settingsState: { current: any } = {
  current: {
    voice: {
      providerId: 'local_conversation',
      providers: {
        local_conversation: { schemaVersion: 1, config: {
          streaming: {
            enabled: false,
            turnReadPollIntervalMs: 25,
            turnReadMaxEvents: 64,
            turnStreamTimeoutMs: 300000,
          },
          networkTimeoutMs: 15000,
        } },
      },
    },
  },
};

installVoiceAgentCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => {
          const machine = createMachineFixture({ id: 'machine-1' });
          return { settings: settingsState.current,
            sessions: { s1: createSessionFixture({ id: 's1', serverId: 'server-a', active: true,
              metadata: { machineId: machine.id, path: '/work' } }) },
            machines: { [machine.id]: machine }, machineListByServerId: { 'server-a': [machine] } };
        },
      },
    });
  },
});

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ state: 'resolved'; value: T } | { state: 'rejected'; reason: unknown } | { state: 'pending' }> {
  return await Promise.race([
    promise.then(
      (value) => ({ state: 'resolved', value } as const),
      (reason) => ({ state: 'rejected', reason } as const),
    ),
    sleep(timeoutMs).then(() => ({ state: 'pending' } as const)),
  ]);
}

describe('DaemonVoiceAgentClient', () => {
  it('starts an inherited Voice choice through safe ensure/start without an inheritance capability', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    machineRpc.mockResolvedValue({ protocolVersion: 1, results: { 'tool.executionRuns': { ok: true, checkedAt: 1,
      data: { protocolVersion: 2, features: { detachedScope: true, startAndWait: true } } } } });
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValue({ ok: true, runId: 'run_inherited', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await expect(new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' }).start({
      sessionId: 's1', agentSource: 'session', agentId: 'codex', permissionIntent: 'read-only',
      idleTtlSeconds: 300, initialContext: 'ctx',
    })).resolves.toEqual({ voiceAgentId: 'run_inherited' });
    expect(vi.mocked(sessionRpcWithServerAccountScope).mock.calls[0]?.[0]).toMatchObject({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
      payload: { runId: null, resume: true, start: { intent: 'voice_agent' } },
    });
  });
  it('carries a custom native Voice chat choice as an exact explicit model tuple', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_native', created: true });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' }).start({
      sessionId: 's1', agentSource: 'session', agentId: 'codex', chatModelId: 'custom-chat',
      permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'ctx',
    });
    expect(vi.mocked(sessionRpcWithServerAccountScope).mock.calls[0]?.[0].payload).toMatchObject({ start: {
      modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'custom-chat' },
    } });
  });

  beforeEach(async () => {
    machineRpc.mockReset();
    machineRpc.mockResolvedValue({ protocolVersion: 1, results: { 'tool.executionRuns': { ok: true, checkedAt: 1,
      data: { protocolVersion: 2, features: { detachedScope: true, startAndWait: true } } } } });
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockReset();
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: {
              enabled: false,
              turnReadPollIntervalMs: 25,
              turnReadMaxEvents: 64,
              turnStreamTimeoutMs: 300000,
            },
            networkTimeoutMs: 15000,
          } },
        },
      },
    };
  });

  it.each(['  Greeting.\n ', ' \n ', ''])('keeps explicitly admitted greeting bytes in the daemon request: %j', async welcomeText => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, result: { assistantText: 'welcome' } });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    await new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' })
      .welcome({ sessionId: 'history', voiceAgentId: 'run', welcomeText });
    expect(vi.mocked(sessionRpcWithServerAccountScope).mock.calls[0]?.[0].payload).toMatchObject({
      actionId: 'voice_agent.welcome', input: { welcomeText },
    });
  });

  it('throws RPC errors with rpcErrorCode from ensureOrStart', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: false, error: 'unsupported', errorCode: 'VOICE_AGENT_UNSUPPORTED' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'codex',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toMatchObject({ message: 'unsupported', rpcErrorCode: 'VOICE_AGENT_UNSUPPORTED' });
  });

  it.each([undefined, '', '   '])('rejects missing or blank agentId before RPC (%s)', async (agentId) => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'session',
        ...(agentId === undefined ? {} : { agentId }),
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toMatchObject({
      message: 'voice_agent_selection_unavailable',
      code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
    });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).not.toHaveBeenCalled();
  });

  it('uses the exact-selection ensureOrStart method when starting a daemon voice agent', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'codex',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        commitIsolation: true,
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
        existingRunId: 'run_old',
        retentionPolicy: 'resumable',
      }),
    ).resolves.toEqual({ voiceAgentId: 'run_1' });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
        payload: expect.objectContaining({
          runId: 'run_old',
          resume: true,
          start: expect.objectContaining({
            intent: 'voice_agent',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            retentionPolicy: 'resumable',
            ioMode: 'streaming',
            commitIsolation: true,
          }),
        }),
      }),
    );
  });

  it('carries independent chat and commit Provider selections without endpoint or secret material', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_provider', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      providerConnectionId: 'voice-openai-compatible-chat',
      modelId: 'chat-model',
    });
    const commitModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      providerConnectionId: 'voice-openai-compatible-chat',
      modelId: 'commit-model',
    });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'opencode',
      verbosity: 'short',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      chatModelSelection,
      commitModelSelection,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 0,
        overrides: { temperature: { updatedAt: 0, value: 0.2 } },
      },
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    });

    const call = vi.mocked(sessionRpcWithServerAccountScope).mock.calls[0]?.[0] as any;
    expect(call.method).toBe(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1);
    expect(call.payload.start).toMatchObject({
      modelId: 'chat-model',
      modelSelection: chatModelSelection,
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      intentInput: { commitModelSelection },
      sessionConfigOptionOverrides: {
        overrides: { temperature: { value: 0.2 } },
      },
    });
    expect(JSON.stringify(call.payload.start)).not.toMatch(/baseUrl|apiKey|secret/i);
  });

  it.each(['chat', 'commit'] as const)(
    'uses the current-only Provider-safe ensureOrStart method for a Provider-bound %s selection',
    async (role) => {
      const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
      vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: `run_${role}`, created: true } as any);

      const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
      const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
      const providerSelection = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
        providerConnectionId: 'voice-openai-compatible-chat',
        modelId: `${role}-model`,
      });

      await client.start({
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'opencode',
        verbosity: 'short',
        chatModelId: role === 'chat' ? providerSelection.modelId : 'native-chat',
        commitModelId: role === 'commit' ? providerSelection.modelId : 'native-commit',
        ...(role === 'chat'
          ? { chatModelSelection: providerSelection }
          : { commitModelSelection: providerSelection }),
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      });

      expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(expect.objectContaining({
        method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
      }));
    },
  );

  it('protects exact native model selections with the actual Session host method', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_native', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'backend:codex',
      providerConnectionId: null,
      modelId: 'chat-model',
    });
    const commitModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'backend:codex',
      providerConnectionId: null,
      modelId: 'commit-model',
    });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      chatModelSelection,
      commitModelSelection,
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
    }));
  });

  it('forwards replay seed requests through the ensureOrStart start payload', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sys_voice',
        transcriptEpoch: 3,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 12,
        summaryRunner: {
          v: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default',
          permissionMode: 'no_tools',
        },
      },
    } as any);

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          start: expect.objectContaining({
            replay: expect.objectContaining({
              kind: 'voice_session.v1',
              previousSessionId: 'sys_voice',
              transcriptEpoch: 3,
              strategy: 'summary_plus_recent',
              recentMessagesCount: 12,
            }),
          }),
        }),
      }),
    );
  });

  it('uses an unbounded acknowledgement lifetime for ensureOrStart', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'claude',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: null,
      }),
    );
  });

  it('keeps an explicit provider bootstrap budget separate from the acknowledgement lifetime', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'claude',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
      bootstrapTimeoutMs: 90_000,
    });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: null,
        payload: expect.objectContaining({
          start: expect.objectContaining({ bootstrapTimeoutMs: 90_000 }),
        }),
      }),
    );
  });

  it('uses an unbounded acknowledgement lifetime for Voice action and stream lifecycle RPCs', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockImplementation(async ({ method, payload }: any) => {
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) {
        return payload.actionId === 'voice_agent.welcome'
          ? { ok: true, result: { assistantText: 'welcome' } }
          : { ok: true, result: { commitText: 'commit' } };
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) return { streamId: 'stream-v1' };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) return { streamId: 'stream-v2' };
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return { ok: true };
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
    await client.welcome({ sessionId: 's1', voiceAgentId: 'run-1' });
    await client.commit({ sessionId: 's1', voiceAgentId: 'run-1', kind: 'session_instruction' });
    await client.startTurnStream({ sessionId: 's1', voiceAgentId: 'run-1', userText: 'v1' });
    await client.startTurnStream({
      sessionId: 's1',
      voiceAgentId: 'run-1',
      userText: 'v2',
      userTranscript: { mode: 'persist', localId: 'local-1' },
    });
    await client.cancelTurnStream({ sessionId: 's1', voiceAgentId: 'run-1', streamId: 'stream-v2' });

    expect(vi.mocked(sessionRpcWithServerAccountScope).mock.calls.map(([call]) => ({
      method: call.method,
      timeoutMs: call.timeoutMs,
    }))).toEqual([
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2, timeoutMs: null },
      { method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, timeoutMs: null },
    ]);
  });

  it('admits the configured speech latency target on the real streamed turn request', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    const { ExecutionRunTurnStreamStartRequestSchema } = await import('@happier-dev/protocol');
    settingsState.current.voice.providers.local_conversation.config.streaming.ttsChunkChars = 120;
    let admittedTarget: unknown;
    vi.mocked(sessionRpcWithServerAccountScope).mockImplementation(async ({ method, payload }) => {
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
        admittedTarget = ExecutionRunTurnStreamStartRequestSchema.parse(payload).speechSegmentTargetChars;
        return { streamId: 'target-stream' };
      }
      return {
        streamId: 'target-stream', nextCursor: 1, done: true,
        events: [{ t: 'voice_output', output: { v: 1, kind: 'turn_final', turnId: 'target-stream', seq: 0, text: 'Done.' } }],
      };
    });
    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
    await expect(client.sendTurn({ sessionId: 's1', voiceAgentId: 'run-1', userText: 'go' }))
      .resolves.toMatchObject({ assistantText: 'Done.' });
    expect(admittedTarget).toBe(120);
  });

  it('keeps default native resets distinct from omitted inherited model choices', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'default',
      commitModelId: 'default',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          start: expect.objectContaining({ modelSelection: null, commitModelId: 'default' }),
        }),
      }),
    );
    const payload = vi.mocked(sessionRpcWithServerAccountScope).mock.calls[0]?.[0].payload;
    expect(payload).toMatchObject({ start: expect.not.objectContaining({ chatModelId: expect.anything() }) });
  });

  it('surfaces an acknowledgement timeout as outcome-unknown without retrying ensureOrStart', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope)
      .mockRejectedValueOnce(createSocketIoAckTimeoutError())
      .mockResolvedValueOnce({ ok: true, runId: 'run_retry', created: true } as any);

    const { DaemonVoiceAgentClient, VoiceAgentStartOutcomeUnknownError } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    const error = await client.start({
      sessionId: 's1',
      agentSource: 'agent',
      agentId: 'codex',
      verbosity: 'short',
      chatModelId: 'fast',
      commitModelId: 'fast',
      permissionIntent: 'read-only',
      idleTtlSeconds: 300,
      initialContext: 'ctx',
    }).catch((caught: unknown) => caught);

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(VoiceAgentStartOutcomeUnknownError);
    expect(error).toMatchObject({
      code: 'VOICE_AGENT_START_OUTCOME_UNKNOWN',
      message: 'Voice agent start acknowledgement was not received; outcome is unknown',
    });
  });

  it('forwards displayUserText separately from the execution payload when starting a turn stream', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ streamId: 'stream-1' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(
      client.startTurnStream({
        sessionId: 'session-1',
        voiceAgentId: 'run-1',
        userText: 'Context updates since your last voice turn:\n\nSession asks a question.\n\nUser said:\nCreate the file.',
        displayUserText: 'Create the file.',
      } as any),
    ).resolves.toEqual({ streamId: 'stream-1' });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
        payload: expect.objectContaining({
          runId: 'run-1',
          message: expect.stringContaining('Context updates since your last voice turn'),
          displayMessage: 'Create the file.',
        }),
      }),
    );
  });

  it('uses v2 for explicit transcript custody and preserves the opaque local id', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ streamId: 'stream-1' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await client.startTurnStream({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      userText: 'Outer prompt',
      userTranscript: { mode: 'persist', localId: ' opaque-local-id ' },
    });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      payload: expect.objectContaining({
        userTranscript: { mode: 'persist', localId: ' opaque-local-id ' },
      }),
    }));
  });

  it('fails closed when v2 is unavailable without retrying legacy v1', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(client.startTurnStream({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      userText: 'Outer prompt',
      userTranscript: { mode: 'persist', localId: 'opaque-local-id' },
    })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledTimes(1);
  });

  it('commits a direct-shortcut user transcript with the exact caller local id', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(client.commitUserTranscript({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      text: 'Approve it.',
      displayText: 'Approve the requested action.',
      localId: ' opaque-shortcut-id ',
    })).resolves.toEqual({ ok: true });

    // Current writer consumed by the prospective predecessor reader at
    // ../remote-dev@0649e4de85aacf08476063fef1990f418ce8e80b:
    // apps/cli/src/rpc/handlers/executionRuns.ts.
    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_USER_TRANSCRIPT_COMMIT_V1,
      payload: {
        runId: 'run-1',
        message: 'Approve it.',
        displayMessage: 'Approve the requested action.',
        localId: ' opaque-shortcut-id ',
      },
    }));
  });

  it('fails Provider-bound start closed when the current-only method is unavailable without falling back', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }),
    );

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      providerConnectionId: 'voice-openai-compatible-chat',
      modelId: 'fast',
    });

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'agent',
        agentId: 'opencode',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        chatModelSelection,
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toMatchObject({ message: 'RPC method not available', rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });

    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionRpcWithServerAccountScope)).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
    }));
  });

  it('throws invalid_rpc_response for malformed start payloads', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ runId: 123 } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'session',
        agentId: 'codex',
        verbosity: 'short',
        chatModelId: 'fast',
        commitModelId: 'fast',
        permissionIntent: 'read-only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
      }),
    ).rejects.toThrow('invalid_rpc_response');
  });

  it('returns commitText from execution.run.action result payloads', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ ok: true, result: { commitText: 'c1' } } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });
    await expect(
      client.commit({ sessionId: 's1', voiceAgentId: 'run_1', kind: 'session_instruction' }),
    ).resolves.toEqual({ commitText: 'c1' });
  });

  it('throws invalid_rpc_response for malformed stream read payloads', async () => {
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockResolvedValueOnce({ streamId: 's1', events: 'bad' as any, nextCursor: 1, done: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    await expect(
      client.readTurnStream({
        sessionId: 'session-1',
        voiceAgentId: 'm1',
        streamId: 'stream-1',
        cursor: 0,
      }),
    ).rejects.toThrow('invalid_rpc_response');
  });

  it('sendTurn respects configured turnStreamTimeoutMs (not a hard-coded 30s)', async () => {
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: {
              enabled: false,
              turnReadPollIntervalMs: 10,
              turnReadMaxEvents: 64,
              turnStreamTimeoutMs: 1000,
            },
            networkTimeoutMs: 15000,
          } },
        },
      },
    };

    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerAccountScope).mockImplementation(async (args: any) => {
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
        return { streamId: 'stream-1' } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        return { streamId: 'stream-1', events: [], nextCursor: 0, done: false } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
        return { ok: true } as any;
      }
      throw new Error(`unexpected rpc method: ${String(args?.method ?? '')}`);
    });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    const sendPromise = client.sendTurn({ sessionId: 'session-1', voiceAgentId: 'm1', userText: 'hello' });
    const outcome = await settleWithin(sendPromise, 1300);

    expect(outcome.state).toBe('rejected');
    expect(String(outcome.state === 'rejected' ? (outcome.reason as any)?.message ?? outcome.reason : '')).toContain(
      'stream_timeout',
    );
  });

  it('sendTurn aborts the in-flight turn and cancels the daemon stream when the signal fires', async () => {
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: {
              enabled: false,
              turnReadPollIntervalMs: 10,
              turnReadMaxEvents: 64,
              turnStreamTimeoutMs: null,
            },
            networkTimeoutMs: 15000,
          } },
        },
      },
    };

    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    let cancelCalled = false;
    vi.mocked(sessionRpcWithServerAccountScope).mockImplementation(async (args: any) => {
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
        return { streamId: 'stream-1' } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        return { streamId: 'stream-1', events: [], nextCursor: 0, done: false } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
        cancelCalled = true;
        return { ok: true } as any;
      }
      throw new Error(`unexpected rpc method: ${String(args?.method ?? '')}`);
    });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    const controller = new AbortController();
    const sendPromise = client.sendTurn({
      sessionId: 'session-1',
      voiceAgentId: 'm1',
      userText: 'hello',
      signal: controller.signal,
    });

    const halfway = await settleWithin(sendPromise, 40);
    expect(halfway.state).toBe('pending');

    controller.abort();

    const outcome = await settleWithin(sendPromise, 300);
    expect(outcome.state).toBe('rejected');
    expect(String(outcome.state === 'rejected' ? (outcome.reason as any)?.name ?? '' : '')).toBe('AbortError');
    expect(cancelCalled).toBe(true);
  });

  it('sendTurn does not fall back to networkTimeoutMs when turnStreamTimeoutMs is null', async () => {
    settingsState.current = {
      voice: {
        providerId: 'local_conversation',
        providers: {
          local_conversation: { schemaVersion: 1, config: {
            streaming: {
              enabled: false,
              turnReadPollIntervalMs: 10,
              turnReadMaxEvents: 64,
              turnStreamTimeoutMs: null,
            },
            networkTimeoutMs: 25,
          } },
        },
      },
    };

    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    let readCount = 0;
    vi.mocked(sessionRpcWithServerAccountScope).mockImplementation(async (args: any) => {
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
        return { streamId: 'stream-1' } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        readCount += 1;
        if (readCount >= 8) {
          return {
            streamId: 'stream-1',
            events: [{ t: 'done', assistantText: 'ok', actions: [] }],
            nextCursor: readCount,
            done: true,
          } as any;
        }
        return { streamId: 'stream-1', events: [], nextCursor: readCount, done: false } as any;
      }
      if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
        return { ok: true } as any;
      }
      throw new Error(`unexpected rpc method: ${String(args?.method ?? '')}`);
    });

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

    const sendPromise = client.sendTurn({ sessionId: 'session-1', voiceAgentId: 'm1', userText: 'hello' });

    const halfway = await settleWithin(sendPromise, 40);
    expect(halfway.state).toBe('pending');

    const outcome = await settleWithin(sendPromise, 300);
    expect(outcome.state).toBe('resolved');
    expect(outcome.state === 'resolved' ? outcome.value : null).toEqual({ assistantText: 'ok', actions: [] });
    expect(readCount).toBeGreaterThanOrEqual(8);
  });

  it('sendTurn supports very long turnStreamTimeoutMs values (not clamped to 10min)', async () => {
    vi.useFakeTimers();
    try {
      settingsState.current = {
        voice: {
          providerId: 'local_conversation',
          providers: {
            local_conversation: { schemaVersion: 1, config: {
              streaming: {
                enabled: false,
                turnReadPollIntervalMs: 500,
                turnReadMaxEvents: 64,
                turnStreamTimeoutMs: 900_000,
              },
              networkTimeoutMs: 15000,
            } },
          },
        },
      };

      const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
      const { sessionRpcWithServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
      vi.mocked(sessionRpcWithServerAccountScope).mockImplementation(async (args: any) => {
        if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) {
          return { streamId: 'stream-1' } as any;
        }
        if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
          return { streamId: 'stream-1', events: [], nextCursor: 0, done: false } as any;
        }
        if (args?.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
          return { ok: true } as any;
        }
        throw new Error(`unexpected rpc method: ${String(args?.method ?? '')}`);
      });

      const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
      const client = new DaemonVoiceAgentClient({ serverId: 'server-a', accountId: 'account-a' });

      let settled = false;
      let rejected: unknown = null;
      client.sendTurn({ sessionId: 'session-1', voiceAgentId: 'm1', userText: 'hello' }).then(
        () => {
          settled = true;
        },
        (err: unknown) => {
          settled = true;
          rejected = err;
        },
      );

      await vi.advanceTimersByTimeAsync(650_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(300_000);
      expect(settled).toBe(true);
      expect(String((rejected as any)?.message ?? rejected)).toContain('stream_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

});
