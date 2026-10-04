/** @moduleRealm daemon */
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
    ScmRepositoryCloneInput,
    ScmRepositoryCloneOutput,
    ScmRepositoryInitRequest,
    ScmRepositoryInitResponse,
    ScmRepositoryRemoveIndexLockRequest,
    ScmRepositoryRemoveIndexLockResponse,
    ScmReviewWorkspaceCurrentness,
    ScmReviewWorkspaceSourceTip,
    ScmRepoMode,
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
    ScmWorktreeCreateRequest,
    ScmWorktreeCreateResponse,
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
    ScmWorktreePruneRequest,
    ScmWorktreePruneResponse,
    ScmWorktreeRemoveRequest,
    ScmWorktreeRemoveResponse,
    ScmCapabilities,
    ScmOperationErrorCode,
    ScmRefreshPolicy,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
} from './projections.js';
import type { PluginJsonValueV2 } from '../identity.js';

export type ScmReviewWorkspaceMaterializePreparedRequest = Readonly<{
    cwd: string;
    displayName: string;
    sourceTip: ScmReviewWorkspaceSourceTip;
    verification?: Readonly<{ targetPath: string }>;
}>;

export type ScmReviewWorkspaceMaterializePreparedResponse =
    | Readonly<{
        success: true;
        targetPath: string;
        branchName: string;
        created: boolean;
        currentness: ScmReviewWorkspaceCurrentness;
    }>
    | Readonly<{
        success: true;
        verification: Readonly<{
            targetPath: string;
            sourceHeadSha: string;
        }>;
    }>
    | Readonly<{
        success: false;
        error: string;
        errorCode: ScmOperationErrorCode;
    }>;

export type ScmBackendId = string;

export type ScmBackendDescribeRequest = {
    cwd?: string;
    backendPreference?: {
        kind: 'prefer';
        backendId: string;
    };
    outcomeVersion?: 1;
};

