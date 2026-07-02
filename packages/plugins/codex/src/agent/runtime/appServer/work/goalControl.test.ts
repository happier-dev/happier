import { describe, expect, it } from 'vitest';

import {
    goalObjectiveRequired,
    goalThreadIdMissing,
    invalidGoalStatus,
    unsupportedGoalSet,
} from './goalControl';

describe('Codex app-server goal-control result policy', () => {
    it('builds provider goal-control errors with stable codes', () => {
        expect(goalThreadIdMissing()).toEqual({
            ok: false,
            errorCode: 'goal_thread_id_missing',
            error: 'goal_thread_id_missing',
        });
        expect(goalObjectiveRequired()).toEqual({
            ok: false,
            errorCode: 'goal_objective_required',
            error: 'goal_objective_required',
        });
        expect(invalidGoalStatus()).toEqual({
            ok: false,
            errorCode: 'invalid_goal_status',
            error: 'invalid_goal_status',
        });
    });

    it('uses the canonical session goal RPC method name for unsupported goal mutations', () => {
        expect(unsupportedGoalSet()).toEqual({
            ok: false,
            errorCode: 'unsupported_session_runtime_method',
            error: 'unsupported_session_runtime_method:session.goal.set',
        });
    });
});
