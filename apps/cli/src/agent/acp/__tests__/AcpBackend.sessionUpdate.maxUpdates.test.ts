import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { AcpReplayCapture } from '../history/acpReplayCapture';

const envScope = createEnvKeyScope(['HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION']);

function createBackend(): AcpBackend {
  return new AcpBackend({
    agentName: 'test',
    cwd: process.cwd(),
    command: process.execPath,
  });
}

describe('AcpBackend session/update max updates guard', () => {
  it('truncates excessive updates per notification using an env override', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    envScope.patch({ HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION: '1' });
    const backend = createBackend();
    const emitted: AgentMessage[] = [];
    backend.onMessage((message) => emitted.push(message));
    const internal = backend as unknown as {
      turnGeneration: number;
      dispatchedPromptTurnGeneration: number | null;
      handleSessionUpdate(params: unknown): Promise<void>;
    };
    internal.turnGeneration = 1;
    internal.dispatchedPromptTurnGeneration = 1;
    try {
      await internal.handleSessionUpdate({
        updates: [
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_1',
            status: 'in_progress',
            kind: 'execute',
            title: 'Run 1',
            content: { command: 'echo 1' },
          },
          {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_2',
            status: 'in_progress',
            kind: 'execute',
            title: 'Run 2',
            content: { command: 'echo 2' },
          },
        ],
      });

      expect(emitted.filter((message) => message.type === 'tool-call')).toEqual([
        expect.objectContaining({ callId: 'call_1' }),
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      await backend.dispose();
      envScope.restore();
      warnSpy.mockRestore();
    }
  });

  it('captures replay updates before the live prompt-generation filter rejects them', async () => {
    const backend = createBackend();
    const emitted: AgentMessage[] = [];
    backend.onMessage((message) => emitted.push(message));
    const replayCapture = new AcpReplayCapture();
    const internal = backend as unknown as {
      replayCapture: AcpReplayCapture | null;
      handleSessionUpdate(params: unknown): Promise<void>;
    };
    const notification = {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'restored transcript' },
      },
    };

    try {
      internal.replayCapture = replayCapture;
      await internal.handleSessionUpdate(notification);
      expect(replayCapture.finalize()).toEqual([
        { type: 'message', role: 'agent', text: 'restored transcript' },
      ]);
      internal.replayCapture = null;
      await internal.handleSessionUpdate(notification);
      expect(emitted).toEqual([]);
    } finally {
      await backend.dispose();
    }
  });
});
