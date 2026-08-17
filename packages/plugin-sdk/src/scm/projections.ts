import {
    createScmCapabilities as canonicalCreateScmCapabilities,
    evaluateScmRemoteMutationPolicy as canonicalEvaluateScmRemoteMutationPolicy,
    isScmPatchBoundToPath as canonicalIsScmPatchBoundToPath,
    normalizeScmBranchSourceRef as canonicalNormalizeScmBranchSourceRef,
    normalizeScmRemoteName as canonicalNormalizeScmRemoteName,
    normalizeScmRemoteRequest as canonicalNormalizeScmRemoteRequest,
    normalizeScmRemoteUrl as canonicalNormalizeScmRemoteUrl,
    resolveScmScopedChangedPaths as canonicalResolveScmScopedChangedPaths,
    SCM_COMMIT_MESSAGE_MAX_LENGTH as canonicalScmCommitMessageMaxLength,
    SCM_COMMIT_PATCH_MAX_COUNT as canonicalScmCommitPatchMaxCount,
    SCM_COMMIT_PATCH_MAX_LENGTH as canonicalScmCommitPatchMaxLength,
    SCM_OPERATION_ERROR_CODES as canonicalScmOperationErrorCodes,
    SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN as canonicalScmWorktreeRemoveAuthorizationToken,
    ProviderRefreshPolicySchema as canonicalScmRefreshPolicySchema,
    ScmCapabilitiesSchema as canonicalScmCapabilitiesSchema,
    ScmSelectedMutationPathSchema as canonicalScmSelectedMutationPathSchema,
    ScmWorkingSnapshotSchema as canonicalScmWorkingSnapshotSchema,
    SourceControlCloneProtocolSchema as canonicalScmCloneProtocolSchema,
} from '@happier-dev/protocol/scm';
import type {
    ScmHostingProviderKind,
    ScmHostingProviderRef,
} from './hostingProvider.js';

export type ScmRefreshPolicy =
    | 'cache-first'
    | 'stale-while-revalidate'
    | 'force-refresh'
    | 'local-only';

export type ScmBranchSourceRefNormalizationResult =
    | { ok: true; sourceRef: string }
    | { ok: false; error: string };

export type ScmRemoteMutationResult =
    | { ok: true }
    | { ok: false; reason: ScmRemoteMutationReason };

export type ScmRemoteMutationSnapshot = {
    hasConflicts: boolean;
    branch: Pick<ScmWorkingSnapshot['branch'], 'head' | 'upstream' | 'behind' | 'detached'>;
    totals: Pick<ScmWorkingSnapshot['totals'], 'includedFiles' | 'pendingFiles' | 'untrackedFiles'>;
};

export type ScmRemoteNameNormalizationResult =
    | { ok: true; name: string }
    | { ok: false; error: string };

export type ScmRemoteRequestNormalizationResult =
    | { ok: true; request: { remote: string | undefined; branch: string | undefined } }
    | { ok: false; error: string };

export type ScmRemoteUrlNormalizationResult =
    | { ok: true; url: string }
    | { ok: false; error: string };

export type ScmRepoMode = '.git' | '.sl';
export type ScmBranchIntegrationOperation = 'merge' | 'rebase';
export type ScmDefaultBranchPushPolicy = 'allow' | 'requires-feature-branch' | 'deny';
export type ScmSelectedMutationPath = string;
export type ScmCloneProtocol = 'auto' | 'ssh' | 'https';
export type ScmOperationErrorCode =
    | 'NOT_REPOSITORY'
    | 'INVALID_PATH'
    | 'INVALID_REQUEST'
    | 'COMMAND_FAILED'
    | 'CHANGE_APPLY_FAILED'
    | 'COMMIT_REQUIRED'
    | 'CONFLICTING_WORKTREE'
    | 'REMOTE_AUTH_REQUIRED'
    | 'REMOTE_UPSTREAM_REQUIRED'
    | 'REMOTE_NON_FAST_FORWARD'
    | 'REMOTE_FF_ONLY_REQUIRED'
    | 'REMOTE_REJECTED'
    | 'REMOTE_NOT_FOUND'
    | 'REMOTE_ALREADY_EXISTS'
    | 'BRANCH_OPERATION_IN_PROGRESS'
    | 'BRANCH_OPERATION_NOT_IN_PROGRESS'
    | 'FEATURE_UNSUPPORTED'
    | 'BACKEND_UNAVAILABLE';

