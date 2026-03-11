import { describe, expect, it, vi } from 'vitest';

import { ensureGeminiAcpSession } from './ensureGeminiAcpSession';

const importAcpReplayHistoryV1Mock = vi.hoisted(() => vi.fn());

vi.mock('@/agent/acp/history/importAcpReplayHistory', () => ({
  importAcpReplayHistoryV1: (...args: unknown[]) => importAcpReplayHistoryV1Mock(...args),
}));

describe('ensureGeminiAcpSession', () => {
  it('starts a new session when no resume id is provided', async () => {
    const backend = {
      startSession: vi.fn().mockResolvedValue({ sessionId: 'new-session' }),
    } as any;

    const result = await ensureGeminiAcpSession({
      backend,
      session: {} as any,
      permissionHandler: {} as any,
      messageBuffer: { addMessage: vi.fn() } as any,
      storedResumeId: null,
      onDebug: vi.fn(),
    });

    expect(result).toEqual({ acpSessionId: 'new-session', storedResumeId: null, startedFreshSession: true });
    expect(backend.startSession).toHaveBeenCalledTimes(1);
  });

  it('loads an existing session and consumes stored resume id', async () => {
    const backend = {
      loadSession: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn(),
    } as any;

    const result = await ensureGeminiAcpSession({
      backend,
      session: {} as any,
      permissionHandler: {} as any,
      messageBuffer: { addMessage: vi.fn() } as any,
      storedResumeId: 'resume-123',
      onDebug: vi.fn(),
    });

    expect(backend.loadSession).toHaveBeenCalledWith('resume-123');
    expect(backend.startSession).not.toHaveBeenCalled();
    expect(result).toEqual({ acpSessionId: 'resume-123', storedResumeId: null, startedFreshSession: false });
  });

  it('loads an existing session with replay capture using the backend binding and imports replay history', async () => {
    importAcpReplayHistoryV1Mock.mockClear();
    const backend = {
      replayCalls: [] as string[],
      async loadSessionWithReplayCapture(this: { replayCalls: string[] }, sessionId: string) {
        this.replayCalls.push(sessionId);
        return { sessionId, replay: [{ type: 'message' }] };
      },
      startSession: vi.fn(),
    };
    const session = {} as any;
    const permissionHandler = {} as any;

    const result = await ensureGeminiAcpSession({
      backend: backend as any,
      session,
      permissionHandler,
      messageBuffer: { addMessage: vi.fn() } as any,
      storedResumeId: 'resume-456',
      onDebug: vi.fn(),
    });

    expect(backend.replayCalls).toEqual(['resume-456']);
    expect(backend.startSession).not.toHaveBeenCalled();
    expect(importAcpReplayHistoryV1Mock).toHaveBeenCalledWith({
      session,
      provider: 'gemini',
      remoteSessionId: 'resume-456',
      replay: [{ type: 'message' }],
      permissionHandler,
    });
    expect(result).toEqual({ acpSessionId: 'resume-456', storedResumeId: null, startedFreshSession: false });
  });
});
