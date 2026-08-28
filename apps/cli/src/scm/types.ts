import type {
    ScmBackendDescribeRequest,
    ScmBackendDescribeResponse,
    ScmBackendCapabilities,
    ScmBranchIntegrationRequest,
    ScmBranchIntegrationResponse,
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
    ScmBranchListRequest,
    ScmBranchListResponse,
    ScmBranchOperationControlRequest,
    ScmCapabilities,
    ScmChangeApplyRequest,
    ScmChangeApplyResponse,
    ScmChangeDiscardRequest,
    ScmChangeDiscardResponse,
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
    ScmPullRequestGetRequest,
    ScmPullRequestGetResponse,
    ScmPullRequestListRequest,
    ScmPullRequestListResponse,
    ScmPullRequestOpenComposeRequest,
    ScmPullRequestOpenComposeResponse,
    ScmPullRequestOpenOrReuseRequest,
    ScmPullRequestOpenOrReuseResponse,
    ScmPullRequestCheckoutRequest,
    ScmPullRequestCheckoutResponse,
    ScmPullRequestPrepareWorktreeRequest,
    ScmPullRequestPrepareWorktreeResponse,
    ScmPullRequestRunStackedRequest,
    ScmPullRequestRunStackedResponse,
    ScmHostingRepositoryDescribePublishTargetsRequest,
    ScmHostingRepositoryDescribePublishTargetsResponse,
    ScmHostingRepositoryPublishRequest,
    ScmHostingRepositoryPublishResponse,
    ScmRepositoryCloneInput,
    ScmRepositoryCloneOutput,
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemotePublishRequest,
    ScmRemotePublishResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteRequest,
    ScmRemoteResponse,
    ScmRemoteSetUrlRequest,
    ScmRepositoryInitRequest,
    ScmRepositoryInitResponse,
    ScmRepositoryRemoveIndexLockRequest,
    ScmRepositoryRemoveIndexLockResponse,
    ScmRepoMode,
    ScmReviewWorkspaceMaterializePreparedRequest,
    ScmReviewWorkspaceMaterializePreparedResponse,
    ScmStashApplyRequest,
    ScmStashApplyResponse,
    ScmStashDropRequest,
    ScmStashDropResponse,
    ScmStashListRequest,
    ScmStashListResponse,
    ScmStashPopRequest,
    ScmStashPopResponse,
    ScmStashShowRequest,
    ScmStashShowResponse,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
    ScmBackendId,
    WorkspaceCheckoutKind,
    WorkspaceLocationScm,
} from '@happier-dev/protocol';

import type { ScmWorkspaceIntegrationCheckoutMaterializationRequest } from './workspace/checkoutMaterialization';
import type {
    ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
    ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult,
} from './workspace/workspaceCheckoutCreation';
import type {
    ScmWorkspaceIntegrationPortableWorkspacePathClassification,
    ScmWorkspaceIntegrationPortableWorkspacePathRequest,
} from './workspace/portableWorkspacePath';
import type {
    ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
    ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
} from './workspace/workspaceCheckoutRealization';
import type { ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest } from './workspace/workspaceCheckoutMaterialization';
import type { ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult } from './workspace/workspaceCheckoutMaterialization';
import type {
    ScmWorkspaceIntegrationWorkspaceTransferEntry,
    ScmWorkspaceIntegrationWorkspaceTransferMetadata,
    ScmWorkspaceIntegrationWorkspaceTransferRequest,
    ScmWorkspaceIntegrationWorkspaceTransferResult,
} from './workspace/workspaceTransfer';

export type ScmRepoDetection = {
    isRepo: boolean;
    rootPath: string | null;
    mode: ScmRepoMode | null;
};

export type ScmBackendContext = {
    cwd: string;
    projectKey: string;
    detection: ScmRepoDetection;
    signal?: AbortSignal;
};

export type ScmBackendSelection = {
    modeSelectionScores: Partial<Record<ScmRepoMode, number>>;
    preferenceAllowedModes?: readonly ScmRepoMode[];
};