export type ScmCapabilities = {
    capabilityScope: 'local-backend';
    readStatus: boolean;
    readDiffFile: boolean;
    readDiffCommit: boolean;
    readLog: boolean;
    readBranches?: boolean;
    readStash?: boolean;
    writeInclude: boolean;
    writeExclude: boolean;
    writeDiscard?: boolean;
    writeCommit: boolean;
    writeCommitPathSelection: boolean;
    writeCommitLineSelection: boolean;
    writeBackout: boolean;
    writeBranchCreate?: boolean;
    writeBranchCheckout?: boolean;
    writeBranchMerge?: boolean;
    writeBranchRebase?: boolean;
    writeBranchOperationControl?: boolean;
    writeRemoteAdd?: boolean;
    writeRemoteSetUrl?: boolean;
    writeRemoteRemove?: boolean;
    writeRemoteFetch: boolean;
    writeRemotePull: boolean;
    writeRemotePush: boolean;
    writeRemotePublish?: boolean;
    readHostingProvider?: boolean;
    readPullRequestStatus?: boolean;
    writePullRequestCreate?: boolean;
    writePullRequestCheckout?: boolean;
    writePullRequestPrepareWorktree?: boolean;
    writePullRequestRunStacked?: boolean;
    defaultBranchPushPolicy?: ScmDefaultBranchPushPolicy;
    writeRepositoryInit?: boolean;
    readHostingRepositoryPublishTargets?: boolean;
    writeHostingRepositoryPublish?: boolean;
    writeRepositoryRemoveIndexLock?: boolean;
    writeStash?: boolean;
    worktreeCreate: boolean;
    changeSetModel: 'index' | 'working-copy';
    supportedDiffAreas: ('included' | 'pending' | 'both')[];
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

export type ScmWorkingEntry = {
    path: string;
    previousPath: string | null;
    kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';
    includeStatus: string;
    pendingStatus: string;
    hasIncludedDelta: boolean;
    hasPendingDelta: boolean;
    stats: {
        includedAdded: number;
        includedRemoved: number;
        pendingAdded: number;
        pendingRemoved: number;
        isBinary: boolean;
    };
};

export type ScmWorktree = {
    id?: string;
    path: string;
    branch: string | null;
    isCurrent: boolean;
    isMain?: boolean;
    isPrunable?: boolean;
    changeCount?: number;
    lastActivityAt?: number;
};

export type ScmRemoteInfo = {
    name: string;
    fetchUrl?: string;
    pushUrl?: string;
};

export type ScmOperationState = {
    kind: ScmBranchIntegrationOperation;
    sourceRef?: string | null;
    canContinue: boolean;
    canAbort: boolean;
};

export type ScmPullRequestState = 'open' | 'closed' | 'merged' | 'draft' | 'unknown';
export type ScmPullRequestChecksState = 'pending' | 'success' | 'failure' | 'unknown';
export type ScmPullRequestAuthState = 'authenticated' | 'authentication_required' | 'unsupported' | 'unknown';

export type ScmPullRequestSummary = {
    [key: string]: unknown;
    provider: ScmHostingProviderRef;
    number?: number | null;
    providerNativeId?: string;
    title: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    headRepositoryNameWithOwner?: string;
    isCrossRepository?: boolean;
    headSha?: string | null;
    baseSha?: string | null;
    state: ScmPullRequestState;
    isDraft?: boolean;
    author?: {
        [key: string]: unknown;
        login?: string;
        displayName?: string;
        url?: string;
    };
    checks?: {
        [key: string]: unknown;
        state: ScmPullRequestChecksState;
        description?: string;
    };
};

export type ScmPullRequestReference =
    | ({ [key: string]: unknown; number: number })
    | ({ [key: string]: unknown; url: string })
    | ({ [key: string]: unknown; headBranch: string });

export type ScmPullRequestStatusProjection = {
    [key: string]: unknown;
    provider: ScmHostingProviderRef | null;
    headBranch: string | null;
    baseBranch: string | null;
    openPullRequest: ScmPullRequestSummary | null;
    composeUrl?: string | null;
    authState?: ScmPullRequestAuthState;
    checkedAt?: number;
    cacheTtlMs?: number;
    // The Protocol validator enforces local/remote semantics with a runtime
    // refinement while its inferred TypeScript output retains every source.
    freshness?: {
        source: 'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote';
        observedAt: number;
        expiresAt?: number;
    };
    refreshPolicy?: ScmRefreshPolicy;
};

export type ScmWorkingSnapshot = {
    projectKey: string;
    fetchedAt: number;
    // Keep the complete schema-inferred source union; validation narrows the
    // local-only semantic at runtime.
    freshness?: {
        source: 'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote';
        observedAt: number;
        expiresAt?: number;
    };
    refreshPolicy?: ScmRefreshPolicy;
    repo: {
        isRepo: boolean;
        rootPath: string | null;
        backendId: string | null;
        mode: ScmRepoMode | null;
        defaultBranch?: string | null;
        worktrees: ScmWorktree[];
        remotes: ScmRemoteInfo[];
    };
    capabilities: ScmCapabilities;
    branch: {
        head: string | null;
        upstream: string | null;
        ahead: number;
        behind: number;
        detached: boolean;
    };
    stashCount?: number;
    operationState?: ScmOperationState | null;
    hostingProvider?: ScmHostingProviderRef | null;
    pullRequestStatus?: ScmPullRequestStatusProjection | null;
    hasConflicts: boolean;
    entries: ScmWorkingEntry[];
    totals: {
        includedFiles: number;
        pendingFiles: number;
        untrackedFiles: number;
        includedAdded: number;
        includedRemoved: number;
        pendingAdded: number;
        pendingRemoved: number;
    };
};

export type ScmBranchListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    includeRemotes?: boolean;
};

