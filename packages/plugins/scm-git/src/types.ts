import type {
  ScmBackendDescribeRequest,
  ScmBackendDescribeResponse,
  ScmBackendCapabilities,
  ScmBackendId,
  ScmBranchCheckoutRequest,
  ScmBranchCheckoutResponse,
  ScmBranchCreateRequest,
  ScmBranchCreateResponse,
  ScmBranchIntegrationRequest,
  ScmBranchIntegrationResponse,
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
  ScmHostingRepositoryDescribePublishTargetsRequest,
  ScmHostingRepositoryDescribePublishTargetsResponse,
  ScmHostingRepositoryPublishRequest,
  ScmHostingRepositoryPublishResponse,
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
  ScmRemoteAddRequest,
  ScmRemoteManagementResponse,
  ScmRemotePublishRequest,
  ScmRemotePublishResponse,
  ScmRemoteRemoveRequest,
  ScmRemoteRequest,
  ScmRemoteResponse,
  ScmRemoteSetUrlRequest,
  ScmRepoMode,
  ScmRepositoryCloneInput,
  ScmRepositoryCloneOutput,
  ScmRepositoryInitRequest,
  ScmRepositoryInitResponse,
  ScmRepositoryRemoveIndexLockRequest,
  ScmRepositoryRemoveIndexLockResponse,
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
  ScmWorktreesEnrichmentRequest,
  ScmWorktreesEnrichmentResponse,
  ScmWorktreeCreateRequest,
  ScmWorktreeCreateResponse,
  ScmWorktreePruneRequest,
  ScmWorktreePruneResponse,
  ScmWorktreeRemoveRequest,
  ScmWorktreeRemoveResponse,
} from '@happier-dev/plugin-sdk/scm';
import type {
  ScmBackendRuntimeContext,
  ScmBackendRuntimeDetection,
  ScmBackendRuntimeWorkspaceIntegrationHandlers,
  ScmWorkspaceIntegrationWorkspaceLocationInspection,
  ScmWorkspaceIntegrationCheckoutMaterializationRequest,
  ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
  ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult,
  ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
  ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
  ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
  ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
  ScmWorkspaceIntegrationWorkspaceTransferRequest,
  ScmWorkspaceIntegrationWorkspaceTransferResult,
  ScmWorkspaceIntegrationWorkspaceTransferEntry,
  ScmWorkspaceIntegrationWorkspaceTransferMetadata,
  ScmWorkspaceIntegrationPortableWorkspacePathClassification,
  ScmWorkspaceIntegrationPortableWorkspacePathRequest,
} from '@happier-dev/plugin-sdk';

export type ScmRepoDetection = ScmBackendRuntimeDetection;
export type ScmBackendContext = ScmBackendRuntimeContext;
export type ScmWorkspaceIntegration = ScmBackendRuntimeWorkspaceIntegrationHandlers;
export type { ScmWorkspaceIntegrationWorkspaceLocationInspection };

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

export type ScmWorkspaceIntegrationPortableWorkspaceEntriesInput = Readonly<{
  entries: readonly Readonly<{ relativePath: string }>[];
}>;

export type ScmWorkspaceIntegrationAdministrativePathInput = Readonly<{
  relativePath: string;
}>;

export type ScmWorkspaceIntegrationPortableWorkspacePathInput = ScmWorkspaceIntegrationPortableWorkspacePathRequest;

export type {
  ScmWorkspaceIntegrationWorkspaceTransferEntry,
  ScmWorkspaceIntegrationWorkspaceTransferMetadata,
  ScmWorkspaceIntegrationWorkspaceTransferResult,
  ScmWorkspaceIntegrationPortableWorkspacePathClassification,
};

export type ScmBackendSelection = {
  modeSelectionScores: Partial<Record<ScmRepoMode, number>>;
  preferenceAllowedModes?: readonly ScmRepoMode[];
};

export interface ScmBackend {
  id: ScmBackendId;
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
  hostingRepositoryPublish?(input: {
    context: ScmBackendContext;
    request: ScmHostingRepositoryPublishRequest;
  }): Promise<ScmHostingRepositoryPublishResponse>;
  repositoryClone?(input: {
    context: ScmBackendContext;
    request: ScmRepositoryCloneInput;
  }): Promise<ScmRepositoryCloneOutput>;
  repositoryInit?(input: {
    context: ScmBackendContext;
    request: ScmRepositoryInitRequest;
  }): Promise<ScmRepositoryInitResponse>;
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
