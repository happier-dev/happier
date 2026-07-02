import { describe, expect, it, vi } from 'vitest';

import { sendCodexProjectedToolEvent } from './projectedToolEvent.js';

describe('sendCodexProjectedToolEvent', () => {
  it('sends main-thread tool events as Codex transcript messages', async () => {
    const sendCodexMessage = vi.fn();

    await sendCodexProjectedToolEvent({
      session: {
        sendAgentMessage: vi.fn(),
        sendCodexMessage,
      },
      event: {
        type: 'tool-result',
        callId: 'call-1',
        output: { ok: true },
        sidechainId: null,
      },
    });

    expect(sendCodexMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool-call-result',
      callId: 'call-1',
      output: { ok: true },
      id: expect.any(String),
    }));
  });

  it('sends sidechain tool events as agent messages', async () => {
    const sendAgentMessage = vi.fn();

    await sendCodexProjectedToolEvent({
      session: {
        sendAgentMessage,
        sendCodexMessage: vi.fn(),
      },
      event: {
        type: 'tool-call',
        callId: 'call-2',
        name: 'exec_command',
        input: { cmd: 'echo ok' },
        sidechainId: 'thread-1',
      },
    });

    expect(sendAgentMessage).toHaveBeenCalledWith('codex', expect.objectContaining({
      type: 'tool-call',
      callId: 'call-2',
      name: 'exec_command',
      sidechainId: 'thread-1',
      id: expect.any(String),
    }));
  });
});

