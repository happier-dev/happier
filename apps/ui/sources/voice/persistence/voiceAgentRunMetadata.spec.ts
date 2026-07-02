import { beforeEach, describe, expect, it, vi } from 'vitest';

const patchSessionMetadataWithRetry = vi.fn();

const stateRef = {
    current: {
        sessions: {
            sys_voice: {
                id: 'sys_voice',
                serverId: 'server-1',
                updatedAt: 10,
                metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
            },
            s1: { id: 's1', serverId: 'server-1', updatedAt: 1, metadata: { flavor: 'claude' } },
        },
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
    } as any,
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => stateRef.current,
        } as any,
    });
});

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: (sessionId: string, updater: (m: any) => any) =>
      patchSessionMetadataWithRetry(sessionId, updater),
  },
}));

describe('voiceAgentRunMetadata', () => {
  const claudeTarget = { kind: 'builtInAgent', agentId: 'claude' } as const;
  const codexTarget = { kind: 'builtInAgent', agentId: 'codex' } as const;
  const claudeBackendTarget = { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' } as const;
  const codexBackendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;

  beforeEach(() => {
    vi.resetModules();
    patchSessionMetadataWithRetry.mockReset();
    stateRef.current = {
        ...stateRef.current,
        sessions: {
            ...stateRef.current.sessions,
            sys_voice: {
                ...stateRef.current.sessions.sys_voice,
                metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
            },
        },
        sessionListRenderables: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
    };
  });

	  it('reads voiceAgentRunV1 from voice conversation session metadata when present', async () => {
	    stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1 = {
	      v: 1,
	      runId: 'run_1',
	      backendTarget: claudeTarget,
	      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeTarget, providerSessionId: 'vs_1' },
      updatedAtMs: 123,
    };

    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendTarget: claudeTarget,
      backendId: 'claude',
      updatedAtMs: 123,
    });
  });

  it('writes voiceAgentRunV1 into voice conversation session metadata', async () => {
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      const current = stateRef.current;
      const nextMetadata = updater(current.sessions[sessionId].metadata);
      stateRef.current = {
          ...current,
          sessions: {
              ...current.sessions,
              [sessionId]: {
                  ...current.sessions[sessionId],
                  metadata: nextMetadata,
              },
          },
      };
    });

    const { writeVoiceAgentRunMetadataToSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToSession({
      sessionId: 'sys_voice',
      runId: 'run_2',
      backendTarget: codexTarget,
      backendId: 'codex',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: codexBackendTarget, providerSessionId: 'vs_2' },
      streamId: 'stream_2',
      updatedAtMs: 999,
      welcomedEpoch: 4,
    });

    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('sys_voice', expect.any(Function));
    expect(stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_2',
      backendTarget: codexTarget,
      backendId: 'codex',
      streamId: 'stream_2',
      updatedAtMs: 999,
      welcomedEpoch: 4,
    });
  });

  it('clears a stale persisted streamId when a different runId is written without a stream handoff', async () => {
    stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_prev',
      backendTarget: claudeTarget,
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeBackendTarget, providerSessionId: 'vs_prev' },
      streamId: 'stream_prev',
      updatedAtMs: 10,
    };
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      const current = stateRef.current;
      const nextMetadata = updater(current.sessions[sessionId].metadata);
      stateRef.current = {
          ...current,
          sessions: {
              ...current.sessions,
              [sessionId]: {
                  ...current.sessions[sessionId],
                  metadata: nextMetadata,
              },
          },
      };
    });

    const { writeVoiceAgentRunMetadataToSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToSession({
      sessionId: 'sys_voice',
      runId: 'run_fresh',
      backendTarget: claudeTarget,
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeBackendTarget, providerSessionId: 'vs_fresh' },
      updatedAtMs: 20,
    });

    expect(stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      runId: 'run_fresh',
    });
    expect((stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1 as any).streamId).toBeNull();
  });

	  it('clears voiceAgentRunV1 by setting it to null', async () => {
	    stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1 = {
	      v: 1,
	      runId: 'run_1',
	      backendTarget: claudeTarget,
	      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeBackendTarget, providerSessionId: 'vs_1' },
      updatedAtMs: 123,
    };

    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      const current = stateRef.current;
      const nextMetadata = updater(current.sessions[sessionId].metadata);
      stateRef.current = {
          ...current,
          sessions: {
              ...current.sessions,
              [sessionId]: {
                  ...current.sessions[sessionId],
                  metadata: nextMetadata,
              },
          },
      };
    });

    const { clearVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    await clearVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' });

    expect(stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1).toBeNull();
  });

  it('reads and writes voiceAgentRunV1 for any session metadata, not only carrier sessions', async () => {
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      const current = stateRef.current;
      const nextMetadata = updater(current.sessions[sessionId].metadata);
      stateRef.current = {
          ...current,
          sessions: {
              ...current.sessions,
              [sessionId]: {
                  ...current.sessions[sessionId],
                  metadata: nextMetadata,
              },
          },
      };
    });

    const {
      readVoiceAgentRunMetadataFromSession,
      writeVoiceAgentRunMetadataToSession,
      clearVoiceAgentRunMetadataFromSession,
    } = await import('./voiceAgentRunMetadata');

    await writeVoiceAgentRunMetadataToSession({
      sessionId: 's1',
      runId: 'run_session',
      backendTarget: claudeTarget,
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeBackendTarget, providerSessionId: 'vs_session' },
      updatedAtMs: 456,
      welcomedEpoch: 3,
    });

    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toMatchObject({
      v: 1,
      runId: 'run_session',
      backendTarget: claudeTarget,
      backendId: 'claude',
      updatedAtMs: 456,
      welcomedEpoch: 3,
    });

    await clearVoiceAgentRunMetadataFromSession({ sessionId: 's1' });
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toBeNull();
  });

  it('prefers visible lookup voice-agent run metadata when the raw session metadata is stale', async () => {
    stateRef.current.sessions.s1.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_raw',
      backendTarget: claudeTarget,
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeBackendTarget, providerSessionId: 'vs_raw' },
      updatedAtMs: 111,
    };
    stateRef.current = {
        ...stateRef.current,
        sessionListRenderables: {
            ...stateRef.current.sessionListRenderables,
            s1: {
                id: 's1',
                active: true,
                updatedAt: 1,
                metadata: {
                    voiceAgentRunV1: {
                        v: 1,
                        runId: 'run_cached',
                        backendTarget: claudeTarget,
                        backendId: 'claude',
                        resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeBackendTarget, providerSessionId: 'vs_cached' },
                        updatedAtMs: 222,
                    },
                },
            },
        },
    };

    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toMatchObject({
      runId: 'run_cached',
      updatedAtMs: 222,
    });
  });

  it('reads welcomedEpoch from persisted voiceAgentRunV1 metadata when present', async () => {
    stateRef.current.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_1',
      backendTarget: claudeTarget,
      backendId: 'claude',
      resumeHandle: { kind: 'provider_session.v1', backendTarget: claudeBackendTarget, providerSessionId: 'vs_1' },
      updatedAtMs: 123,
      welcomedEpoch: 9,
    };

    const { readVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' })).toMatchObject({
      runId: 'run_1',
      welcomedEpoch: 9,
    });
  });
});