export type ScmBackendDescribeResponse = {
    success: boolean;
    backendId?: ScmBackendId;
    repoMode?: ScmRepoMode;
    isRepo?: boolean;
    capabilities?: ScmCapabilities;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmBackendCapabilityUnavailableReason =
    | 'not_implemented'
    | 'tool_missing'
    | 'repo_mode_unsupported'
    | 'auth_missing'
    | 'hosting_provider_missing'
    | 'unsafe_worktree_state'
    | 'unknown';

export type ScmBackendCapabilityLeaf = {
    support: 'supported' | 'unsupported' | 'experimental';
    reason?: ScmBackendCapabilityUnavailableReason;
    declaredSupport?: 'supported' | 'unsupported' | 'experimental';
};

export type ScmBackendCapabilities = {
    detection: {
        repository?: ScmBackendCapabilityLeaf;
        repoIdentity?: ScmBackendCapabilityLeaf;
        ignoredPath?: ScmBackendCapabilityLeaf;
        repoMode?: ScmBackendCapabilityLeaf;
        executable?: ScmBackendCapabilityLeaf;
    };
    read: {
        status?: ScmBackendCapabilityLeaf;
        diffFile?: ScmBackendCapabilityLeaf;
        diffCommit?: ScmBackendCapabilityLeaf;
        log?: ScmBackendCapabilityLeaf;
        branches?: ScmBackendCapabilityLeaf;
        stash?: ScmBackendCapabilityLeaf;
        defaultBranch?: ScmBackendCapabilityLeaf;
        hostingProvider?: ScmBackendCapabilityLeaf;
        pullRequestStatus?: ScmBackendCapabilityLeaf;
    };
    changeSet: {
        include?: ScmBackendCapabilityLeaf;
        exclude?: ScmBackendCapabilityLeaf;
        discard?: ScmBackendCapabilityLeaf;
        stashCreate?: ScmBackendCapabilityLeaf;
        model: 'index' | 'working-copy';
        diffAreas: ('included' | 'pending' | 'both')[];
    };
    commit: {
        create?: ScmBackendCapabilityLeaf;
        undoLast?: ScmBackendCapabilityLeaf;
        amend?: ScmBackendCapabilityLeaf;
        signOff?: ScmBackendCapabilityLeaf;
        expectedBase?: ScmBackendCapabilityLeaf;
        safePlan?: ScmBackendCapabilityLeaf;
        resolveOutcome?: ScmBackendCapabilityLeaf;
        pathSelection?: ScmBackendCapabilityLeaf;
        lineSelection?: ScmBackendCapabilityLeaf;
        backout?: ScmBackendCapabilityLeaf;
    };
    remote: {
        read?: ScmBackendCapabilityLeaf;
        add?: ScmBackendCapabilityLeaf;
        setUrl?: ScmBackendCapabilityLeaf;
        remove?: ScmBackendCapabilityLeaf;
        fetch?: ScmBackendCapabilityLeaf;
        pull?: ScmBackendCapabilityLeaf;
        push?: ScmBackendCapabilityLeaf;
        publish?: ScmBackendCapabilityLeaf;
        policies?: ScmBackendCapabilityLeaf;
        forceWithLease?: ScmBackendCapabilityLeaf;
    };
    branch: {
        list?: ScmBackendCapabilityLeaf;
        create?: ScmBackendCapabilityLeaf;
        checkout?: ScmBackendCapabilityLeaf;
        merge?: ScmBackendCapabilityLeaf;
        rebase?: ScmBackendCapabilityLeaf;
        operationControl?: ScmBackendCapabilityLeaf;
        operationSkip?: ScmBackendCapabilityLeaf;
        conflictResolution?: ScmBackendCapabilityLeaf;
    };
    worktree: {
        create?: ScmBackendCapabilityLeaf;
        remove?: ScmBackendCapabilityLeaf;
        prune?: ScmBackendCapabilityLeaf;
        prepare?: ScmBackendCapabilityLeaf;
    };
    lifecycle: {
        init?: ScmBackendCapabilityLeaf;
        clone?: ScmBackendCapabilityLeaf;
        publish?: ScmBackendCapabilityLeaf;
        identityRediscovery?: ScmBackendCapabilityLeaf;
        removeIndexLock?: ScmBackendCapabilityLeaf;
    };
    hosting: {
        providerDetection?: ScmBackendCapabilityLeaf;
        repositoryPublishTargets?: ScmBackendCapabilityLeaf;
        repositoryPublish?: ScmBackendCapabilityLeaf;
        pullRequestRead?: ScmBackendCapabilityLeaf;
        pullRequestStatus?: ScmBackendCapabilityLeaf;
        pullRequestCreate?: ScmBackendCapabilityLeaf;
        pullRequestDraftCreate?: ScmBackendCapabilityLeaf;
        pullRequestReuse?: ScmBackendCapabilityLeaf;
        pullRequestCheckout?: ScmBackendCapabilityLeaf;
        pullRequestPrepareWorktree?: ScmBackendCapabilityLeaf;
        pullRequestRunStacked?: ScmBackendCapabilityLeaf;
    };
    checkpoints: {
        capture?: ScmBackendCapabilityLeaf;
        aliasFinalize?: ScmBackendCapabilityLeaf;
        diff?: ScmBackendCapabilityLeaf;
        cleanup?: ScmBackendCapabilityLeaf;
        backup?: ScmBackendCapabilityLeaf;
        rollbackApply?: ScmBackendCapabilityLeaf;
    };
    workspaceIntegration: {
        inspectLocation?: ScmBackendCapabilityLeaf;
        checkoutMaterialization?: ScmBackendCapabilityLeaf;
        workspaceTransfer?: ScmBackendCapabilityLeaf;
        exportPortability?: ScmBackendCapabilityLeaf;
        portablePathClassification?: ScmBackendCapabilityLeaf;
    };
    tooling: {
        systemCliResolution?: ScmBackendCapabilityLeaf;
        managedCliResolution?: ScmBackendCapabilityLeaf;
        binarySafe?: ScmBackendCapabilityLeaf;
    };
    freshness: {
        observed?: ScmBackendCapabilityLeaf;
        expiry?: ScmBackendCapabilityLeaf;
        state?: {
            source: 'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote';
            observedAt: number;
            expiresAt?: number;
        };
        refreshPolicy?: ScmRefreshPolicy;
    };
    operationLabels?: {
        commit?: string;
        include?: string;
        exclude?: string;
        backout?: string;
        fetch?: string;
        pull?: string;
        push?: string;
    };
};

export type ScmBackendContribution = {
    id: string;
    title: string | { key: string; fallback: string };
    description?: string | { key: string; fallback: string };
    kind: string;
    capabilities: ('detect' | 'clone' | 'fetch' | 'status' | 'diff' | 'commit' | 'push' | 'pullRequest')[];
    metadata?: Record<string, PluginJsonValueV2>;
};

export type BackendRuntimeContext = Readonly<{
    cwd: string;
    projectKey: string;
    /** Host policy check for backend-derived filesystem mutation targets; throws on refusal. */
    assertFilesystemPathAuthorized?: (targetPath: string) => void;
    detection: Readonly<{
        isRepo: boolean;
        rootPath: string | null;
        mode: ScmRepoMode | null;
    }>;
}>;

export type BackendRuntimeDetection = Readonly<{
    isRepo: boolean;
    rootPath: string | null;
    mode: ScmRepoMode | null;
}>;

export type BackendRuntimeHandlerInput<TRequest> = Readonly<{
    context: BackendRuntimeContext;
    request: TRequest;
    /** Operation-scoped cancellation; plugin code must forward it across external awaits. */
    signal: AbortSignal;
}>;

export type CheckoutMaterializationRequest = Readonly<{
    targetPath: string;
    sourcePath?: string;
    previousTargetPath?: string;
    workspaceIntegrationMetadata?: WorkspaceTransferMetadata;
}>;

export type CreatableWorkspaceCheckoutKind = 'git_worktree';

export type WorkspaceCheckoutCreationRequest = Readonly<{
    kind: CreatableWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>;

export type WorkspaceCheckoutCreationResult = Readonly<{
    kind: CreatableWorkspaceCheckoutKind;
    targetPath: string;
    branchName: string;
    created: boolean;
}>;

export type WorkspaceCheckoutMaterializationRequest = Readonly<{
    kind: CreatableWorkspaceCheckoutKind;
    sourcePath: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>;

export type WorkspaceCheckoutMaterializationResult = Readonly<{
    targetPath: string;
    branchName: string;
    created: boolean;
}>;

export type WorkspaceCheckoutRealizationRequest = Readonly<{
    kind: CreatableWorkspaceCheckoutKind;
    sourcePath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
    targetPath: string | null;
}>;

export type WorkspaceCheckoutRealizationResult = Readonly<{
    kind: CreatableWorkspaceCheckoutKind;
    targetPath: string;
    branchName: string;
    created: boolean;
}>;

export type WorkspaceTransferEntry = Readonly<{
    relativePath: string;
    sourcePath: string;
}>;

export type WorkspaceTransferMetadata = Readonly<Record<string, unknown>>;

export type WorkspaceTransferRequest = Readonly<{
    strategy: 'transfer_snapshot';
    includeIgnoredMode: 'exclude' | 'include_selected';
    ignoredIncludeGlobs: readonly string[];
    /** Include repository-ignored paths before applying the explicit policy overlay. */
    includeAllIgnored?: boolean;
    /** Ordered, bounded Git-ignore patterns supplied by the workspace policy owner. */
    extraIgnorePatterns?: readonly string[];
}>;

export type WorkspaceTransferResult = Readonly<{
    entries: readonly WorkspaceTransferEntry[];
    metadata?: WorkspaceTransferMetadata | null;
}>;

export type PortableWorkspacePathClassification =
    | 'portable'
    | 'non_portable'
    | 'scm_administrative'
    | 'unknown';

export type PortableWorkspacePathRequest = Readonly<{
    relativePath: string;
}>;

export type WorkspaceLocationInspection = Readonly<{
    rootPath: string;
    scmProvider?: 'git';
    /** Exact committed revision at inspection time, when the SCM can resolve one without mutation. */
    committedRevision?: string;
    checkoutDiscovery?: readonly Readonly<{
        kind: CreatableWorkspaceCheckoutKind;
        path?: string;
        /** Opaque canonical repository identity used to compare related checkouts. */
        repositoryIdentityPath?: string;
    }>[];
    checkoutProviderKinds?: readonly CreatableWorkspaceCheckoutKind[];
}>;

export type WorkspaceIntegrationHandlers = Readonly<{
    /** Optional read classification; raw directory listings remain available when absent. */
    classifyDirectoryIgnores?: (input: Readonly<{
        cwd: string;
        entries: readonly Readonly<{ name: string; type: 'file' | 'directory' | 'other' }>[];
    }>) => Promise<ReadonlySet<string>>;
    inspectWorkspaceLocation?: (
        input: Readonly<{ context: BackendRuntimeContext }>
    ) => Promise<WorkspaceLocationInspection | null> | WorkspaceLocationInspection | null;
    reconcilePostMaterialization?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            checkoutMaterialization: CheckoutMaterializationRequest;
            sourcePath?: string;
            previousTargetPath?: string;
            workspaceIntegrationMetadata?: WorkspaceTransferMetadata;
        }>
    ) => Promise<void> | void;
    /**
     * Materializes an already-authorized pull-request source tip at one exact
     * local root. The caller supplies no backend/provider selector here: the
     * selected backend owns remote verification, fetch, safe movement and the
     * resulting local-head currentness.
     */
    prepareReviewWorkspace?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            request: ScmReviewWorkspaceMaterializePreparedRequest;
            /** Operation-scoped cancellation; forward it across external awaits. */
            signal: AbortSignal;
        }>
    ) => Promise<ScmReviewWorkspaceMaterializePreparedResponse> | ScmReviewWorkspaceMaterializePreparedResponse;
    /**
     * Reads the current local HEAD of one already-prepared review workspace.
     * This leaf must not fetch, repair, move, or rematerialize the checkout.
     */
    verifyPreparedReviewWorkspace?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            request: ScmReviewWorkspaceMaterializePreparedRequest & Readonly<{
                verification: Readonly<{ targetPath: string }>;
            }>;
            /** Operation-scoped cancellation; forward it across external awaits. */
            signal: AbortSignal;
        }>
    ) => Promise<ScmReviewWorkspaceMaterializePreparedResponse> | ScmReviewWorkspaceMaterializePreparedResponse;
    realizeWorkspaceCheckout?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            workspaceCheckoutRealization: WorkspaceCheckoutRealizationRequest;
        }>
    ) => Promise<WorkspaceCheckoutRealizationResult> | WorkspaceCheckoutRealizationResult;
    createWorkspaceCheckout?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            workspaceCheckoutCreation: WorkspaceCheckoutCreationRequest;
        }>
    ) => Promise<WorkspaceCheckoutCreationResult> | WorkspaceCheckoutCreationResult;
    materializeWorkspaceCheckout?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            workspaceCheckoutMaterialization: WorkspaceCheckoutMaterializationRequest;
        }>
    ) => Promise<WorkspaceCheckoutMaterializationResult | void> | WorkspaceCheckoutMaterializationResult | void;
    /**
     * Resolves the transfer entries and their metadata together from one
     * observation of the workspace. Prefer this over the separate
     * entries/metadata leaves: those are invoked independently, so a backend
     * that stages an artifact while listing entries cannot guarantee the
     * metadata describing that artifact came from the same repository state.
     * The host uses this handler when present and falls back to the separate
     * callbacks otherwise.
     */
    resolveWorkspaceTransfer?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            workspaceTransfer: WorkspaceTransferRequest;
            artifactDirectory?: string;
        }>
    ) => Promise<WorkspaceTransferResult | null> | WorkspaceTransferResult | null;
    /** Compatibility leaf for backends that do not implement `resolveWorkspaceTransfer`. */
    resolveWorkspaceTransferEntries?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            workspaceTransfer: WorkspaceTransferRequest;
            artifactDirectory?: string;
        }>
    ) => Promise<readonly WorkspaceTransferEntry[] | null> | readonly WorkspaceTransferEntry[] | null;
    /** Compatibility leaf for backends that do not implement `resolveWorkspaceTransfer`. */
    resolveWorkspaceTransferMetadata?: (
        input: Readonly<{
            context: BackendRuntimeContext;
            workspaceTransfer: WorkspaceTransferRequest;
            artifactDirectory?: string;
        }>
    ) => Promise<WorkspaceTransferMetadata | null> | WorkspaceTransferMetadata | null;
    assertPortableWorkspaceEntries?: (
        input: Readonly<{ entries: readonly Readonly<{ relativePath: string }>[] }>
    ) => Promise<void> | void;
    classifyPortableWorkspaceTransferEntry?: (
        input: WorkspaceTransferEntry
    ) => PortableWorkspacePathClassification;
    isAdministrativeWorkspacePath?: (
        input: Readonly<{ relativePath: string }>
    ) => boolean;
    classifyPortableWorkspacePath?: (
        input: PortableWorkspacePathRequest
    ) => PortableWorkspacePathClassification;
}>;

