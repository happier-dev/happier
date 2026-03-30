import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installRealtimeCommonModuleMocks } from './realtimeTestHelpers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

const trackPermissionResponse = vi.fn();
const executeAction = vi.fn();

const state: any = {
  sessions: {
    s1: {
      active: true,
      agentState: {
        requests: {
          req_a: { id: 'req_a', tool: 'Bash', kind: 'permission' },
          req_b: { id: 'req_b', tool: 'Read', kind: 'permission' },
        },
      },
    },
  },
};

installRealtimeCommonModuleMocks({
  storage: () =>
    createStorageModuleStub({
      storage: {
        getState: () => state,
      },
    }),
});

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
      req_a: { id: 'req_a', tool: 'Bash', kind: 'permission' },
      req_b: { id: 'req_b', tool: 'Read', kind: 'permission' },
    };
    state.sessions.s1.active = true;

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

  it('routes structured user-action answers through the shared voice handlers', async () => {
    state.sessions.s1.agentState.requests = {
      req_question: { id: 'req_question', tool: 'AskUserQuestion', kind: 'user_action' },
      req_permission: { id: 'req_permission', tool: 'Bash', kind: 'permission' },
    };
    state.sessions.s1.active = true;

    const { realtimeClientTools } = await import('./realtimeClientTools');

    const result = await (realtimeClientTools as any).answerUserActionRequest({
      answers: [{ question: 'Continue?', answer: 'Yes' }],
    });

    expect(JSON.parse(result)).toMatchObject({ ok: true });
    expect(executeAction).toHaveBeenCalledWith(
      'session.user_action.answer',
      expect.objectContaining({
        sessionId: 's1',
        answers: [{ question: 'Continue?', answer: 'Yes' }],
      }),
      expect.anything(),
    );
  });
});
