import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { AcpReplayCapture } from '../history/acpReplayCapture';
import { createAcpTestTransportHandler } from '../testkit/subprocessHarness';

describe('AcpBackend replay capture ordering', () => {
  it('captures load-time history before the live prompt-generation filter', async () => {
    const backend = new AcpBackend({
      agentName: 'gemini',
      cwd: process.cwd(),
      command: process.execPath,
      args: [],
      transportHandler: createAcpTestTransportHandler(),
    });
    const replayCapture = new AcpReplayCapture();
    Reflect.set(backend, 'replayCapture', replayCapture);
    Reflect.set(backend, 'closedTurnGeneration', 1);
    Reflect.set(backend, 'turnGeneration', 1);
    Reflect.set(backend, 'prePromptResponseUpdateGuard', 'terminal');
    Reflect.set(backend, 'dropPromptTurnUpdatesUntilPromptResponse', true);
    Reflect.set(backend, 'waitingForResponse', false);

    await (backend as any).handleSessionUpdate({
      sessionId: 'gemini-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'restored Gemini history' },
      },
    });

    expect(replayCapture.finalize()).toEqual([
      { type: 'message', role: 'agent', text: 'restored Gemini history' },
    ]);
  });
});
