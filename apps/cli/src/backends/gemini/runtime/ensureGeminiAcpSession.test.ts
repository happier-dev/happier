import { describe, expect, it, vi } from 'vitest';

import { ensureGeminiAcpSession } from './ensureGeminiAcpSession';

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

    expect(result).toEqual({ acpSessionId: 'new-session', storedResumeId: null });
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
    expect(result).toEqual({ acpSessionId: 'resume-123', storedResumeId: null });
  });
});
