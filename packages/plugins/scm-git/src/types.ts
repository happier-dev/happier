import type {
  BackendRuntimeHandlers,
  ScmBackendDescribeRequest,
  ScmBackendDescribeResponse,
  ScmBackendCapabilities,
  ScmBackendId } from '@happier-dev/plugin-sdk/scm/backend';
import type {
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
  ScmCommitUndoLastRequest,
  ScmCommitUndoLastResponse,
  ScmCommitCreateRequest,
  ScmCommitCreateResponse,
  ScmCommitResolveOutcomeRequest,
  ScmCommitResolveOutcomeResponse,
  ScmConflictAcceptSideRequest,
  ScmConflictMarkResolvedRequest,
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
  ScmStashCreateRequest,
  ScmStashCreateResponse,
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
  BackendRuntimeContext as ScmBackendRuntimeContext,
  BackendRuntimeDetection as ScmBackendRuntimeDetection,
  WorkspaceIntegrationHandlers as ScmBackendRuntimeWorkspaceIntegrationHandlers,
  WorkspaceLocationInspection as ScmWorkspaceIntegrationWorkspaceLocationInspection,
  CheckoutMaterializationRequest as ScmWorkspaceIntegrationCheckoutMaterializationRequest,
  WorkspaceCheckoutCreationRequest as ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
  WorkspaceCheckoutCreationResult as ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult,
  WorkspaceCheckoutMaterializationRequest as ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
  WorkspaceCheckoutMaterializationResult as ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult,
  WorkspaceCheckoutRealizationRequest as ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
  WorkspaceCheckoutRealizationResult as ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
  WorkspaceTransferRequest as ScmWorkspaceIntegrationWorkspaceTransferRequest,
  WorkspaceTransferResult as ScmBackendRuntimeWorkspaceTransferResult,
  WorkspaceTransferEntry as ScmBackendRuntimeWorkspaceTransferEntry,
  WorkspaceTransferMetadata as ScmWorkspaceIntegrationWorkspaceTransferMetadata,
  PortableWorkspacePathClassification as ScmWorkspaceIntegrationPortableWorkspacePathClassification,
  PortableWorkspacePathRequest as ScmWorkspaceIntegrationPortableWorkspacePathRequest,
} from '@happier-dev/plugin-sdk/scm/backend';

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
  artifactDirectory?: string;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferEntry = ScmBackendRuntimeWorkspaceTransferEntry & Readonly<{
  disposeSource?: () => Promise<void> | void;
}>;

export type ScmWorkspaceIntegrationWorkspaceTransferResult = Omit<ScmBackendRuntimeWorkspaceTransferResult, 'entries'> & Readonly<{
  entries: readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[];
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
  ScmWorkspaceIntegrationWorkspaceTransferMetadata,
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
  commitUndoLast?(input: { context: ScmBackendContext; request: ScmCommitUndoLastRequest }): Promise<ScmCommitUndoLastResponse>;
  commitResolveOutcome?(input: { context: ScmBackendContext; request: ScmCommitResolveOutcomeRequest }): Promise<ScmCommitResolveOutcomeResponse>;
  commitCaptureTarget?: NonNullable<BackendRuntimeHandlers['commit']>['captureTarget'];
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
  branchOperationSkip(input: {
    context: ScmBackendContext;
    request: ScmBranchOperationControlRequest;
  }): Promise<ScmBranchIntegrationResponse>;
  conflictAcceptSide(input: {
    context: ScmBackendContext;
    request: ScmConflictAcceptSideRequest;
  }): Promise<ScmBranchIntegrationResponse>;
  conflictMarkResolved(input: {
    context: ScmBackendContext;
    request: ScmConflictMarkResolvedRequest;
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
  stashCreate(input: {
    context: ScmBackendContext;
    request: ScmStashCreateRequest;
  }): Promise<ScmStashCreateResponse>;
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
