import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmCapabilities,
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
    ScmRepoMode,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
    ScmBackendId,
} from '@happier-dev/protocol';

export type ScmRepoDetection = {
    isRepo: boolean;
    rootPath: string | null;
    mode: ScmRepoMode | null;
};

export type ScmBackendContext = {
    cwd: string;
    projectKey: string;
    detection: ScmRepoDetection;
};

export type ScmBackendSelection = {
    modeSelectionScores: Partial<Record<ScmRepoMode, number>>;
    preferenceAllowedModes?: readonly ScmRepoMode[];
};

export interface ScmBackend {
    id: ScmBackendId;
    selection: ScmBackendSelection;
    detectRepo(input: { cwd: string }): Promise<ScmRepoDetection>;
    getCapabilities(input: { mode: ScmRepoMode | null }): ScmCapabilities;
    describeBackend(input: {
        context: ScmBackendContext;
        request: ScmBackendDescribeRequest;
    }): Promise<ScmBackendDescribeResponse>;
    statusSnapshot(input: {
        context: ScmBackendContext;
        request: ScmStatusSnapshotRequest;
    }): Promise<ScmStatusSnapshotResponse>;
    diffFile(input: {
        context: ScmBackendContext;
        request: ScmDiffFileRequest;
    }): Promise<ScmDiffFileResponse>;
    diffCommit(input: {
        context: ScmBackendContext;
        request: ScmDiffCommitRequest;
    }): Promise<ScmDiffCommitResponse>;
    changeInclude(input: {
        context: ScmBackendContext;
        request: ScmChangeApplyRequest;
    }): Promise<ScmChangeApplyResponse>;
    changeExclude(input: {
        context: ScmBackendContext;
        request: ScmChangeApplyRequest;
    }): Promise<ScmChangeApplyResponse>;
    commitCreate(input: {
        context: ScmBackendContext;
        request: ScmCommitCreateRequest;
    }): Promise<ScmCommitCreateResponse>;
    commitBackout(input: {
        context: ScmBackendContext;
        request: ScmCommitBackoutRequest;
    }): Promise<ScmCommitBackoutResponse>;
    logList(input: {
        context: ScmBackendContext;
        request: ScmLogListRequest;
    }): Promise<ScmLogListResponse>;
    remoteFetch(input: {
        context: ScmBackendContext;
        request: ScmRemoteRequest;
    }): Promise<ScmRemoteResponse>;
    remotePull(input: {
        context: ScmBackendContext;
        request: ScmRemoteRequest;
    }): Promise<ScmRemoteResponse>;
    remotePush(input: {
        context: ScmBackendContext;
        request: ScmRemoteRequest;
    }): Promise<ScmRemoteResponse>;
}
