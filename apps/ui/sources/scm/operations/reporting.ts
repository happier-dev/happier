import type {
    ScmProjectOperationKind,
    ScmProjectOperationLogEntry,
    ScmProjectOperationStatus,
} from '@/sync/runtime/orchestration/projectManager';
import { classifyScmOperationErrorCode, type ScmOperationErrorCode, type ScmOperationOutcome } from '@happier-dev/protocol/scm';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

export interface ScmOperationTracker {
    capture(event: string, props?: Record<string, unknown>): void;
}

type ScmOperationSurface = 'files' | 'file' | 'commit' | 'update';

interface ScmOperationState {
    appendSessionProjectScmOperation: (
        sessionId: string,
        entry: Omit<ScmProjectOperationLogEntry, 'id' | 'sessionId'>,
        serverId?: string,
    ) => void;
}

interface WorkspaceScmOperationState {
    appendWorkspaceScmOperation: (
        scope: WorkspaceScopeBase,
        entry: Omit<ScmProjectOperationLogEntry, 'id' | 'sessionId'>,
    ) => void;
}

export function trackBlockedScmOperation(input: {
    operation: ScmProjectOperationKind;
    reason: 'preflight' | 'lock';
    message?: string;
    surface: ScmOperationSurface;
    tracking?: ScmOperationTracker | null;
}) {
    input.tracking?.capture('scm_operation_blocked', {
        operation: input.operation,
        reason: input.reason,
        surface: input.surface,
        has_message: Boolean(input.message),
        message_length: input.message?.length ?? 0,
    });
}

export function reportSessionScmOperation(input: {
    state: ScmOperationState;
    sessionId: string;
    serverId?: string;
    operation: ScmProjectOperationKind;
    status: ScmProjectOperationStatus;
    surface: ScmOperationSurface;
    path?: string;
    detail?: string;
    rawError?: string;
    errorCode?: ScmOperationErrorCode;
    outcome?: ScmOperationOutcome;
    failure?: ActionExecuteFailure;
    now?: number;
    tracking?: ScmOperationTracker | null;
}) {
    const timestamp = input.now ?? Date.now();
    const errorCode = input.outcome ? ('errorCode' in input.outcome ? input.outcome.errorCode : undefined) : input.errorCode;

    input.state.appendSessionProjectScmOperation(input.sessionId, {
        operation: input.operation,
        status: input.status,
        timestamp,
        ...(input.path ? { path: input.path } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(input.failure ? { failure: input.failure } : {}),
    }, ...(input.serverId === undefined ? [] : [input.serverId]));

    input.tracking?.capture('scm_operation_result', {
        operation: input.operation,
        status: input.status,
        surface: input.surface,
        error_code: errorCode ?? 'none',
        error_category: errorCode ? classifyScmOperationErrorCode(errorCode) : 'none',
        has_path: Boolean(input.path),
        has_detail: Boolean(input.detail),
        detail_length: input.detail?.length ?? 0,
        ...(input.outcome ? { outcome: input.outcome.kind } : {}),
    });
}

export function reportWorkspaceScmOperation(input: {
    state: WorkspaceScmOperationState;
    scope: WorkspaceScopeBase;
    operation: ScmProjectOperationKind;
    status: ScmProjectOperationStatus;
    surface: ScmOperationSurface;
    path?: string;
    detail?: string;
    rawError?: string;
    errorCode?: ScmOperationErrorCode;
    outcome?: ScmOperationOutcome;
    failure?: ActionExecuteFailure;
    now?: number;
    tracking?: ScmOperationTracker | null;
}) {
    const timestamp = input.now ?? Date.now();
    const errorCode = input.outcome ? ('errorCode' in input.outcome ? input.outcome.errorCode : undefined) : input.errorCode;

    input.state.appendWorkspaceScmOperation(input.scope, {
        operation: input.operation,
        status: input.status,
        timestamp,
        ...(input.path ? { path: input.path } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(input.failure ? { failure: input.failure } : {}),
    });

    input.tracking?.capture('scm_operation_result', {
        operation: input.operation,
        status: input.status,
        surface: input.surface,
        error_code: errorCode ?? 'none',
        error_category: errorCode ? classifyScmOperationErrorCode(errorCode) : 'none',
        has_path: Boolean(input.path),
        has_detail: Boolean(input.detail),
        detail_length: input.detail?.length ?? 0,
        ...(input.outcome ? { outcome: input.outcome.kind } : {}),
    });
}