export type ScmBranchListEntry = {
    name: string;
    type: 'local' | 'remote';
    upstream?: string | null;
    isCurrent?: boolean;
};

export type ScmBranchListResponse = {
    success: boolean;
    branches?: ScmBranchListEntry[];
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmBranchCreateRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    name: string;
    checkout?: boolean;
    startPoint?: string;
};

export type ScmBranchCreateResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmBranchCheckoutRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    name: string;
    strategy: 'stash_on_current_branch' | 'bring_changes';
    overwriteCurrentBranchStash?: boolean;
};

export type ScmBranchCheckoutResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    didCreateStash?: boolean;
    didPopStash?: boolean;
    stashRef?: string | null;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmRemotePublishRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    remote?: string;
};

export type ScmRemotePublishResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmStatusSnapshotRequest = {
    cwd?: string;
    backendPreference?: {
        kind: 'prefer';
        backendId: string;
    };
    includeWorktreeStatus?: boolean;
};
export type ScmWorktreesEnrichmentRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { worktreePaths: string[] };
export type ScmWorktreeEnrichmentEntry = { path: string; changeCount?: number; lastActivityAt?: number };
export type ScmWorktreesEnrichmentResponse = {
    success: boolean;
    worktrees?: ScmWorktreeEnrichmentEntry[];
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmStatusSnapshotResponse = {
    success: boolean;
    snapshot?: ScmWorkingSnapshot;
    freshness?: {
        source: 'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote';
        observedAt: number;
        expiresAt?: number;
    };
    refreshPolicy?: ScmRefreshPolicy;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmDiffFileRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    path: string;
    area?: 'included' | 'pending' | 'both';
};

export type ScmDiffFileResponse = {
    success: boolean;
    diff?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmDiffCommitRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { commit: string };
export type ScmDiffCommitResponse = ScmDiffFileResponse;
export type ScmChangeApplyRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    paths?: ScmSelectedMutationPath[];
    patch?: string;
};

export type ScmChangeApplyResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmChangeDiscardRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    entries: { path: ScmSelectedMutationPath; kind: ScmWorkingEntry['kind'] }[];
};

