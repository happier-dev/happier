import { beforeEach, describe, expect, it, vi } from 'vitest';

const patchSessionMetadataWithRetry = vi.fn();

const state: any = {
  sessions: {
    sys_voice: { id: 'sys_voice', updatedAt: 10, metadata: { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } } },
  },
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: (sessionId: string, updater: (m: any) => any) =>
      patchSessionMetadataWithRetry(sessionId, updater),
  },
}));

describe('voiceAgentRunMetadata', () => {
  beforeEach(() => {
    vi.resetModules();
    patchSessionMetadataWithRetry.mockReset();
    state.sessions.sys_voice.metadata = { systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true } };
  });

  it('reads voiceAgentRunV1 from carrier session metadata when present', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
      updatedAtMs: 123,
    };

    const { readVoiceAgentRunMetadataFromCarrierSession } = await import('./voiceAgentRunMetadata');
    expect(readVoiceAgentRunMetadataFromCarrierSession({ carrierSessionId: 'sys_voice' })).toMatchObject({
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      updatedAtMs: 123,
    });
  });

  it('writes voiceAgentRunV1 into carrier session metadata', async () => {
    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    const { writeVoiceAgentRunMetadataToCarrierSession } = await import('./voiceAgentRunMetadata');
    await writeVoiceAgentRunMetadataToCarrierSession({
      carrierSessionId: 'sys_voice',
      runId: 'run_2',
      backendId: 'codex',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'codex', vendorSessionId: 'vs_2' },
      updatedAtMs: 999,
    });

    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('sys_voice', expect.any(Function));
    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toMatchObject({
      v: 1,
      runId: 'run_2',
      backendId: 'codex',
      updatedAtMs: 999,
    });
  });

  it('clears voiceAgentRunV1 by setting it to null', async () => {
    state.sessions.sys_voice.metadata.voiceAgentRunV1 = {
      v: 1,
      runId: 'run_1',
      backendId: 'claude',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vs_1' },
      updatedAtMs: 123,
    };

    patchSessionMetadataWithRetry.mockImplementation(async (sessionId: string, updater: (m: any) => any) => {
      state.sessions[sessionId].metadata = updater(state.sessions[sessionId].metadata);
    });

    const { clearVoiceAgentRunMetadataFromCarrierSession } = await import('./voiceAgentRunMetadata');
    await clearVoiceAgentRunMetadataFromCarrierSession({ carrierSessionId: 'sys_voice' });

    expect(state.sessions.sys_voice.metadata.voiceAgentRunV1).toBeNull();
  });
});

