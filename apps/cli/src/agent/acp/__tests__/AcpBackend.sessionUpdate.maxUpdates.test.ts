import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { defaultTransport } from '../../transport';
import { logger } from '@/ui/logger';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { LegacyAcpToolRuntime } from '../toolCalls/legacy/runtime';

const envScope = createEnvKeyScope(['HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION']);

describe('AcpBackend session/update max updates guard', () => {
  it('truncates excessive updates per notification using an env override', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    envScope.patch({ HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION: '1' });
    try {
      const emitted: any[] = [];
      const fakeBackend: any = {
        options: { agentName: 'test' },
        transport: defaultTransport,
        replayCapture: null,
        sessionUpdateShapeLogger: { log: () => {} },
        acpSessionId: 'session-1',
        turnGeneration: 1,
        idleTimeout: null,
        waitingForResponse: false,
        isCurrentTurnGenerationClosed: () => false,
        prePromptResponseUpdateGuard: 'none',
        dropPromptTurnUpdatesUntilPromptResponse: false,
        toolCallCountSincePrompt: 0,
        emit: (msg: any) => emitted.push(msg),
        emitIdleStatus: () => emitted.push({ type: 'status', status: 'idle' }),
      };
      fakeBackend.toolCalls = new LegacyAcpToolRuntime({
        sessionId: () => fakeBackend.acpSessionId,
        turnId: () => `legacy-turn:${fakeBackend.turnGeneration}`,
        sidechainId: null,
        emit: fakeBackend.emit,
        transport: fakeBackend.transport,
        onBecameActive: () => undefined,
        onBecameIdle: () => undefined,
      });
      fakeBackend.createHandlerContext = (AcpBackend as any).prototype.createHandlerContext;

      const handleSessionUpdate = (AcpBackend as any).prototype.handleSessionUpdate as (params: any) => void;
      handleSessionUpdate.call(fakeBackend, {
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

      expect(fakeBackend.toolCalls.readCall('call_1')).not.toBeNull();
      expect(fakeBackend.toolCalls.readCall('call_2')).toBeNull();
      expect(emitted.filter((m) => m.type === 'tool-call').length).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      envScope.restore();
      warnSpy.mockRestore();
    }
  });

  it('accepts late provider output only for an exact retained closed-turn tool id', () => {
    const emitted: any[] = [];
    const fakeBackend: any = {
      options: { agentName: 'test' },
      transport: defaultTransport,
      replayCapture: null,
      sessionUpdateShapeLogger: { log: () => {} },
      acpSessionId: 'session-1',
      turnGeneration: 1,
      idleTimeout: null,
      waitingForResponse: false,
      isCurrentTurnGenerationClosed: () => true,
      prePromptResponseUpdateGuard: 'none',
      dropPromptTurnUpdatesUntilPromptResponse: false,
      toolCallCountSincePrompt: 0,
      emit: (msg: any) => emitted.push(msg),
      emitIdleStatus: () => emitted.push({ type: 'status', status: 'idle' }),
    };
    fakeBackend.toolCalls = new LegacyAcpToolRuntime({
      sessionId: () => fakeBackend.acpSessionId,
      turnId: () => `legacy-turn:${fakeBackend.turnGeneration}`,
      sidechainId: null,
      emit: fakeBackend.emit,
      transport: fakeBackend.transport,
      onBecameActive: () => undefined,
      onBecameIdle: () => undefined,
    });
    fakeBackend.createHandlerContext = (AcpBackend as any).prototype.createHandlerContext;
    fakeBackend.toolCalls.handleRawUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'known',
      title: 'Known call',
      status: 'pending',
    });
    const callLocalId = emitted.find((message) => message.type === 'tool-call')?.localId;
    fakeBackend.toolCalls.terminalizeTurn('completed');
    emitted.length = 0;

    const handleSessionUpdate = (AcpBackend as any).prototype.handleSessionUpdate as (params: any) => void;
    handleSessionUpdate.call(fakeBackend, {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'known',
        status: 'completed',
        rawOutput: { text: 'late provider output' },
      },
    });
    handleSessionUpdate.call(fakeBackend, {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'unknown',
        status: 'completed',
        rawOutput: { text: 'must be dropped' },
      },
    });

    expect(emitted.filter((message) => message.type === 'tool-result')).toHaveLength(1);
    expect(emitted.find((message) => message.type === 'tool-call')).toMatchObject({
      callId: 'known',
      localId: callLocalId,
    });
    expect(fakeBackend.toolCalls.readCall('unknown')).toBeNull();
  });
});