export type ScmChangeDiscardResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmCommitCreateRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    message: string;
    scope?:
        | { kind: 'all-pending' }
        | {
            kind: 'paths';
            include: ScmSelectedMutationPath[];
            exclude?: ScmSelectedMutationPath[];
        };
    patches?: { path: ScmSelectedMutationPath; patch: string }[];
};

export type ScmCommitCreateResponse = {
    success: boolean;
    commitSha?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmLogEntry = {
    sha: string;
    shortSha: string;
    authorName: string;
    authorEmail: string;
    timestamp: number;
    subject: string;
    body: string;
};

export type ScmLogListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { limit?: number; skip?: number };
export type ScmLogListResponse = {
    success: boolean;
    entries?: ScmLogEntry[];
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmCommitBackoutRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { commit: string };
export type ScmCommitBackoutResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmRemoteRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { remote?: string; branch?: string };
export type ScmRemoteMutationKind = 'push' | 'pull';
export type ScmRemoteMutationReason =
    | 'conflicts_present'
    | 'upstream_required'
    | 'detached_head'
    | 'branch_behind_remote'
    | 'clean_worktree_required';

export type ScmRemoteMutationPolicy = {
    requireUpstreamWhenNoExplicitTarget: boolean;
    requireActiveHead: boolean;
    blockPushOnConflicts: boolean;
    blockPushWhenBehind: boolean;
    requireCleanPull: boolean;
};

export type ScmRemoteAddRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    name: string;
    fetchUrl: string;
    pushUrl?: string;
};

export type ScmRemoteSetUrlRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    name: string;
    fetchUrl?: string;
    pushUrl?: string | null;
};

export type ScmRemoteRemoveRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { name: string };
export type ScmRemoteManagementResponse = {
    success: boolean;
    remotes?: ScmRemoteInfo[];
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmRemoteResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmBranchIntegrationRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { sourceRef: string };
export type ScmBranchOperationControlRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    operation: ScmBranchIntegrationOperation;
};

