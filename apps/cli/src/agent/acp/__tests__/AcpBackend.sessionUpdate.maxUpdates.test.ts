import { describe, expect, it, vi } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { defaultTransport } from '../../transport';
import { logger } from '@/ui/logger';

describe('AcpBackend session/update max updates guard', () => {
  it('truncates excessive updates per notification using an env override', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const prev = process.env.HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION;
    process.env.HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION = '1';
    try {
      const emitted: any[] = [];
      const fakeBackend: any = {
        transport: defaultTransport,
        replayCapture: null,
        activeToolCalls: new Set<string>(),
        finalizedToolCalls: new Set<string>(),
        toolCallStartTimes: new Map<string, number>(),
        toolCallTimeouts: new Map<string, any>(),
        toolCallIdToNameMap: new Map<string, string>(),
        toolCallIdToInputMap: new Map<string, unknown>(),
        idleTimeout: null,
        toolCallCountSincePrompt: 0,
        emit: (msg: any) => emitted.push(msg),
        emitIdleStatus: () => emitted.push({ type: 'status', status: 'idle' }),
      };
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

      expect(fakeBackend.toolCallIdToNameMap.has('call_1')).toBe(true);
      expect(fakeBackend.toolCallIdToNameMap.has('call_2')).toBe(false);
      expect(emitted.filter((m) => m.type === 'tool-call').length).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      process.env.HAPPIER_ACP_MAX_UPDATES_PER_NOTIFICATION = prev;
      warnSpy.mockRestore();
    }
  });
});
