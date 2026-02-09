import { describe, expect, it, vi } from 'vitest';

import { ensureSessionInfoBeforeSwitch } from './ensureSessionInfoBeforeSwitch';

describe('ensureSessionInfoBeforeSwitch', () => {
  it('no-ops when session id and transcript path are available', async () => {
    const sendSessionEvent = vi.fn();
    const waitForSessionFound = vi.fn();

    await ensureSessionInfoBeforeSwitch({
      session: {
        sessionId: 'session-1',
        transcriptPath: '/tmp/transcript.jsonl',
        client: { sendSessionEvent } as any,
        waitForSessionFound,
      },
    });

    expect(sendSessionEvent).not.toHaveBeenCalled();
    expect(waitForSessionFound).not.toHaveBeenCalled();
  });

  it('emits waiting message and waits when session id is missing', async () => {
    const sendSessionEvent = vi.fn();
    const waitForSessionFound = vi.fn(async () => null);

    await ensureSessionInfoBeforeSwitch({
      session: {
        sessionId: null,
        transcriptPath: null,
        client: { sendSessionEvent } as any,
        waitForSessionFound,
      },
    });

    expect(sendSessionEvent).toHaveBeenCalledWith({
      type: 'message',
      message: 'Waiting for Claude session to initialize before switching…',
    });
    expect(waitForSessionFound).toHaveBeenCalledWith({
      timeoutMs: 2000,
      requireTranscriptPath: true,
    });
  });
});
