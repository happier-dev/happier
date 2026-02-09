import type {
    BeginGitProjectOperationResult,
    GitProjectOperationKind,
} from '../../projectManager';

type GitOperationLockState = {
    beginSessionProjectGitOperation: (
        sessionId: string,
        operation: GitProjectOperationKind,
    ) => BeginGitProjectOperationResult;
    finishSessionProjectGitOperation: (sessionId: string, operationId: string) => boolean;
};

export type WithSessionProjectGitOperationResult<T> =
    | { started: false; message: string }
    | { started: true; value: T };

export async function withSessionProjectGitOperationLock<T>(input: {
    state: GitOperationLockState;
    sessionId: string;
    operation: GitProjectOperationKind;
    run: () => Promise<T>;
}): Promise<WithSessionProjectGitOperationResult<T>> {
    const start = input.state.beginSessionProjectGitOperation(input.sessionId, input.operation);
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
        input.state.finishSessionProjectGitOperation(input.sessionId, operationId);
    }
}

function toBlockedMessage(start: Extract<BeginGitProjectOperationResult, { started: false }>): string {
    if (start.reason === 'missing_project') {
        return 'Session project context is unavailable.';
    }
    if (start.inFlight) {
        return `Another Git operation is already running (${start.inFlight.operation}).`;
    }
    return 'Another Git operation is already running.';
}