export type ScmBranchIntegrationResponse = {
    success: boolean;
    operationState?: ScmOperationState | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmStashEntry = {
    stashRef: string;
    kind: 'branch' | 'transient' | 'unmanaged';
    branch?: string;
    createdAt?: number;
    message?: string;
};

export type ScmStashListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { includeAll?: boolean };
export type ScmStashListResponse = {
    success: boolean;
    stashes?: ScmStashEntry[];
    managedStashes?: ScmStashEntry[];
    managedCount?: number;
    totalCount?: number;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmStashDropRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { stashRef: string };
export type ScmStashDropResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmStashPopRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { stashRef: string };
export type ScmStashPopResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmStashApplyRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { stashRef: string };
export type ScmStashApplyResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmStashShowRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & { stashRef: string; maxBytes?: number };
export type ScmStashShowResponse = {
    success: boolean;
    diff?: string;
    truncated?: boolean;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmWorktreeCreateRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    displayName?: string;
    baseRef?: string;
    branchMode?: 'new' | 'existing';
};

export type ScmWorktreeCreateResponse = {
    success: boolean;
    worktreePath: string;
    branchName: string;
    sourceRootPath?: string;
    repositoryRootPath?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmWorktreeRemoveRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    worktreePath: string;
    confirmed: true;
    authorizationToken: 'remove-worktree';
};

export type ScmWorktreeRemoveResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmWorktreePruneRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'>;
export type ScmWorktreePruneResponse = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmHostingRepositoryVisibility = 'private' | 'public' | 'internal';
export type ScmHostingRepositoryRemoteUrlKind = 'https' | 'ssh';

export type ScmHostingRepositoryAuthSummary = {
    [key: string]: unknown;
    state: 'authenticated' | 'authentication_required' | 'unsupported' | 'unknown';
    profileKind: 'connected_account' | 'provider_cli' | 'no_auth' | 'unknown';
    profileKey?: string;
    label?: string;
    remediation?: {
        [key: string]: unknown;
        kind:
            | 'commit_required'
            | 'set_url_required'
            | 'auth_required'
            | 'install_required'
            | 'unsupported_provider'
            | 'confirmation_required'
            | 'retry';
        label?: string;
        action?: string;
        url?: string;
    };
};

export type ScmHostingRepositoryPublishTarget = {
    [key: string]: unknown;
    provider: ScmHostingProviderRef;
    owner: string;
    ownerKind: 'user' | 'org';
    label: string;
    isDefault?: boolean;
    supportedVisibilities: ScmHostingRepositoryVisibility[];
    supportedRemoteUrlKinds: ScmHostingRepositoryRemoteUrlKind[];
    auth?: ScmHostingRepositoryAuthSummary;
    diagnostics?: string[];
};

export type ScmHostingRepositorySummary = {
    [key: string]: unknown;
    provider: ScmHostingProviderRef;
    nameWithOwner: string;
    webUrl: string;
    cloneUrl?: string;
    sshUrl?: string;
    visibility: ScmHostingRepositoryVisibility;
    defaultBranch?: string | null;
};

export type ScmHostingRepositoryDescribePublishTargetsRequest = {
    [key: string]: unknown;
    cwd?: string;
    backendPreference?: ScmStatusSnapshotRequest['backendPreference'];
    providerId?: string;
    providerKind?: ScmHostingProviderKind;
};

export type ScmHostingRepositoryDescribePublishTargetsResponse =
    | ({
        [key: string]: unknown;
        success: true;
        auth: ScmHostingRepositoryAuthSummary;
        defaultRepositoryName: string;
        targets: ScmHostingRepositoryPublishTarget[];
        diagnostics?: string[];
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
        remediation?: {
            [key: string]: unknown;
            kind:
                | 'commit_required'
                | 'set_url_required'
                | 'auth_required'
                | 'install_required'
                | 'unsupported_provider'
                | 'confirmation_required'
                | 'retry';
            label?: string;
            action?: string;
            url?: string;
        };
        stdout?: string;
        stderr?: string;
    });

export type ScmHostingRepositoryPublishRequest = {
    [key: string]: unknown;
    cwd?: string;
    backendPreference?: ScmStatusSnapshotRequest['backendPreference'];
    providerId?: string;
    providerKind: ScmHostingProviderKind;
    owner: string;
    ownerKind?: 'user' | 'org';
    repositoryName: string;
    visibility: ScmHostingRepositoryVisibility;
    description?: string;
    remoteName?: string;
    remoteUrlKind?: ScmHostingRepositoryRemoteUrlKind;
    remoteConflictStrategy?: 'fail' | 'set-url';
    pushCurrentBranch?: boolean;
};

export type ScmHostingRepositoryPublishResponse =
    | ({
        [key: string]: unknown;
        success: true;
        repository: ScmHostingRepositorySummary;
        remote: ScmRemoteInfo;
        pushed: boolean;
        snapshot?: ScmWorkingSnapshot;
        stdout?: string;
        stderr?: string;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
        remediation?: {
            [key: string]: unknown;
            kind:
                | 'commit_required'
                | 'set_url_required'
                | 'auth_required'
                | 'install_required'
                | 'unsupported_provider'
                | 'confirmation_required'
                | 'retry';
            label?: string;
            action?: string;
            url?: string;
        };
        stdout?: string;
        stderr?: string;
    });

export type ScmRepositoryInitRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    initialBranch?: string;
};

export type ScmRepositoryInitResponse =
    | ({
        [key: string]: unknown;
        success: true;
        alreadyInitialized: boolean;
        snapshot?: ScmWorkingSnapshot;
        stdout?: string;
        stderr?: string;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
        remediation?: {
            [key: string]: unknown;
            kind:
                | 'commit_required'
                | 'set_url_required'
                | 'auth_required'
                | 'install_required'
                | 'unsupported_provider'
                | 'confirmation_required'
                | 'retry';
            label?: string;
            action?: string;
            url?: string;
        };
        stdout?: string;
        stderr?: string;
    });

export type ScmRepositoryRemoveIndexLockRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    confirmed: true;
    confirmationToken: 'remove-stale-index-lock';
};

