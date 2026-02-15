import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
  sessionRpcWithServerScope: vi.fn(),
}));

describe('DaemonVoiceAgentClient', () => {
  beforeEach(async () => {
    const { sessionRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc');
    vi.mocked(sessionRpcWithServerScope).mockReset();
  });

  it('throws RPC errors with rpcErrorCode for fallback handling', async () => {
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
        permissionPolicy: 'read_only',
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
        permissionPolicy: 'read_only',
        idleTtlSeconds: 300,
        initialContext: 'ctx',
        existingRunId: 'run_old',
        retentionPolicy: 'resumable',
      }),
    ).resolves.toEqual({ voiceAgentId: 'run_1' });

    expect(vi.mocked(sessionRpcWithServerScope)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        method: expect.stringMatching(/execution\.run\.ensureOrStart/i),
        payload: expect.objectContaining({
          runId: 'run_old',
          resume: true,
          start: expect.objectContaining({
            intent: 'voice_agent',
            backendId: 'codex',
            retentionPolicy: 'resumable',
            ioMode: 'streaming',
          }),
        }),
      }),
    );
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
        permissionPolicy: 'read_only',
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
});
