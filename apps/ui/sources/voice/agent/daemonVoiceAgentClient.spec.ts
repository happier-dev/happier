import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol';
import { installVoiceAgentCommonModuleMocks } from './voiceAgentTestHelpers';

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: vi.fn(),
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
        getState: () => ({ settings: settingsState.current }),
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
  beforeEach(async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockReset();
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

  it('throws RPC errors with rpcErrorCode from ensureOrStart', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: false, error: 'unsupported', errorCode: 'VOICE_AGENT_UNSUPPORTED' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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

  it('uses execution.run.ensureOrStart when starting a daemon voice agent', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
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
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: 'run_provider', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'backend:opencode',
      providerConnectionId: 'voice-openai-compatible-chat',
      modelId: 'chat-model',
    });
    const commitModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'backend:opencode',
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

    const call = vi.mocked(sessionRpcWithServerScope).mock.calls[0]?.[0] as any;
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
      const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
      vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: `run_${role}`, created: true } as any);

      const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
      const client = new DaemonVoiceAgentClient();
      const providerSelection = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'backend:opencode',
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

      expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(expect.objectContaining({
        method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
      }));
    },
  );

  it('keeps native model selections on the legacy-compatible ensureOrStart method', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: 'run_native', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();
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

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
    }));
  });

  it('forwards replay seed requests through the ensureOrStart start payload', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(
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

  it('uses a startup RPC timeout aligned with the voice bootstrap timeout for ensureOrStart', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 60_000,
      }),
    );
  });

  it('honors an explicit bootstrap timeout when it exceeds the network timeout', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 90_000,
      }),
    );
  });

  it('omits default sentinel model ids from the ensureOrStart start payload', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, runId: 'run_1', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          start: expect.not.objectContaining({
            chatModelId: expect.anything(),
            commitModelId: expect.anything(),
          }),
        }),
      }),
    );
  });

  it('retries execution.run.ensureOrStart once when the initial RPC times out', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope)
      .mockRejectedValueOnce(new Error('operation has timed out'))
      .mockResolvedValueOnce({ ok: true, runId: 'run_retry', created: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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
    ).resolves.toEqual({ voiceAgentId: 'run_retry' });

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledTimes(2);
  });

  it('forwards displayUserText separately from the execution payload when starting a turn stream', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ streamId: 'stream-1' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

    await expect(
      client.startTurnStream({
        sessionId: 'session-1',
        voiceAgentId: 'run-1',
        userText: 'Context updates since your last voice turn:\n\nSession asks a question.\n\nUser said:\nCreate the file.',
        displayUserText: 'Create the file.',
      } as any),
    ).resolves.toEqual({ streamId: 'stream-1' });

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(
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
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ streamId: 'stream-1' } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

    await client.startTurnStream({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      userText: 'Outer prompt',
      userTranscript: { mode: 'persist', localId: ' opaque-local-id ' },
    });

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(expect.objectContaining({
      method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      payload: expect.objectContaining({
        userTranscript: { mode: 'persist', localId: ' opaque-local-id ' },
      }),
    }));
  });

  it('fails closed when v2 is unavailable without retrying legacy v1', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), {
        rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      }),
    );

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

    await expect(client.startTurnStream({
      sessionId: 'session-1',
      voiceAgentId: 'run-1',
      userText: 'Outer prompt',
      userTranscript: { mode: 'persist', localId: 'opaque-local-id' },
    })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledTimes(1);
  });

  it('commits a direct-shortcut user transcript with the exact caller local id', async () => {
    const { SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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
    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(expect.objectContaining({
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
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockRejectedValueOnce(
      Object.assign(new Error('RPC method not available'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }),
    );

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: 'backend:opencode',
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

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(expect.objectContaining({
      // Prospective predecessor basis: ../remote-dev@a313378db62c559f24dabebe72ddcf17e0497e6f
      // exposes only execution.run.ensureOrStart, so this exact current-only method fails closed.
      method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1,
    }));
  });

  it('throws invalid_rpc_response for malformed start payloads', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ runId: 123 } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

    await expect(
      client.start({
        sessionId: 's1',
        agentSource: 'session',
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
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ ok: true, result: { commitText: 'c1' } } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();
    await expect(
      client.commit({ sessionId: 's1', voiceAgentId: 'run_1', kind: 'session_instruction' }),
    ).resolves.toEqual({ commitText: 'c1' });
  });

  it('throws invalid_rpc_response for malformed stream read payloads', async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockResolvedValueOnce({ streamId: 's1', events: 'bad' as any, nextCursor: 1, done: true } as any);

    const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');
    const client = new DaemonVoiceAgentClient();

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
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockImplementation(async (args: any) => {
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
    const client = new DaemonVoiceAgentClient();

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
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    let cancelCalled = false;
    vi.mocked(sessionRpcWithServerScope).mockImplementation(async (args: any) => {
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
    const client = new DaemonVoiceAgentClient();

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
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    let readCount = 0;
    vi.mocked(sessionRpcWithServerScope).mockImplementation(async (args: any) => {
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
    const client = new DaemonVoiceAgentClient();

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
      const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
      vi.mocked(sessionRpcWithServerScope).mockImplementation(async (args: any) => {
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
      const client = new DaemonVoiceAgentClient();

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
