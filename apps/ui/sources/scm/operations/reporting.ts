import type {
    ScmProjectOperationKind,
    ScmProjectOperationLogEntry,
    ScmProjectOperationStatus,
} from '@/sync/runtime/orchestration/projectManager';
import { classifyScmOperationErrorCode, type ScmOperationErrorCode } from '@happier-dev/protocol';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export interface ScmOperationTracker {
    capture(event: string, props?: Record<string, unknown>): void;
}

type ScmOperationSurface = 'files' | 'file' | 'commit' | 'update';

interface ScmOperationState {
    appendSessionProjectScmOperation: (
        sessionId: string,
        entry: Omit<ScmProjectOperationLogEntry, 'id' | 'sessionId'>,
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
    operation: ScmProjectOperationKind;
    status: ScmProjectOperationStatus;
    surface: ScmOperationSurface;
    path?: string;
    detail?: string;
    rawError?: string;
    errorCode?: ScmOperationErrorCode;
    now?: number;
    tracking?: ScmOperationTracker | null;
}) {
    const timestamp = input.now ?? Date.now();

    input.state.appendSessionProjectScmOperation(input.sessionId, {
        operation: input.operation,
        status: input.status,
        timestamp,
        ...(input.path ? { path: input.path } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
    });

    input.tracking?.capture('scm_operation_result', {
        operation: input.operation,
        status: input.status,
        surface: input.surface,
        error_code: input.errorCode ?? 'none',
        error_category: input.errorCode ? classifyScmOperationErrorCode(input.errorCode) : 'none',
        has_path: Boolean(input.path),
        has_detail: Boolean(input.detail),
        detail_length: input.detail?.length ?? 0,
        ...(input.rawError ? { raw_error: input.rawError, raw_error_length: input.rawError.length } : {}),
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
    now?: number;
    tracking?: ScmOperationTracker | null;
}) {
    const timestamp = input.now ?? Date.now();

    input.state.appendWorkspaceScmOperation(input.scope, {
        operation: input.operation,
        status: input.status,
        timestamp,
        ...(input.path ? { path: input.path } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
    });

    input.tracking?.capture('scm_operation_result', {
        operation: input.operation,
        status: input.status,
        surface: input.surface,
        error_code: input.errorCode ?? 'none',
        error_category: input.errorCode ? classifyScmOperationErrorCode(input.errorCode) : 'none',
        has_path: Boolean(input.path),
        has_detail: Boolean(input.detail),
        detail_length: input.detail?.length ?? 0,
        ...(input.rawError ? { raw_error: input.rawError, raw_error_length: input.rawError.length } : {}),
    });
}
