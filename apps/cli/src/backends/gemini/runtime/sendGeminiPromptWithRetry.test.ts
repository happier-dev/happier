import { describe, expect, it, vi } from 'vitest';

import { sendGeminiPromptWithRetry } from './sendGeminiPromptWithRetry';

describe('sendGeminiPromptWithRetry', () => {
  it('sends prompt once when backend succeeds immediately', async () => {
    const backend = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
    });

    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(backend.waitForResponseComplete).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('retries empty-response failures and eventually succeeds', async () => {
    const backend = {
      sendPrompt: vi
        .fn()
        .mockRejectedValueOnce({ details: 'Model stream ended unexpectedly' })
        .mockResolvedValueOnce(undefined),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(backend.sendPrompt).toHaveBeenCalledTimes(2);
    expect(messageBuffer.addMessage).toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      'status',
    );
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('does not retry quota errors and forwards quota message to session', async () => {
    const backend = {
      sendPrompt: vi.fn().mockRejectedValue({ details: 'quota exhausted reset after 1h2m' }),
      waitForResponseComplete: vi.fn(),
    } as any;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await expect(
      sendGeminiPromptWithRetry({
        backend,
        acpSessionId: 'session-1',
        prompt: 'hello',
        messageBuffer,
        session,
        onDebug,
      }),
    ).rejects.toBeTruthy();

    expect(backend.sendPrompt).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).toHaveBeenCalledWith(
      expect.stringContaining('quota'),
      'status',
    );
    expect(session.sendAgentMessage).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({ type: 'message' }),
    );
  });
});
