import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({
    t: (key: string) => `t:${key}`,
}));

import { resolveSessionGoalFailurePresentation } from './sessionGoalOperationFailure';

describe('resolveSessionGoalFailurePresentation', () => {
    it.each([
        { error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' },
        { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' },
        { error: 'session_goal_control_unsupported', errorCode: 'session_goal_control_unsupported' },
    ])('maps permanent mixed-version failures to the unsupported presentation', (failure) => {
        expect(resolveSessionGoalFailurePresentation({ ok: false, ...failure })).toEqual({
            title: 't:session.workState.unsupportedTitle',
            message: 't:session.workState.unsupportedMessage',
        });
    });

    it.each([
        { error: 'session_goal_control_remote_unavailable', errorCode: 'session_goal_control_remote_unavailable' },
        { error: 'unsupported_session_runtime_method:session.goal.clear', errorCode: 'unsupported_session_runtime_method' },
    ])('keeps dynamic runtime unavailability in the retryable not-ready state', (failure) => {
        expect(resolveSessionGoalFailurePresentation({ ok: false, ...failure })).toEqual({
            title: 't:session.workState.notReadyTitle',
            message: 't:session.workState.notReadyMessage',
        });
    });
});
