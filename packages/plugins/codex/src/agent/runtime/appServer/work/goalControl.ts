import type {
    SessionWorkStateStatusV1,
    SessionWorkStateV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type CodexAppServerGoalControlErrorCode =
  | 'goal_not_found'
  | 'goal_thread_id_missing'
  | 'goal_objective_required'
  | 'invalid_goal_status'
  | 'unsupported_session_runtime_method';

export type CodexAppServerGoalControlError = Readonly<{
    ok: false;
    errorCode: CodexAppServerGoalControlErrorCode;
    error: string;
}>;

export type CodexAppServerGoalControlSuccess = Readonly<{
    workState: SessionWorkStateV1 | null;
    metadata: Record<string, unknown>;
}>;

export type CodexAppServerGoalControlResult =
  | CodexAppServerGoalControlSuccess
  | CodexAppServerGoalControlError;

export type CodexAppServerGoalControlContext = Readonly<{
    cwd: string;
    metadata: Record<string, unknown> | null;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    processEnv?: Readonly<Record<string, string | undefined>>;
    timeoutMs?: number | null;
}>;

export type CodexAppServerGoalSetMutation = Readonly<{
    objective?: string;
    status?: SessionWorkStateStatusV1;
    tokenBudget?: number | null;
}>;

export type CodexAppServerGoalControlAdapter = Readonly<{
    getGoal: (params: CodexAppServerGoalControlContext) => Promise<CodexAppServerGoalControlResult>;
    setGoal: (
        params: CodexAppServerGoalControlContext & CodexAppServerGoalSetMutation
    ) => Promise<CodexAppServerGoalControlResult>;
    clearGoal: (params: CodexAppServerGoalControlContext) => Promise<CodexAppServerGoalControlResult>;
}>;

export function unsupportedGoalControlMethod(method: string): CodexAppServerGoalControlError {
    return {
        ok: false,
        errorCode: 'unsupported_session_runtime_method',
        error: `unsupported_session_runtime_method:${method}`,
    };
}

export function unsupportedGoalGet(): CodexAppServerGoalControlError {
    return unsupportedGoalControlMethod(SESSION_RPC_METHODS.SESSION_GOAL_GET);
}

export function unsupportedGoalSet(): CodexAppServerGoalControlError {
    return unsupportedGoalControlMethod(SESSION_RPC_METHODS.SESSION_GOAL_SET);
}

export function unsupportedGoalClear(): CodexAppServerGoalControlError {
    return unsupportedGoalControlMethod(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR);
}

export function goalThreadIdMissing(): CodexAppServerGoalControlError {
    return { ok: false, errorCode: 'goal_thread_id_missing', error: 'goal_thread_id_missing' };
}

export function goalNotFound(): CodexAppServerGoalControlError {
    return { ok: false, errorCode: 'goal_not_found', error: 'goal_not_found' };
}

export function goalObjectiveRequired(): CodexAppServerGoalControlError {
    return { ok: false, errorCode: 'goal_objective_required', error: 'goal_objective_required' };
}

export function invalidGoalStatus(): CodexAppServerGoalControlError {
    return { ok: false, errorCode: 'invalid_goal_status', error: 'invalid_goal_status' };
}
