import { beforeEach, describe, expect, it, vi } from 'vitest';

const patchSessionMetadataWithRetry = vi.fn();

const state: any = {
  sessions: {
    sys_voice: { id: 'sys_voice', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } } },
    s1: { id: 's1', updatedAt: 1, metadata: { flavor: 'claude' } },
  },
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => state,
  },
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

  beforeEach(() => {
    vi.resetModules();
    patchSessionMetadataWithRetry.mockReset();
    state.sessions.sys_voice.metadata = { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } };
  });

  it('reads voiceAgentRunV1 from voice conversation session metadata when present', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_1',
      backendTarget: claudeTarget,
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: claudeTarget, vendorSessionId: 'vs_1' },
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
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    const { writeVoiceAgentRunMetadataToSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToSession({
      sessionId: 'sys_voice',
      runId: 'run_2',
      backendTarget: codexTarget,
      backendId: 'codex',
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: codexTarget, vendorSessionId: 'vs_2' },
      updatedAtMs: 999,
    });

    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('sys_voice', expect.any(Function));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_2',
      backendTarget: codexTarget,
      backendId: 'codex',
      updatedAtMs: 999,
    });
  });

  it('clears voiceAgentRunV1 by setting it to null', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_1',
      backendTarget: claudeTarget,
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: claudeTarget, vendorSessionId: 'vs_1' },
      updatedAtMs: 123,
    };

    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    const { clearVoiceAgentRunMetadataFromSession } = await import('./voiceAgentRunMetadata');
    await clearVoiceAgentRunMetadataFromSession({ sessionId: 'sys_voice' });

    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toBeNull();
  });

  it('reads and writes voiceAgentRunV1 for any session metadata, not only carrier sessions', async () => {
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
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
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: claudeTarget, vendorSessionId: 'vs_session' },
      updatedAtMs: 456,
    });

    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toMatchObject({
      v: 1,
      runId: 'run_session',
      backendTarget: claudeTarget,
      backendId: 'claude',
      updatedAtMs: 456,
    });

    await clearVoiceAgentRunMetadataFromSession({ sessionId: 's1' });
    expect(readVoiceAgentRunMetadataFromSession({ sessionId: 's1' })).toBeNull();
  });
});
