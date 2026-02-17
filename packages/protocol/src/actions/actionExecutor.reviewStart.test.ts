import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor';

describe('createActionExecutor (review.start)', () => {
  it('starts review runs with ioMode=streaming so sidechain progress can stream', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));

    const executor = createActionExecutor({
      executionRunStart,
      executionRunList: async () => ({}),
      executionRunGet: async () => ({}),
      executionRunSend: async () => ({}),
      executionRunStop: async () => ({}),
      executionRunAction: async () => ({}),
      sessionOpen: async () => ({}),
      sessionSpawnNew: async () => ({}),
      sessionSendMessage: async () => ({}),
      sessionPermissionRespond: async () => ({}),
      sessionTargetPrimarySet: async () => ({}),
      sessionTargetTrackedSet: async () => ({}),
      sessionList: async () => ({}),
      sessionActivityGet: async () => ({}),
      sessionRecentMessagesGet: async () => ({}),
      resetGlobalVoiceAgent: async () => {},
    });

    const res = await executor.execute(
      'review.start' as any,
      {
        sessionId: 's1',
        engineIds: ['claude'],
        instructions: 'Review this.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        intent: 'review',
        backendId: 'claude',
        ioMode: 'streaming',
      }),
      undefined,
    );
  });
});

