import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', () => ({ t: (key: string) => key }));

import { resolveSessionGoalFailurePresentation } from './sessionGoalOperationFailure';

describe('resolveSessionGoalFailurePresentation', () => {
    it('classifies permanent mixed-version failures as unsupported', () => {
        expect(resolveSessionGoalFailurePresentation({
            ok: false,
            error: 'Method not found',
            errorCode: 'RPC_METHOD_NOT_FOUND',
        })).toEqual({
            title: 'session.workState.unsupportedTitle',
            message: 'session.workState.unsupportedMessage',
        });

        expect(resolveSessionGoalFailurePresentation({
            ok: false,
            error: 'session_goal_control_unsupported',
            errorCode: 'session_goal_control_unsupported',
        })).toEqual({
            title: 'session.workState.unsupportedTitle',
            message: 'session.workState.unsupportedMessage',
        });
    });

    it('keeps dynamic remote unavailability in the retryable not-ready state', () => {
        expect(resolveSessionGoalFailurePresentation({
            ok: false,
            error: 'session_goal_control_remote_unavailable',
            errorCode: 'session_goal_control_remote_unavailable',
        })).toEqual({
            title: 'session.workState.notReadyTitle',
            message: 'session.workState.notReadyMessage',
        });
    });
});
