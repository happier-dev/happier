import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VoiceAgentProfile } from './VoiceAgentProfile';

const readStoredCredentialsMock = vi.fn();
const resolveReplaySeedDraftMock = vi.fn();

vi.mock('@/persistence', () => ({
  readStoredCredentials: () => readStoredCredentialsMock(),
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: (...args: unknown[]) => resolveReplaySeedDraftMock(...args),
}));

describe('VoiceAgentProfile', () => {
  beforeEach(() => {
    readStoredCredentialsMock.mockReset();
    resolveReplaySeedDraftMock.mockReset();
  });

  it('keeps voice-agent sidechain text unchanged and exposes actions only for a voice controller', () => {
    expect(VoiceAgentProfile.transcriptMaterialization).toBe('none');
    expect(VoiceAgentProfile.emitFinalSidechainMessageWhenStreamed).toBeUndefined();
    expect(VoiceAgentProfile.computeSidechainStreamText?.({ fullText: 'Voice prose' })).toBe('Voice prose');

    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'voice_agent',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'listen',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      startedAtMs: 1,
    } as const;

    expect(VoiceAgentProfile.listAvailableActionIds?.({ start, controllerKind: 'voice_agent' })).toEqual([
      'voice_agent.welcome',
      'voice_agent.commit',
    ]);
    expect(VoiceAgentProfile.listAvailableActionIds?.({ start, controllerKind: null })).toEqual([]);
  });

  it('keeps bounded completion summaries stable for voice output', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'voice_agent',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'listen',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      startedAtMs: 1,
    } as const;

    const result = VoiceAgentProfile.onBoundedComplete({ start, rawText: '  Hello there  ', finishedAtMs: 2 });
    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe('Hello there');
  });

  it('merges replay seed context and upgrades ready-handshake bootstraps to first-turn mode', async () => {
    readStoredCredentialsMock.mockResolvedValue({ token: 'credential-token' });
    resolveReplaySeedDraftMock.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Seeded summary from the previous voice session.',
    });

    const prepared = await VoiceAgentProfile.prepareStartParams?.({
      cwd: '/tmp/voice-agent',
      request: {
        intent: 'voice_agent',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'long_lived',
        ioMode: 'streaming',
        initialContext: 'Operator supplied context.',
        bootstrapMode: 'ready_handshake',
        replay: {
          kind: 'voice_session.v1',
          previousSessionId: 'sess_voice',
          transcriptEpoch: 4,
        },
      } as never,
    });

    expect(resolveReplaySeedDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/voice-agent',
      source: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
        transcriptEpoch: 4,
      },
    }));
    expect(prepared).toEqual({
      initialContext: 'Operator supplied context.\n\nSeeded summary from the previous voice session.',
      initialContextMode: 'first_turn',
    });
  });
});
