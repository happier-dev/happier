import type {
    GitProjectOperationKind,
    GitProjectOperationLogEntry,
    GitProjectOperationStatus,
} from '@/sync/runtime/orchestration/projectManager';

export interface GitOperationTracker {
    capture(event: string, props?: Record<string, unknown>): void;
}

interface GitOperationState {
    appendSessionProjectGitOperation: (
        sessionId: string,
        entry: Omit<GitProjectOperationLogEntry, 'id' | 'sessionId'>,
    ) => void;
}

export function trackBlockedGitOperation(input: {
    operation: GitProjectOperationKind;
    reason: 'preflight' | 'lock';
    message?: string;
    surface: 'files' | 'file' | 'commit';
    tracking?: GitOperationTracker | null;
}) {
    input.tracking?.capture('git_operation_blocked', {
        operation: input.operation,
        reason: input.reason,
        surface: input.surface,
        has_message: Boolean(input.message),
        message_length: input.message?.length ?? 0,
    });
}

export function reportSessionGitOperation(input: {
    state: GitOperationState;
    sessionId: string;
    operation: GitProjectOperationKind;
    status: GitProjectOperationStatus;
    surface: 'files' | 'file' | 'commit';
    path?: string;
    detail?: string;
    errorCode?: string;
    now?: number;
    tracking?: GitOperationTracker | null;
}) {
    const timestamp = input.now ?? Date.now();

    input.state.appendSessionProjectGitOperation(input.sessionId, {
        operation: input.operation,
        status: input.status,
        timestamp,
        ...(input.path ? { path: input.path } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
    });

    input.tracking?.capture('git_operation_result', {
        operation: input.operation,
        status: input.status,
        surface: input.surface,
        error_code: input.errorCode ?? 'none',
        has_path: Boolean(input.path),
        has_detail: Boolean(input.detail),
        detail_length: input.detail?.length ?? 0,
    });
}
