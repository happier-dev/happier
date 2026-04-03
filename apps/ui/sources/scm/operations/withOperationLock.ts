import type {
    BeginScmProjectOperationResult,
    ScmProjectOperationKind,
} from '@/sync/runtime/orchestration/projectManager';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

type ScmOperationLockState = {
    beginSessionProjectScmOperation: (
        sessionId: string,
        operation: ScmProjectOperationKind,
    ) => BeginScmProjectOperationResult;
    finishSessionProjectScmOperation: (sessionId: string, operationId: string) => boolean;
};

type ScmWorkspaceOperationLockState = {
    beginWorkspaceScmOperation: (
        scope: WorkspaceScopeBase,
        operation: ScmProjectOperationKind,
    ) => BeginScmProjectOperationResult;
    finishWorkspaceScmOperation: (scope: WorkspaceScopeBase, operationId: string) => boolean;
};

export type WithSessionProjectScmOperationResult<T> =
    | { started: false; message: string }
    | { started: true; value: T };

export type WithWorkspaceScmOperationResult<T> = WithSessionProjectScmOperationResult<T>;

export async function withSessionProjectScmOperationLock<T>(input: {
    state: ScmOperationLockState;
    sessionId: string;
    operation: ScmProjectOperationKind;
    run: () => Promise<T>;
}): Promise<WithSessionProjectScmOperationResult<T>> {
    const start = input.state.beginSessionProjectScmOperation(input.sessionId, input.operation);
    if (!start.started) {
        return {
            started: false,
            message: toBlockedMessage(start),
        };
    }

    const operationId = start.operation.id;
    try {
        const value = await input.run();
        return { started: true, value };
    } finally {
        input.state.finishSessionProjectScmOperation(input.sessionId, operationId);
    }
}

export async function withWorkspaceScmOperationLock<T>(input: {
    state: ScmWorkspaceOperationLockState;
    scope: WorkspaceScopeBase;
    operation: ScmProjectOperationKind;
    run: () => Promise<T>;
}): Promise<WithWorkspaceScmOperationResult<T>> {
    const start = input.state.beginWorkspaceScmOperation(input.scope, input.operation);
    if (!start.started) {
        return {
            started: false,
            message: toBlockedMessage(start),
        };
    }

    const operationId = start.operation.id;
    try {
        const value = await input.run();
        return { started: true, value };
    } finally {
        input.state.finishWorkspaceScmOperation(input.scope, operationId);
    }
}

function toBlockedMessage(start: Extract<BeginScmProjectOperationResult, { started: false }>): string {
    if (start.reason === 'missing_project') {
        return 'Session project context is unavailable.';
    }
    if (start.inFlight) {
        return `Another source-control operation is already running (${start.inFlight.operation}).`;
    }
    return 'Another source-control operation is already running.';
}