/** Commit admission witness supplied by the backend that owns publication. */
type CommitTargetCaptureResponse =
    | Readonly<{ success: true; target: Readonly<{ headOid: string | null; ref: string | null; baseTreeOid: string }> }>
    | Readonly<{ success: false; errorCode?: ScmOperationErrorCode; error?: string }>;

export type BackendRuntimeHandlers = Readonly<{
    detection?: Readonly<{
        detectRepo?: (input: Readonly<{ cwd: string }>) => Promise<BackendRuntimeDetection> | BackendRuntimeDetection;
        describeBackend?: (
            input: BackendRuntimeHandlerInput<ScmBackendDescribeRequest>
        ) => Promise<ScmBackendDescribeResponse> | ScmBackendDescribeResponse;
    }>;
    read?: Readonly<{
        statusSnapshot?: (
            input: BackendRuntimeHandlerInput<ScmStatusSnapshotRequest>
        ) => Promise<ScmStatusSnapshotResponse> | ScmStatusSnapshotResponse;
        worktreesEnrichment?: (
            input: BackendRuntimeHandlerInput<ScmWorktreesEnrichmentRequest>
        ) => Promise<ScmWorktreesEnrichmentResponse> | ScmWorktreesEnrichmentResponse;
        diffFile?: (
            input: BackendRuntimeHandlerInput<ScmDiffFileRequest>
        ) => Promise<ScmDiffFileResponse> | ScmDiffFileResponse;
        diffCommit?: (
            input: BackendRuntimeHandlerInput<ScmDiffCommitRequest>
        ) => Promise<ScmDiffCommitResponse> | ScmDiffCommitResponse;
        logList?: (
            input: BackendRuntimeHandlerInput<ScmLogListRequest>
        ) => Promise<ScmLogListResponse> | ScmLogListResponse;
        stashList?: (
            input: BackendRuntimeHandlerInput<ScmStashListRequest>
        ) => Promise<ScmStashListResponse> | ScmStashListResponse;
    }>;
    changeSet?: Readonly<{
        include?: (input: BackendRuntimeHandlerInput<ScmChangeApplyRequest>) => Promise<ScmChangeApplyResponse> | ScmChangeApplyResponse;
        exclude?: (input: BackendRuntimeHandlerInput<ScmChangeApplyRequest>) => Promise<ScmChangeApplyResponse> | ScmChangeApplyResponse;
        discard?: (input: BackendRuntimeHandlerInput<ScmChangeDiscardRequest>) => Promise<ScmChangeDiscardResponse> | ScmChangeDiscardResponse;
    }>;
    commit?: Readonly<{
        captureTarget?: (input: Readonly<{ context: BackendRuntimeContext }>) => Promise<CommitTargetCaptureResponse> | CommitTargetCaptureResponse;
        create?: (input: BackendRuntimeHandlerInput<ScmCommitCreateRequest>) => Promise<ScmCommitCreateResponse> | ScmCommitCreateResponse;
        resolveOutcome?: (input: BackendRuntimeHandlerInput<ScmCommitResolveOutcomeRequest>) => Promise<ScmCommitResolveOutcomeResponse> | ScmCommitResolveOutcomeResponse;
        backout?: (input: BackendRuntimeHandlerInput<ScmCommitBackoutRequest>) => Promise<ScmCommitBackoutResponse> | ScmCommitBackoutResponse;
        undoLast?: (input: BackendRuntimeHandlerInput<ScmCommitUndoLastRequest>) => Promise<ScmCommitUndoLastResponse> | ScmCommitUndoLastResponse;
    }>;
    remote?: Readonly<{
        add?: (input: BackendRuntimeHandlerInput<ScmRemoteAddRequest>) => Promise<ScmRemoteManagementResponse> | ScmRemoteManagementResponse;
        setUrl?: (input: BackendRuntimeHandlerInput<ScmRemoteSetUrlRequest>) => Promise<ScmRemoteManagementResponse> | ScmRemoteManagementResponse;
        remove?: (input: BackendRuntimeHandlerInput<ScmRemoteRemoveRequest>) => Promise<ScmRemoteManagementResponse> | ScmRemoteManagementResponse;
        fetch?: (input: BackendRuntimeHandlerInput<ScmRemoteRequest>) => Promise<ScmRemoteResponse> | ScmRemoteResponse;
        pull?: (input: BackendRuntimeHandlerInput<ScmRemoteRequest>) => Promise<ScmRemoteResponse> | ScmRemoteResponse;
        push?: (input: BackendRuntimeHandlerInput<ScmRemoteRequest>) => Promise<ScmRemoteResponse> | ScmRemoteResponse;
        publish?: (input: BackendRuntimeHandlerInput<ScmRemotePublishRequest>) => Promise<ScmRemotePublishResponse> | ScmRemotePublishResponse;
    }>;
    branch?: Readonly<{
        list?: (input: BackendRuntimeHandlerInput<ScmBranchListRequest>) => Promise<ScmBranchListResponse> | ScmBranchListResponse;
        create?: (input: BackendRuntimeHandlerInput<ScmBranchCreateRequest>) => Promise<ScmBranchCreateResponse> | ScmBranchCreateResponse;
        checkout?: (input: BackendRuntimeHandlerInput<ScmBranchCheckoutRequest>) => Promise<ScmBranchCheckoutResponse> | ScmBranchCheckoutResponse;
        merge?: (input: BackendRuntimeHandlerInput<ScmBranchIntegrationRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        rebase?: (input: BackendRuntimeHandlerInput<ScmBranchIntegrationRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        operationContinue?: (input: BackendRuntimeHandlerInput<ScmBranchOperationControlRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        operationSkip?: (input: BackendRuntimeHandlerInput<ScmBranchOperationControlRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        operationAbort?: (input: BackendRuntimeHandlerInput<ScmBranchOperationControlRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        conflictAcceptSide?: (input: BackendRuntimeHandlerInput<ScmConflictAcceptSideRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
        conflictMarkResolved?: (input: BackendRuntimeHandlerInput<ScmConflictMarkResolvedRequest>) => Promise<ScmBranchIntegrationResponse> | ScmBranchIntegrationResponse;
    }>;
    worktree?: Readonly<{
        create?: (input: BackendRuntimeHandlerInput<ScmWorktreeCreateRequest>) => Promise<ScmWorktreeCreateResponse> | ScmWorktreeCreateResponse;
        remove?: (input: BackendRuntimeHandlerInput<ScmWorktreeRemoveRequest>) => Promise<ScmWorktreeRemoveResponse> | ScmWorktreeRemoveResponse;
        prune?: (input: BackendRuntimeHandlerInput<ScmWorktreePruneRequest>) => Promise<ScmWorktreePruneResponse> | ScmWorktreePruneResponse;
    }>;
    lifecycle?: Readonly<{
        init?: (input: BackendRuntimeHandlerInput<ScmRepositoryInitRequest>) => Promise<ScmRepositoryInitResponse> | ScmRepositoryInitResponse;
        clone?: (input: BackendRuntimeHandlerInput<ScmRepositoryCloneInput>) => Promise<ScmRepositoryCloneOutput> | ScmRepositoryCloneOutput;
        removeIndexLock?: (input: BackendRuntimeHandlerInput<ScmRepositoryRemoveIndexLockRequest>) => Promise<ScmRepositoryRemoveIndexLockResponse> | ScmRepositoryRemoveIndexLockResponse;
    }>;
    hosting?: Readonly<{
        repositoryDescribePublishTargets?: (
            input: BackendRuntimeHandlerInput<ScmHostingRepositoryDescribePublishTargetsRequest>
        ) => Promise<ScmHostingRepositoryDescribePublishTargetsResponse> | ScmHostingRepositoryDescribePublishTargetsResponse;
        repositoryPublish?: (
            input: BackendRuntimeHandlerInput<ScmHostingRepositoryPublishRequest>
        ) => Promise<ScmHostingRepositoryPublishResponse> | ScmHostingRepositoryPublishResponse;
        pullRequestList?: (input: BackendRuntimeHandlerInput<ScmPullRequestListRequest>) => Promise<ScmPullRequestListResponse> | ScmPullRequestListResponse;
        pullRequestGet?: (input: BackendRuntimeHandlerInput<ScmPullRequestGetRequest>) => Promise<ScmPullRequestGetResponse> | ScmPullRequestGetResponse;
        pullRequestOpenCompose?: (
            input: BackendRuntimeHandlerInput<ScmPullRequestOpenComposeRequest>
        ) => Promise<ScmPullRequestOpenComposeResponse> | ScmPullRequestOpenComposeResponse;
        pullRequestOpenOrReuse?: (
            input: BackendRuntimeHandlerInput<ScmPullRequestOpenOrReuseRequest>
        ) => Promise<ScmPullRequestOpenOrReuseResponse> | ScmPullRequestOpenOrReuseResponse;
        pullRequestCheckout?: (
            input: BackendRuntimeHandlerInput<ScmPullRequestCheckoutRequest>
        ) => Promise<ScmPullRequestCheckoutResponse> | ScmPullRequestCheckoutResponse;
        pullRequestPrepareWorktree?: (
            input: BackendRuntimeHandlerInput<ScmPullRequestPrepareWorktreeRequest>
        ) => Promise<ScmPullRequestPrepareWorktreeResponse> | ScmPullRequestPrepareWorktreeResponse;
        pullRequestRunStacked?: (
            input: BackendRuntimeHandlerInput<ScmPullRequestRunStackedRequest>
        ) => Promise<ScmPullRequestRunStackedResponse> | ScmPullRequestRunStackedResponse;
    }>;
    stash?: Readonly<{
        create?: (input: BackendRuntimeHandlerInput<ScmStashCreateRequest>) => Promise<ScmStashCreateResponse> | ScmStashCreateResponse;
        drop?: (input: BackendRuntimeHandlerInput<ScmStashDropRequest>) => Promise<ScmStashDropResponse> | ScmStashDropResponse;
        pop?: (input: BackendRuntimeHandlerInput<ScmStashPopRequest>) => Promise<ScmStashPopResponse> | ScmStashPopResponse;
        apply?: (input: BackendRuntimeHandlerInput<ScmStashApplyRequest>) => Promise<ScmStashApplyResponse> | ScmStashApplyResponse;
        show?: (input: BackendRuntimeHandlerInput<ScmStashShowRequest>) => Promise<ScmStashShowResponse> | ScmStashShowResponse;
    }>;
    workspaceIntegration?: WorkspaceIntegrationHandlers;
}>;

export type BackendRuntimeRegistration = Readonly<{
    id: string;
    runtime?: Readonly<{
        repoModes: readonly ScmRepoMode[];
        capabilities: ScmBackendCapabilities;
        commands: readonly Readonly<{
            installableKey: string;
            command: string;
        }>[];
    }>;
    handlers: BackendRuntimeHandlers;
}>;

export type BackendCommandRunInput = Readonly<{
    installableKey: string;
    command: string;
    cwd: string;
    args: readonly string[];
    timeoutMs?: number;
    stdin?: string;
    /** Keep stdin open until this exact stdout line, then send the response and close it. */
    stdinInteraction?: Readonly<{
        readyLine: string;
        respond(): string | Promise<string>;
    }>;
    maxOutputBytes?: number;
    env?: Readonly<Record<string, string | undefined>>;
    signal?: AbortSignal;
}>;

export type BackendCommandRunResult = Readonly<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
}>;

export type BackendRuntimeServices = Readonly<{
    runCommand(input: BackendCommandRunInput): Promise<BackendCommandRunResult>;
}>;

export {
    readCurrentBackendRuntimeServices,
    runWithBackendRuntimeServices,
} from './backendRuntimeServices.js';

/** @realm any */
export {
    ScmBackendCapabilitiesSchema,
    ScmBackendContributionSchema,
    createScmCapabilitiesFromBackendCapabilities,
    mapGitScmErrorCode,
    mapSaplingScmErrorCode,
    supportedCapability,
    unsupportedCapability,
    resolveScmBackendCapabilities,
} from './backendProjections.js';

export {
    resolveScmBackendCommandMaxOutputBytes as resolveBackendCommandMaxOutputBytes,
    runScmBackendCommand as runBackendCommand,
} from './command.js';

export type {
    ScmBackendCommandInput as BackendCommandInput,
    ScmBackendCommandSpec as BackendCommandSpec,
} from './command.js';

export type { BackendRuntime } from '../activation.js';

// Pre-EU-4 source bridge for the still-live experimental SCM consumers. The
// final /scm/backend inventory excludes these predecessor identities, and no
// final declaration above depends on them.
export type ScmBackendCommandRunInput = BackendCommandRunInput;
export type ScmBackendCommandRunResult = BackendCommandRunResult;
export type ScmBackendRuntimeContext = BackendRuntimeContext;
export type ScmBackendRuntimeDetection = BackendRuntimeDetection;
export type ScmBackendRuntimeHandlerInput<TRequest> = BackendRuntimeHandlerInput<TRequest>;
export type ScmBackendRuntimeHandlers = BackendRuntimeHandlers;
export type ScmBackendRuntimeRegistration = BackendRuntimeRegistration;
export type ScmBackendRuntimeServices = BackendRuntimeServices;
export type ScmBackendRuntimeWorkspaceIntegrationHandlers = WorkspaceIntegrationHandlers;
export type ScmWorkspaceIntegrationCheckoutMaterializationRequest = CheckoutMaterializationRequest;
export type ScmWorkspaceIntegrationPortableWorkspacePathClassification = PortableWorkspacePathClassification;
export type ScmWorkspaceIntegrationPortableWorkspacePathRequest = PortableWorkspacePathRequest;
export type ScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest = WorkspaceCheckoutCreationRequest;
export type ScmWorkspaceIntegrationWorkspaceCheckoutCreationResult = WorkspaceCheckoutCreationResult;
export type ScmWorkspaceIntegrationWorkspaceCheckoutKind = CreatableWorkspaceCheckoutKind;
export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest = WorkspaceCheckoutMaterializationRequest;
export type ScmWorkspaceIntegrationWorkspaceCheckoutMaterializationResult = WorkspaceCheckoutMaterializationResult;
export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest = WorkspaceCheckoutRealizationRequest;
export type ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult = WorkspaceCheckoutRealizationResult;
export type ScmWorkspaceIntegrationWorkspaceLocationInspection = WorkspaceLocationInspection;
export type ScmWorkspaceIntegrationWorkspaceTransferEntry = WorkspaceTransferEntry;
export type ScmWorkspaceIntegrationWorkspaceTransferMetadata = WorkspaceTransferMetadata;
export type ScmWorkspaceIntegrationWorkspaceTransferRequest = WorkspaceTransferRequest;
export type ScmWorkspaceIntegrationWorkspaceTransferResult = WorkspaceTransferResult;

export {
    readCurrentBackendRuntimeServices as readCurrentScmBackendRuntimeServices,
    runWithBackendRuntimeServices as runWithScmBackendRuntimeServices,
} from './backendRuntimeServices.js';
