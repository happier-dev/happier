import type {
    SessionWorkStateStatusV1,
    SessionWorkStateV1,
} from '@happier-dev/protocol';

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
    processEnv?: NodeJS.ProcessEnv;
    timeoutMs?: number | null;
}>;

export type CodexAppServerGoalSetMutation = Readonly<{
    objective?: string;
    status?: SessionWorkStateStatusV1;
}>;

export type CodexAppServerGoalControlAdapter = Readonly<{
    getGoal: (params: CodexAppServerGoalControlContext) => Promise<CodexAppServerGoalControlResult>;
    setGoal: (
        params: CodexAppServerGoalControlContext & CodexAppServerGoalSetMutation
    ) => Promise<CodexAppServerGoalControlResult>;
    clearGoal: (params: CodexAppServerGoalControlContext) => Promise<CodexAppServerGoalControlResult>;
}>;
