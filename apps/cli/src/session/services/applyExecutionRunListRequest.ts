import {
    buildBackendTargetKey,
    type ExecutionRunListRequest,
    type ExecutionRunPublicState,
} from '@happier-dev/protocol';

function compareExecutionRunPublicStates(left: ExecutionRunPublicState, right: ExecutionRunPublicState): number {
    if (left.startedAtMs !== right.startedAtMs) {
        return left.startedAtMs - right.startedAtMs;
    }
    return left.runId.localeCompare(right.runId);
}

export function applyExecutionRunListRequest(
    runs: readonly ExecutionRunPublicState[],
    request: ExecutionRunListRequest,
): readonly ExecutionRunPublicState[] {
    const requestedBackendId =
        typeof request.backendId === 'string' && request.backendId.trim().length > 0 ? request.backendId.trim() : null;
    const requestedBackendTargetKey =
        request.backendTarget ? buildBackendTargetKey(request.backendTarget) : null;
    const requestedStatus =
        typeof request.status === 'string' && request.status.trim().length > 0 ? request.status.trim() : null;
    const requestedLimit =
        typeof request.limit === 'number' && Number.isFinite(request.limit) && request.limit > 0
            ? Math.floor(request.limit)
            : null;

    let filtered = [...runs].sort(compareExecutionRunPublicStates);
    if (requestedBackendId) {
        filtered = filtered.filter((run) => {
            if (run.backendTarget.kind === 'builtInAgent') {
                return run.backendTarget.agentId === requestedBackendId;
            }
            return run.backendTarget.backendId === requestedBackendId;
        });
    }
    if (requestedBackendTargetKey) {
        filtered = filtered.filter((run) => buildBackendTargetKey(run.backendTarget) === requestedBackendTargetKey);
    }
    if (requestedStatus) {
        filtered = filtered.filter((run) => run.status === requestedStatus);
    }
    if (requestedLimit !== null) {
        filtered = filtered.slice(0, requestedLimit);
    }

    return filtered;
}