export type ScmRepositoryRemoveIndexLockResponse =
    | ({
        [key: string]: unknown;
        success: true;
        removed: boolean;
        lockPath: string | null;
        reason?: 'removed' | 'absent';
        snapshot?: ScmWorkingSnapshot;
        stdout?: string;
        stderr?: string;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
        remediation?: {
            [key: string]: unknown;
            kind:
                | 'commit_required'
                | 'set_url_required'
                | 'auth_required'
                | 'install_required'
                | 'unsupported_provider'
                | 'confirmation_required'
                | 'retry';
            label?: string;
            action?: string;
            url?: string;
        };
        stdout?: string;
        stderr?: string;
    });

export type ScmRepositoryCloneInput = {
    provider: ScmHostingProviderRef;
    repository: {
        [key: string]: unknown;
        nameWithOwner: string;
        webUrl?: string;
        cloneUrl?: string;
        sshUrl?: string;
        defaultBranch?: string | null;
        visibility: ScmHostingRepositoryVisibility;
    };
    destinationParentPath: string;
    destinationDirectoryName: string;
    protocol: ScmCloneProtocol;
    confirmed: true;
    authorizationToken: 'clone-repository';
};

export type ScmRepositoryCloneTarget = {
    protocol: 'ssh' | 'https';
    url: string;
    isDefault?: boolean;
};

export type ScmRepositoryCloneTargetDescription = {
    [key: string]: unknown;
    auth?: ScmHostingRepositoryAuthSummary;
    repository: ScmHostingRepositorySummary;
    targets: ScmRepositoryCloneTarget[];
};

export type ScmRepositoryCloneOutput =
    | ({
        [key: string]: unknown;
        success: true;
        destinationPath: string;
        cloneProtocol: 'ssh' | 'https';
        cloneUrl: string;
        repository: ScmHostingRepositorySummary;
        snapshot?: ScmWorkingSnapshot;
        stdout?: string;
        stderr?: string;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
        remediation?: {
            [key: string]: unknown;
            kind:
                | 'commit_required'
                | 'set_url_required'
                | 'auth_required'
                | 'install_required'
                | 'unsupported_provider'
                | 'confirmation_required'
                | 'retry';
            label?: string;
            action?: string;
            url?: string;
        };
        stdout?: string;
        stderr?: string;
    });

export type ScmFollowupAction =
    | ({
        [key: string]: unknown;
        kind: 'openUrl';
        purpose: 'pullRequest' | 'compose';
        url: string;
        allowedBaseUrl: string;
        urlSafety: ScmHostingProviderRef['urlSafety'];
    })
    | ({ [key: string]: unknown; kind: 'none' });

export type ScmPullRequestListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    providerId?: string;
    base?: string;
    head?: string;
    state?: ScmPullRequestState;
};