export type ScmWorkspaceIntegrationWorkspaceLocationInspection = Readonly<{
    rootPath: string;
    scmProvider?: WorkspaceLocationScm['provider'];
    checkoutDiscovery?: readonly ScmWorkspaceIntegrationCheckoutDiscovery[];
    checkoutProviderKinds?: readonly Exclude<WorkspaceCheckoutKind, 'primary'>[];
}>;

export type ScmWorkspaceIntegrationCheckoutDiscovery = Readonly<{
    kind: Exclude<WorkspaceCheckoutKind, 'primary'>;
    path?: string;
}>;

export type ScmWorkspaceIntegrationPostMaterializationInput = Readonly<{
    context: ScmBackendContext;
    checkoutMaterialization: ScmWorkspaceIntegrationCheckoutMaterializationRequest;
    sourcePath?: string;
    previousTargetPath?: string;
    workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferInput = Readonly<{
    context: ScmBackendContext;
    workspaceTransfer: ScmWorkspaceIntegrationWorkspaceTransferRequest;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferEntryInput = ScmWorkspaceIntegrationWorkspaceTransferEntry;

export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput = Readonly<{
    context: ScmBackendContext;
    workspaceCheckoutMaterialization: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest;
}>;

export type ScmWorkspaceIntegrationWorkspaceCheckoutCreationInput = Readonly<{
    context: ScmBackendContext;
    workspaceCheckoutCreation: ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest;
}>;

export type { ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult };

export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationInput = Readonly<{
    context: ScmBackendContext;
    workspaceCheckoutRealization: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest;
}>;

export type { ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult };

export type ScmWorkspaceIntegrationPrepareReviewWorkspaceInput = Readonly<{
    context: ScmBackendContext;
    request: ScmReviewWorkspaceMaterializePreparedRequest;
}>;

export type ScmWorkspaceIntegrationVerifyPreparedReviewWorkspaceInput = Readonly<{
    context: ScmBackendContext;
    request: ScmReviewWorkspaceMaterializePreparedRequest & Readonly<{
        verification: Readonly<{ targetPath: string }>;
    }>;
}>;

export type ScmWorkspaceIntegrationPortableWorkspaceEntriesInput = Readonly<{
    entries: readonly Readonly<{
        relativePath: string;
    }>[];
}>;

export type ScmWorkspaceIntegrationAdministrativePathInput = Readonly<{
    relativePath: string;
}>;

export type ScmWorkspaceIntegrationPortableWorkspacePathInput = ScmWorkspaceIntegrationPortableWorkspacePathRequest;

export type ScmWorkspaceIntegration = Readonly<{
    inspectWorkspaceLocation?: (input: Readonly<{
        context: ScmBackendContext;
    }>) => Promise<ScmWorkspaceIntegrationWorkspaceLocationInspection | null>;
    reconcilePostMaterialization?: (input: ScmWorkspaceIntegrationPostMaterializationInput) => Promise<void>;
    prepareReviewWorkspace?: (
        input: ScmWorkspaceIntegrationPrepareReviewWorkspaceInput,
    ) => Promise<ScmReviewWorkspaceMaterializePreparedResponse>;
    verifyPreparedReviewWorkspace?: (
        input: ScmWorkspaceIntegrationVerifyPreparedReviewWorkspaceInput,
    ) => Promise<ScmReviewWorkspaceMaterializePreparedResponse>;
    realizeWorkspaceCheckout?: (
        input: ScmWorkspaceIntegrationWorkspaceCheckoutRealizationInput,
    ) => Promise<ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult>;
    createWorkspaceCheckout?: (
        input: ScmWorkspaceIntegrationWorkspaceCheckoutCreationInput,
    ) => Promise<ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult>;
    materializeWorkspaceCheckout?: (
        input: ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationInput,
    ) => Promise<ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult | void>;
    resolveWorkspaceTransfer?: (input: ScmWorkspaceIntegrationWorkspaceTransferInput) => Promise<ScmWorkspaceIntegrationWorkspaceTransferResult | null>;
    resolveWorkspaceTransferEntries?: (input: ScmWorkspaceIntegrationWorkspaceTransferInput) => Promise<readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[] | null>;
    resolveWorkspaceTransferMetadata?: (input: ScmWorkspaceIntegrationWorkspaceTransferInput) => Promise<ScmWorkspaceIntegrationWorkspaceTransferMetadata | null>;
    assertPortableWorkspaceEntries?: (input: ScmWorkspaceIntegrationPortableWorkspaceEntriesInput) => Promise<void>;
    classifyPortableWorkspaceTransferEntry?: (
        input: ScmWorkspaceIntegrationWorkspaceTransferEntryInput,
    ) => ScmWorkspaceIntegrationPortableWorkspacePathClassification;
    isAdministrativeWorkspacePath?: (input: ScmWorkspaceIntegrationAdministrativePathInput) => boolean;
    classifyPortableWorkspacePath?: (input: ScmWorkspaceIntegrationPortableWorkspacePathInput) => ScmWorkspaceIntegrationPortableWorkspacePathClassification;
}>;

export interface ScmBackend {
    id: ScmBackendId;
    localId?: ScmBackendId;
    kind?: string;
    declaredCapabilities?: ScmBackendCapabilities;
    selection: ScmBackendSelection;
    workspaceIntegration?: ScmWorkspaceIntegration;
    detectRepo(input: { cwd: string }): Promise<ScmRepoDetection>;
    getCapabilities(input: {
        mode: ScmRepoMode | null;
        executableAvailable?: boolean;
    }): ScmCapabilities;
    describeBackend(input: {
        context: ScmBackendContext;
        request: ScmBackendDescribeRequest;
    }): Promise<ScmBackendDescribeResponse>;
    statusSnapshot(input: {
        context: ScmBackendContext;
        request: ScmStatusSnapshotRequest;
    }): Promise<ScmStatusSnapshotResponse>;
    worktreesEnrichment?(input: {
        context: ScmBackendContext;
        request: ScmWorktreesEnrichmentRequest;
    }): Promise<ScmWorktreesEnrichmentResponse>;
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
    changeDiscard(input: {
        context: ScmBackendContext;
        request: ScmChangeDiscardRequest;
    }): Promise<ScmChangeDiscardResponse>;
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
    branchList(input: {
        context: ScmBackendContext;
        request: ScmBranchListRequest;
    }): Promise<ScmBranchListResponse>;
    branchCreate(input: {
        context: ScmBackendContext;
        request: ScmBranchCreateRequest;
    }): Promise<ScmBranchCreateResponse>;
    branchCheckout(input: {
        context: ScmBackendContext;
        request: ScmBranchCheckoutRequest;
    }): Promise<ScmBranchCheckoutResponse>;
    branchMerge(input: {
        context: ScmBackendContext;
        request: ScmBranchIntegrationRequest;
    }): Promise<ScmBranchIntegrationResponse>;
    branchRebase(input: {
        context: ScmBackendContext;
        request: ScmBranchIntegrationRequest;
    }): Promise<ScmBranchIntegrationResponse>;
    branchOperationContinue(input: {
        context: ScmBackendContext;
        request: ScmBranchOperationControlRequest;
    }): Promise<ScmBranchIntegrationResponse>;
    branchOperationAbort(input: {
        context: ScmBackendContext;
        request: ScmBranchOperationControlRequest;
    }): Promise<ScmBranchIntegrationResponse>;
    worktreeCreate(input: {
        context: ScmBackendContext;
        request: ScmWorktreeCreateRequest;
    }): Promise<ScmWorktreeCreateResponse>;
    worktreeRemove(input: {
        context: ScmBackendContext;
        request: ScmWorktreeRemoveRequest;
    }): Promise<ScmWorktreeRemoveResponse>;
    worktreePrune(input: {
        context: ScmBackendContext;
        request: ScmWorktreePruneRequest;
    }): Promise<ScmWorktreePruneResponse>;
    remoteAdd(input: {
        context: ScmBackendContext;
        request: ScmRemoteAddRequest;
    }): Promise<ScmRemoteManagementResponse>;
    remoteSetUrl(input: {
        context: ScmBackendContext;
        request: ScmRemoteSetUrlRequest;
    }): Promise<ScmRemoteManagementResponse>;
    remoteRemove(input: {
        context: ScmBackendContext;
        request: ScmRemoteRemoveRequest;
    }): Promise<ScmRemoteManagementResponse>;
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
    remotePublish(input: {
        context: ScmBackendContext;
        request: ScmRemotePublishRequest;
    }): Promise<ScmRemotePublishResponse>;
    pullRequestList?(input: {
        context: ScmBackendContext;
        request: ScmPullRequestListRequest;
    }): Promise<ScmPullRequestListResponse>;
    pullRequestGet?(input: {
        context: ScmBackendContext;
        request: ScmPullRequestGetRequest;
    }): Promise<ScmPullRequestGetResponse>;
    pullRequestOpenCompose?(input: {
        context: ScmBackendContext;
        request: ScmPullRequestOpenComposeRequest;
    }): Promise<ScmPullRequestOpenComposeResponse>;
    pullRequestOpenOrReuse?(input: {
        context: ScmBackendContext;
        request: ScmPullRequestOpenOrReuseRequest;
    }): Promise<ScmPullRequestOpenOrReuseResponse>;
    pullRequestCheckout?(input: {
        context: ScmBackendContext;
        request: ScmPullRequestCheckoutRequest;
    }): Promise<ScmPullRequestCheckoutResponse>;
    pullRequestPrepareWorktree?(input: {
        context: ScmBackendContext;
        request: ScmPullRequestPrepareWorktreeRequest;
    }): Promise<ScmPullRequestPrepareWorktreeResponse>;
    pullRequestRunStacked?(input: {
        context: ScmBackendContext;
        request: ScmPullRequestRunStackedRequest;
    }): Promise<ScmPullRequestRunStackedResponse>;
    hostingRepositoryDescribePublishTargets?(input: {
        context: ScmBackendContext;
        request: ScmHostingRepositoryDescribePublishTargetsRequest;
    }): Promise<ScmHostingRepositoryDescribePublishTargetsResponse>;
    repositoryInit?(input: {
        context: ScmBackendContext;
        request: ScmRepositoryInitRequest;
    }): Promise<ScmRepositoryInitResponse>;
    hostingRepositoryPublish?(input: {
        context: ScmBackendContext;
        request: ScmHostingRepositoryPublishRequest;
    }): Promise<ScmHostingRepositoryPublishResponse>;
    repositoryClone?(input: {
        context: ScmBackendContext;
        request: ScmRepositoryCloneInput;
    }): Promise<ScmRepositoryCloneOutput>;
    removeIndexLock?(input: {
        context: ScmBackendContext;
        request: ScmRepositoryRemoveIndexLockRequest;
    }): Promise<ScmRepositoryRemoveIndexLockResponse>;
    stashList(input: {
        context: ScmBackendContext;
        request: ScmStashListRequest;
    }): Promise<ScmStashListResponse>;
    stashDrop(input: {
        context: ScmBackendContext;
        request: ScmStashDropRequest;
    }): Promise<ScmStashDropResponse>;
    stashPop(input: {
        context: ScmBackendContext;
        request: ScmStashPopRequest;
    }): Promise<ScmStashPopResponse>;
    stashApply(input: {
        context: ScmBackendContext;
        request: ScmStashApplyRequest;
    }): Promise<ScmStashApplyResponse>;
    stashShow(input: {
        context: ScmBackendContext;
        request: ScmStashShowRequest;
    }): Promise<ScmStashShowResponse>;
}
