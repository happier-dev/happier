import type {
    ScmChangeApplyRequest,
    ScmChangeApplyResponse,
    ScmCommitBackoutRequest,
    ScmCommitBackoutResponse,
    ScmCommitCreateRequest,
    ScmCommitCreateResponse,
    ScmDiffCommitRequest,
    ScmDiffCommitResponse,
    ScmDiffFileRequest,
    ScmDiffFileResponse,
    ScmLogListRequest,
    ScmLogListResponse,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { storage } from '../domains/state/storage';
import { apiSocket } from '../api/session/apiSocket';

function scmFallbackError<T extends { success: boolean; error?: string; errorCode?: string }>(error: unknown): T {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
        success: false,
        error: message,
        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    } as T;
}

function withScmBackendPreference<T extends { backendPreference?: unknown }>(request: T): T {
    const preferredBackend = storage.getState().settings.scmGitRepoPreferredBackend;
    if (preferredBackend === 'sapling') {
        return {
            ...request,
            backendPreference: {
                kind: 'prefer',
                backendId: 'sapling',
            },
        };
    }
    return request;
}

export async function sessionScmStatusSnapshot(
    sessionId: string,
    request: ScmStatusSnapshotRequest
): Promise<ScmStatusSnapshotResponse> {
    try {
        return await apiSocket.sessionRPC<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            sessionId,
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmStatusSnapshotResponse>(error);
    }
}

export async function sessionScmDiffFile(
    sessionId: string,
    request: ScmDiffFileRequest
): Promise<ScmDiffFileResponse> {
    try {
        return await apiSocket.sessionRPC<ScmDiffFileResponse, ScmDiffFileRequest>(
            sessionId,
            RPC_METHODS.SCM_DIFF_FILE,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmDiffFileResponse>(error);
    }
}

export async function sessionScmDiffCommit(
    sessionId: string,
    request: ScmDiffCommitRequest
): Promise<ScmDiffCommitResponse> {
    try {
        return await apiSocket.sessionRPC<ScmDiffCommitResponse, ScmDiffCommitRequest>(
            sessionId,
            RPC_METHODS.SCM_DIFF_COMMIT,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmDiffCommitResponse>(error);
    }
}

export async function sessionScmChangeInclude(
    sessionId: string,
    request: ScmChangeApplyRequest
): Promise<ScmChangeApplyResponse> {
    try {
        return await apiSocket.sessionRPC<ScmChangeApplyResponse, ScmChangeApplyRequest>(
            sessionId,
            RPC_METHODS.SCM_CHANGE_INCLUDE,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmChangeApplyResponse>(error);
    }
}

export async function sessionScmChangeExclude(
    sessionId: string,
    request: ScmChangeApplyRequest
): Promise<ScmChangeApplyResponse> {
    try {
        return await apiSocket.sessionRPC<ScmChangeApplyResponse, ScmChangeApplyRequest>(
            sessionId,
            RPC_METHODS.SCM_CHANGE_EXCLUDE,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmChangeApplyResponse>(error);
    }
}

export async function sessionScmCommitCreate(
    sessionId: string,
    request: ScmCommitCreateRequest
): Promise<ScmCommitCreateResponse> {
    try {
        return await apiSocket.sessionRPC<ScmCommitCreateResponse, ScmCommitCreateRequest>(
            sessionId,
            RPC_METHODS.SCM_COMMIT_CREATE,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmCommitCreateResponse>(error);
    }
}

export async function sessionScmLogList(
    sessionId: string,
    request: ScmLogListRequest
): Promise<ScmLogListResponse> {
    try {
        return await apiSocket.sessionRPC<ScmLogListResponse, ScmLogListRequest>(
            sessionId,
            RPC_METHODS.SCM_LOG_LIST,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmLogListResponse>(error);
    }
}

export async function sessionScmCommitBackout(
    sessionId: string,
    request: ScmCommitBackoutRequest
): Promise<ScmCommitBackoutResponse> {
    try {
        return await apiSocket.sessionRPC<ScmCommitBackoutResponse, ScmCommitBackoutRequest>(
            sessionId,
            RPC_METHODS.SCM_COMMIT_BACKOUT,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmCommitBackoutResponse>(error);
    }
}

export async function sessionScmRemoteFetch(
    sessionId: string,
    request: ScmRemoteRequest
): Promise<ScmRemoteResponse> {
    try {
        return await apiSocket.sessionRPC<ScmRemoteResponse, ScmRemoteRequest>(
            sessionId,
            RPC_METHODS.SCM_REMOTE_FETCH,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmRemoteResponse>(error);
    }
}

export async function sessionScmRemotePush(
    sessionId: string,
    request: ScmRemoteRequest
): Promise<ScmRemoteResponse> {
    try {
        return await apiSocket.sessionRPC<ScmRemoteResponse, ScmRemoteRequest>(
            sessionId,
            RPC_METHODS.SCM_REMOTE_PUSH,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmRemoteResponse>(error);
    }
}

export async function sessionScmRemotePull(
    sessionId: string,
    request: ScmRemoteRequest
): Promise<ScmRemoteResponse> {
    try {
        return await apiSocket.sessionRPC<ScmRemoteResponse, ScmRemoteRequest>(
            sessionId,
            RPC_METHODS.SCM_REMOTE_PULL,
            withScmBackendPreference(request)
        );
    } catch (error) {
        return scmFallbackError<ScmRemoteResponse>(error);
    }
}