export type ScmPullRequestListResponse =
    | ({
        [key: string]: unknown;
        success: true;
        pullRequests: ScmPullRequestSummary[];
        freshness?: {
            source: 'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote';
            observedAt: number;
            expiresAt?: number;
        };
        refreshPolicy?: ScmRefreshPolicy;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestGetRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    prReference: ScmPullRequestReference;
};

export type ScmPullRequestGetResponse =
    | ({
        [key: string]: unknown;
        success: true;
        pullRequest: ScmPullRequestSummary | null;
        freshness?: {
            source: 'live-local' | 'cached-local' | 'cached-remote' | 'explicit-remote';
            observedAt: number;
            expiresAt?: number;
        };
        refreshPolicy?: ScmRefreshPolicy;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestOpenComposeRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    providerId?: string;
    base: string;
    head: string;
};

export type ScmPullRequestOpenComposeResponse =
    | ({
        [key: string]: unknown;
        success: true;
        nextAction: ScmFollowupAction;
        composeUrl?: string;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestOpenOrReuseRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    providerId?: string;
    base: string;
    head?: string;
    headRepositoryNameWithOwner?: string;
    title?: string;
    body?: string;
    defaultBranchPushPolicy?: ScmDefaultBranchPushPolicy;
};

export type ScmPullRequestOpenOrReuseResponse =
    | ({
        [key: string]: unknown;
        success: true;
        pullRequest?: ScmPullRequestSummary | null;
        reused?: boolean;
        composeUrl?: string;
        nextAction: ScmFollowupAction;
        authState?: ScmPullRequestAuthState;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestCheckoutRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    prReference: ScmPullRequestReference;
};

export type ScmPullRequestCheckoutResponse =
    | ({
        [key: string]: unknown;
        success: true;
        pullRequest?: ScmPullRequestSummary | null;
        branch?: string;
        headSha?: string | null;
        baseSha?: string | null;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestPrepareWorktreeRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    sourcePath: string;
    prReference: ScmPullRequestReference;
    mode?: 'local' | 'worktree';
};

export type ScmPullRequestPrepareWorktreeResponse =
    | ({
        [key: string]: unknown;
        success: true;
        targetPath: string;
        branch?: string;
        pullRequest?: ScmPullRequestSummary | null;
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestRunStackedPhase = 'branch' | 'commit' | 'push' | 'pr';
export type ScmPullRequestRunStackedProgressEvent = {
    [key: string]: unknown;
    kind: 'action_started' | 'phase_started' | 'phase_finished' | 'action_finished' | 'action_failed' | 'output';
    phase?: ScmPullRequestRunStackedPhase;
    message?: string;
    output?: string;
    timestamp: number;
};

export type ScmPullRequestRunStackedRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference'> & {
    [key: string]: unknown;
    action:
        | 'commit'
        | 'push'
        | 'openOrReuse'
        | 'commitAndPush'
        | 'pushAndOpenOrReuse'
        | 'commitPushAndOpenOrReuse';
    commitMessage?: string;
    featureBranch?: string;
    filePaths?: ScmSelectedMutationPath[];
    base?: string;
    head?: string;
    title?: string;
    body?: string;
    defaultBranchPushPolicy?: ScmDefaultBranchPushPolicy;
};

export type ScmPullRequestRunStackedResponse =
    | ({
        [key: string]: unknown;
        success: true;
        pullRequest?: ScmPullRequestSummary | null;
        composeUrl?: string;
        branch?: string | null;
        commitSha?: string | null;
        nextAction: ScmFollowupAction;
        events: ScmPullRequestRunStackedProgressEvent[];
    })
    | ({
        [key: string]: unknown;
        success: false;
        error: string;
        errorCode?: ScmOperationErrorCode;
        events: ScmPullRequestRunStackedProgressEvent[];
    });

export const SCM_COMMIT_MESSAGE_MAX_LENGTH: 4096 = canonicalScmCommitMessageMaxLength;
export const SCM_COMMIT_PATCH_MAX_COUNT: 256 = canonicalScmCommitPatchMaxCount;
export const SCM_COMMIT_PATCH_MAX_LENGTH: 200_000 = canonicalScmCommitPatchMaxLength;
export const SCM_OPERATION_ERROR_CODES: Readonly<{
    NOT_REPOSITORY: 'NOT_REPOSITORY';
    INVALID_PATH: 'INVALID_PATH';
    INVALID_REQUEST: 'INVALID_REQUEST';
    COMMAND_FAILED: 'COMMAND_FAILED';
    CHANGE_APPLY_FAILED: 'CHANGE_APPLY_FAILED';
    COMMIT_REQUIRED: 'COMMIT_REQUIRED';
    CONFLICTING_WORKTREE: 'CONFLICTING_WORKTREE';
    REMOTE_AUTH_REQUIRED: 'REMOTE_AUTH_REQUIRED';
    REMOTE_UPSTREAM_REQUIRED: 'REMOTE_UPSTREAM_REQUIRED';
    REMOTE_NON_FAST_FORWARD: 'REMOTE_NON_FAST_FORWARD';
    REMOTE_FF_ONLY_REQUIRED: 'REMOTE_FF_ONLY_REQUIRED';
    REMOTE_REJECTED: 'REMOTE_REJECTED';
    REMOTE_NOT_FOUND: 'REMOTE_NOT_FOUND';
    REMOTE_ALREADY_EXISTS: 'REMOTE_ALREADY_EXISTS';
    BRANCH_OPERATION_IN_PROGRESS: 'BRANCH_OPERATION_IN_PROGRESS';
    BRANCH_OPERATION_NOT_IN_PROGRESS: 'BRANCH_OPERATION_NOT_IN_PROGRESS';
    FEATURE_UNSUPPORTED: 'FEATURE_UNSUPPORTED';
    BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE';
}> = canonicalScmOperationErrorCodes;
export const SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN: 'remove-worktree' = canonicalScmWorktreeRemoveAuthorizationToken;
export const ScmCapabilitiesSchema: {
    parse(value: unknown): ScmCapabilities;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmCapabilities }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmCapabilitiesSchema;
export const ScmSelectedMutationPathSchema: {
    parse(value: unknown): ScmSelectedMutationPath;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmSelectedMutationPath }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmSelectedMutationPathSchema;
export const ScmWorkingSnapshotSchema: {
    parse(value: unknown): ScmWorkingSnapshot;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmWorkingSnapshot }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmWorkingSnapshotSchema;
export const ScmRefreshPolicySchema: {
    parse(value: unknown): ScmRefreshPolicy;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmRefreshPolicy }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmRefreshPolicySchema;
export const ScmCloneProtocolSchema: {
    parse(value: unknown): ScmCloneProtocol;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmCloneProtocol }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmCloneProtocolSchema;

export const createScmCapabilities: (input?: Partial<ScmCapabilities>) => ScmCapabilities = canonicalCreateScmCapabilities;
export const evaluateScmRemoteMutationPolicy: (input: {
    kind: ScmRemoteMutationKind;
    snapshot: ScmRemoteMutationSnapshot;
    hasExplicitTarget: boolean;
    policy: ScmRemoteMutationPolicy;
}) => ScmRemoteMutationResult = canonicalEvaluateScmRemoteMutationPolicy;
export const isScmPatchBoundToPath: (path: string, patch: string) => boolean = canonicalIsScmPatchBoundToPath;
export const normalizeScmBranchSourceRef: (value: string | undefined) => ScmBranchSourceRefNormalizationResult = canonicalNormalizeScmBranchSourceRef;
export const normalizeScmRemoteName: (
    value: string | undefined,
    options?: { allowSlash?: boolean },
) => ScmRemoteNameNormalizationResult = canonicalNormalizeScmRemoteName;
export const normalizeScmRemoteRequest: (
    request: Readonly<{ remote?: string; branch?: string }>,
) => ScmRemoteRequestNormalizationResult = canonicalNormalizeScmRemoteRequest;
export const normalizeScmRemoteUrl: (
    value: string | undefined,
    label?: string,
) => ScmRemoteUrlNormalizationResult = canonicalNormalizeScmRemoteUrl;
export const resolveScmScopedChangedPaths: (input: {
    changedPaths: readonly string[];
    include: readonly string[];
    exclude?: readonly string[];
}) => string[] = canonicalResolveScmScopedChangedPaths;

/** @realm daemon */
export type { PluginScmRegistrationApi } from '../activation.js';

export {
    encodeCompareRef,
    parseScmRemoteUrl,
    stripTrailingSlash,
} from './remoteUrl.js';

export type {
    ParsedScmRemoteUrl,
    ScmRemoteUrlScheme,
} from './remoteUrl.js';

/** @realm daemon */
export { evaluateScmRemoteMutationPreconditions } from './remoteMutationPreconditions.js';

export type {
    ScmRemoteMutationGuardResult,
    ScmRemoteMutationReasonMapper,
} from './remoteMutationPreconditions.js';
