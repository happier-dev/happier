import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installRealtimeCommonModuleMocks } from './realtimeTestHelpers';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

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

vi.mock('@/sync/sync', () => ({
  sync: {
    sendMessage: vi.fn(),
  },
}));

describe('realtimeClientTools action projection', () => {
  beforeEach(() => {
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

  it('does not expose speech-driven permission approval as a provider tool', async () => {
    const { realtimeClientTools } = await import('./realtimeClientTools');

    expect(realtimeClientTools).not.toHaveProperty('processPermissionRequest');
    expect(executeAction).not.toHaveBeenCalled();
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
        requestId: 'req_question',
        answers: [{ question: 'Continue?', values: ['Yes'] }],
      }),
      expect.objectContaining({ surface: 'voice' }),
    );
  });

  it('projects a read-only-only tool map for provider SDKs without observable mutation delivery', async () => {
    const { realtimeReadOnlyClientTools } = await import('./realtimeClientTools');
    const { getActionSpec, listVoiceToolActionSpecs } = await import('@happier-dev/protocol');

    expect(Object.keys(realtimeReadOnlyClientTools).length).toBeGreaterThan(0);
    for (const spec of listVoiceToolActionSpecs()) {
      const toolName = String(spec.bindings?.voiceClientToolName ?? '').trim();
      if (!toolName) continue;
      const effect = getActionSpec(spec.id).sideEffectClass;
      expect(Object.hasOwn(realtimeReadOnlyClientTools, toolName)).toBe(
        effect === 'none' || effect === 'read',
      );
    }
  });
});
