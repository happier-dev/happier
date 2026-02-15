import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

const trackPermissionResponse = vi.fn();
const executeAction = vi.fn();

const state: any = {
  sessions: {
    s1: {
      agentState: {
        requests: {
          req_a: { id: 'req_a' },
          req_b: { id: 'req_b' },
        },
      },
    },
  },
};

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => state,
  },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({
    execute: (...args: any[]) => executeAction(...args),
  }),
}));

vi.mock('@/track', () => ({
  trackPermissionResponse: (...args: any[]) => trackPermissionResponse(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: vi.fn(),
  },
}));

vi.mock('./RealtimeSession', () => ({
  // Realtime voice is account-scoped; tool routing must not depend on a "current realtime session id".
  getCurrentRealtimeSessionId: () => {
    throw new Error('getCurrentRealtimeSessionId should not be called');
  },
}));

describe('realtimeClientTools permission handling', () => {
  beforeEach(() => {
    trackPermissionResponse.mockReset();
    executeAction.mockReset();
    executeAction.mockResolvedValue({ ok: true, result: { ok: true } });
    state.sessions.s1.agentState.requests = {
      req_a: { id: 'req_a' },
      req_b: { id: 'req_b' },
    };

    useVoiceTargetStore.getState().setScope('global');
    useVoiceTargetStore.getState().setPrimaryActionSessionId('s1');
  });

  it('requires explicit requestId when multiple permission requests are active', async () => {
    const { realtimeClientTools } = await import('./realtimeClientTools');

    const result = await realtimeClientTools.processPermissionRequest({ decision: 'allow' });

    expect(JSON.parse(result)).toMatchObject({ ok: false, errorCode: 'multiple_permission_requests' });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('allows explicit requestId selection', async () => {
    const { realtimeClientTools } = await import('./realtimeClientTools');

    const result = await realtimeClientTools.processPermissionRequest({ decision: 'allow', requestId: 'req_b' });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(executeAction).toHaveBeenCalledWith(
      'session.permission.respond',
      expect.objectContaining({ sessionId: 's1', requestId: 'req_b', decision: 'allow' }),
      expect.anything(),
    );
    expect(trackPermissionResponse).toHaveBeenCalledWith(true);
  });
});
