import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => `t:${key}`,
}));

import { resolveSessionGoalFailurePresentation } from './sessionGoalOperationFailure';

describe('resolveSessionGoalFailurePresentation', () => {
    it.each([
        { error: 'session_goal_control_remote_unavailable', errorCode: 'session_goal_control_remote_unavailable' },
        { error: 'unsupported_session_runtime_method:session.goal.clear', errorCode: 'unsupported_session_runtime_method' },
        { error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' },
        { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' },
    ])('maps unavailable runner control failures to the retryable not-ready presentation', (failure) => {
        expect(resolveSessionGoalFailurePresentation({ ok: false, ...failure })).toEqual({
            title: 't:session.workState.notReadyTitle',
            message: 't:session.workState.notReadyMessage',
        });
    });
});
