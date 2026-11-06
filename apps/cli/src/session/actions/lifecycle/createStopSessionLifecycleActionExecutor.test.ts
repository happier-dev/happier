import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { createStopSession } from '@/daemon/sessions/stopSession';

import { createMachineSessionStopLifecycleActionExecutor } from './createStopSessionLifecycleActionExecutor';

describe('createMachineSessionStopLifecycleActionExecutor', () => {
  it.each([
    { status: 'stopped' as const },
    { status: 'requested' as const },
    { status: 'not_found' as const },
    { status: 'incomplete' as const, reason: 'runner_exit_timeout' as const },
  ])('preserves the canonical Stop result $status', async (result) => {
    const stopSession = vi.fn(async () => result);
    const executor = createMachineSessionStopLifecycleActionExecutor({ stopSession: stopSession as never });

    await expect(executor.execute('session.stop', { sessionId: ' session-1 ' })).resolves.toEqual({
      ok: true,
      result,
    });
    expect(stopSession).toHaveBeenCalledWith('session-1', { source: undefined, transport: 'machine_rpc' });
  });
});


it.each([true, false])('records only the originating Stop context through the real lifecycle owner (known: %s)', async known => {
  const diagnostic = vi.spyOn(logger, 'infoFile');
  try {
    const executor = createMachineSessionStopLifecycleActionExecutor({ stopSession: createStopSession({
      pidToTrackedSession: new Map(), readHostAttachmentState: async () => ({ status: 'absent' }),
      readTerminalAttachmentInfo: async () => null,
    }) });
    const context = known ? { surface: 'agent' as const, authority: 'account_automation' as const,
      defaultSessionId: 'target-session', actionCaller: { kind: 'session' as const, sessionId: 'caller-session', starterDepth: 0, turnDepth: 0 },
      approvalOrigin: { kind: 'transcript_tool_call' as const, sessionId: 'caller-session', toolCallId: 'tool-stop',
        toolInput: { credential: 'private-tool-input' } } } : undefined;
    expect(await executor.execute('session.stop', { sessionId: 'target-session', source: {
      surface: 'forged-input', requestingSessionId: 'forged-caller' } }, context)).toEqual({ ok: true, result: { status: 'not_found' } });
    const attempts = diagnostic.mock.calls.filter(([event]) => event === '[DAEMON STOP] Attempting Stop');
    expect(attempts).toEqual([['[DAEMON STOP] Attempting Stop', { event: 'session_stop_attempt', sessionId: 'target-session',
      requestTransport: 'machine_rpc', requestSource: known ? { surface: 'agent', callerKind: 'session',
        requestingSessionId: 'caller-session', toolCallId: 'tool-stop' } : null }]]);
    expect(JSON.stringify(attempts)).not.toMatch(/private-tool-input|forged-input|forged-caller/);
  } finally { diagnostic.mockRestore(); }
});
