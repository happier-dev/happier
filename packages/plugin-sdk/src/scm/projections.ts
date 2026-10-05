import {
    buildWorktreeRelativePath as canonicalBuildWorktreeRelativePath,
    hasForbiddenGitRefName as canonicalHasForbiddenGitRefName,
    normalizeWorktreeDisplayName as canonicalNormalizeWorktreeDisplayName,
    createScmCapabilities as canonicalCreateScmCapabilities,
    evaluateScmRemoteMutationPolicy as canonicalEvaluateScmRemoteMutationPolicy,
    isScmPatchBoundToPath as canonicalIsScmPatchBoundToPath,
    normalizeScmBranchSourceRef as canonicalNormalizeScmBranchSourceRef,
    normalizeScmHostingRepositoryIdentity as canonicalNormalizeScmHostingRepositoryIdentity,
    normalizeScmRemoteName as canonicalNormalizeScmRemoteName,
    normalizeScmRemoteRequest as canonicalNormalizeScmRemoteRequest,
    normalizeScmRemoteUrl as canonicalNormalizeScmRemoteUrl,
    normalizeScmOperationOutcome as canonicalNormalizeScmOperationOutcome,
    sameScmHostingRepositoryIdentity as canonicalSameScmHostingRepositoryIdentity,
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
    ScmOperationOutcomeSchema as canonicalScmOperationOutcomeSchema,
    SourceControlCloneProtocolSchema as canonicalScmCloneProtocolSchema,
    ScmComparisonSourceProtocolSchema as canonicalScmComparisonSourceProtocolSchema,
    ScmComparisonSchema as canonicalScmComparisonSchema,
} from '@happier-dev/protocol/scm';
import type { ScmComparison, ScmComparisonSource as CanonicalScmComparisonSource } from '@happier-dev/protocol/scm';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { ProtocolComposableSchema } from '../protocol/index.js';

export type { ScmComparison } from '@happier-dev/protocol/scm';
/** Declaration-neutral projection; the portable Protocol parser is the sole validator. */
export type ScmComparisonSource =
    | { kind: 'turnCheckpoint'; sessionId?: string; turnId?: string; checkpointReceiptId?: string;
        evidenceMode?: 'checkpoint' | 'agent_reported' | 'reconciled' }
    | { kind: 'session'; sessionId: string }
    | { kind: 'workingTree' }
    | { kind: 'branch'; head: string; base: string }
    | { kind: 'commit'; commit: string; parent?: string }
    | { kind: 'pullRequest'; locator: {
        providerId: string; repository: string; number: number; baseOid?: string; headOid?: string;
        sourceAction?: { action: PluginContributionRef; input?: JsonValue };
    } };
type AssertScmSourceProjection<T extends true> = T;
type _ScmSourceProjectionMustMatchCanonical = AssertScmSourceProjection<
    [ScmComparisonSource] extends [CanonicalScmComparisonSource]
        ? [CanonicalScmComparisonSource] extends [ScmComparisonSource] ? true : false
        : false
>;
/** The source parser and portable grammar remain the Protocol-owned value. */
export const ScmComparisonSourceProtocolSchema: ProtocolComposableSchema<ScmComparisonSource> = canonicalScmComparisonSourceProtocolSchema;
export const ScmComparisonSourceSchema: ProtocolComposableSchema<ScmComparisonSource> = ScmComparisonSourceProtocolSchema;
export const ScmComparisonSchema: {
    parse(value: unknown): ScmComparison;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmComparison }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmComparisonSchema;

export const buildWorktreeRelativePath: (branchName: string) => string = canonicalBuildWorktreeRelativePath;
export const hasForbiddenGitRefName: (value: string) => boolean = canonicalHasForbiddenGitRefName;
export const normalizeWorktreeDisplayName: (value: string) => string = canonicalNormalizeWorktreeDisplayName;
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
    operationState?: ScmOperationState | null;
    branch: Pick<ScmWorkingSnapshot['branch'], 'head' | 'upstream' | 'behind' | 'detached'>;
    totals: Pick<ScmWorkingSnapshot['totals'], 'includedFiles' | 'pendingFiles' | 'untrackedFiles'>;
};

export type ScmRemoteNameNormalizationResult =
    | { ok: true; name: string }
    | { ok: false; error: string };

export type ScmRemoteRequestNormalizationResult =
    | { ok: true; request: {
        dirtyPolicy?: ScmDirtyPolicy;
        reconcile?: ScmReconcilePolicy;
        pushMode?: ScmPushMode;
        expectedRemoteOid?: string;
    } & { remote: string | undefined; branch: string | undefined } }
    | { ok: false; error: string };

export type ScmRemoteUrlNormalizationResult =
    | { ok: true; url: string }
    | { ok: false; error: string };

export type ScmRepoMode = '.git' | '.sl';

export type ScmHostingRepositoryIdentityV1<
    TKind extends ScmHostingProviderKind = ScmHostingProviderKind,
> = Readonly<{
    kind: TKind;
    deployment: string;
    repository: string;
}>;

export const normalizeScmHostingRepositoryIdentity: {
    <TKind extends ScmHostingProviderKind>(
        value: Readonly<{
            kind: TKind;
            deployment?: unknown;
            repository?: unknown;
        }>,
    ): ScmHostingRepositoryIdentityV1<TKind> | null;
    (
        value: Readonly<{
            kind?: unknown;
            deployment?: unknown;
            repository?: unknown;
        }> | null | undefined,
    ): ScmHostingRepositoryIdentityV1 | null;
} = canonicalNormalizeScmHostingRepositoryIdentity;
export const sameScmHostingRepositoryIdentity = canonicalSameScmHostingRepositoryIdentity as (
    left: ScmHostingRepositoryIdentityV1 | null | undefined,
    right: ScmHostingRepositoryIdentityV1 | null | undefined,
) => boolean;
export type ScmBranchIntegrationOperation = 'merge' | 'rebase';
export type ScmRepositoryOperationKind = 'merge' | 'rebase' | 'revert' | 'cherry_pick';
export type ScmDirtyPolicy = 'refuse' | 'autostash' | 'allow_git';
export type ScmReconcilePolicy = 'ff_only' | 'rebase' | 'merge';
export type ScmPushMode = 'ordinary' | 'force_with_lease';
export type ScmDefaultBranchPushPolicy = 'allow' | 'requires-feature-branch' | 'deny';
export type ScmSelectedMutationPath = string;
export type ScmCloneProtocol = 'auto' | 'ssh' | 'https';
export type ScmOperationErrorCode =
    | 'NOT_REPOSITORY'
    | 'INVALID_PATH'
    | 'INVALID_REQUEST'
    | 'SCM_SOURCE_CHANGED'
    | 'COMMAND_FAILED'
    | 'CHANGE_APPLY_FAILED'
    | 'COMMIT_REQUIRED'
    | 'COMMIT_HOOK_FAILED'
    | 'COMMIT_HOOK_CONTENT_CHANGED'
    | 'COMMIT_HEAD_CHANGED'
    | 'COMMIT_STAGING_CONFLICT'
    | 'COMMIT_SIGNING_FAILED'
    | 'COMMIT_IDENTITY_REQUIRED'
    | 'COMMIT_EMPTY'
    | 'COMMIT_AMEND_PUBLISHED'
    | 'COMMIT_UNDO_PUBLISHED'
    | 'COMMIT_UNDO_MERGE'
    | 'COMMIT_UNDO_NO_PARENT'
    | 'COMMIT_UNDO_HEAD_CHANGED'
    | 'INDEX_LOCKED'
    | 'INDEX_RECONCILIATION_FAILED'
    | 'REMOTE_NETWORK_FAILED'
    | 'COMMAND_CANCELLED'
    | 'COMMAND_TIMEOUT'
    | 'COMMAND_OUTPUT_LIMIT_EXCEEDED'
    | 'COMMAND_OUTCOME_UNKNOWN'
    | 'REPOSITORY_REFRESH_FAILED'
    | 'STASH_CREATE_FAILED'
    | 'STASH_APPLY_FAILED'
    | 'STASH_DROP_FAILED'
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
    writeStashCreate?: boolean;
    writeInclude: boolean;
    writeExclude: boolean;
    writeDiscard?: boolean;
    writeCommit: boolean;
    writeCommitUndoLast?: boolean;
    writeCommitAmend?: boolean;
    writeCommitSignOff?: boolean;
    writeCommitExpectedBase?: boolean;
    writeCommitSafePlan?: boolean;
    readCommitResolveOutcome?: boolean;
    writeCommitPathSelection: boolean;
    writeCommitLineSelection: boolean;
    writeBackout: boolean;
    writeBranchCreate?: boolean;
    writeBranchCheckout?: boolean;
    writeBranchMerge?: boolean;
    writeBranchRebase?: boolean;
    writeBranchOperationControl?: boolean;
    writeBranchOperationSkip?: boolean;
    writeConflictResolution?: boolean;
    writeRemoteAdd?: boolean;
    writeRemoteSetUrl?: boolean;
    writeRemoteRemove?: boolean;
    writeRemoteFetch: boolean;
    writeRemotePull: boolean;
    writeRemotePush: boolean;
    writeRemotePublish?: boolean;
    writeRemotePolicies?: boolean;
    writeRemoteForceWithLease?: boolean;
    readHostingProvider?: boolean;
    readPullRequestStatus?: boolean;
    writePullRequestCreate?: boolean;
    writePullRequestDraftCreate?: boolean;
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
        isComplete?: boolean;
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

export type ScmConflictEntry = {
    path: string;
    kind: string;
    indexStages?: { base?: string; ours?: string; theirs?: string };
};

export type ScmOperationState = {
    kind: ScmRepositoryOperationKind;
    sourceRef?: string | null;
    replayCommit?: string;
    baseOid?: string;
    headOid?: string;
    unresolvedCount?: number;
    conflicts?: ScmConflictEntry[];
    canContinue: boolean;
    canAbort: boolean;
    canSkip?: boolean;
};

export type ScmOperationRepositoryState = {
    headOid?: string;
    hasConflicts: boolean;
    operation: ScmOperationState | null;
};

export type ScmOperationEffect =
    | { kind: 'commit'; commitSha: string }
    | { kind: 'stash'; stashOid: string; stashRef?: string }
    | { kind: 'pull_request'; url: string; number?: number }
    | { kind: 'branch'; name: string; headOid?: string }
    | { kind: 'remote'; remote: string; branch?: string; remoteOid?: string };

export type ScmOperationReconciliation =
    | { kind: 'repository_status'; cwd?: string }
    | { kind: 'commit'; commitSha: string }
    | { kind: 'stash'; stashOid?: string; message?: string }
    | { kind: 'remote_ref'; remote: string; branch?: string; expectedOid?: string }
    | { kind: 'pull_request'; head: string; base?: string; providerId?: string; repository?: string; url?: string };

export type ScmOperationNextAction =
    | { kind: 'refresh' | 'retry' | 'resolve_conflicts' | 'continue' | 'skip' | 'abort' | 'reconcile_index' | 'choose_dirty_policy' | 'choose_reconcile' | 'configure_upstream' | 'authenticate' }
    | { kind: 'open_url'; url: string };

/** Preserve each schema arm as an object rather than an intersection carrier. */
type ScmShape<T> = T extends object ? { [K in keyof T]: T[K] } : T;

export type ScmOperationOutcome = ScmShape<{
    v: 1;
    nextActions: ScmOperationNextAction[];
    message?: string;
    recoveryStash?: { stashOid: string; stashRef?: string };
} & (
    | { kind: 'succeeded'; effect?: ScmOperationEffect; repositoryState?: ScmOperationRepositoryState }
    | { kind: 'needs_input'; errorCode: ScmOperationErrorCode; repositoryState?: ScmOperationRepositoryState }
    | { kind: 'conflicted'; errorCode: ScmOperationErrorCode; repositoryState: ScmOperationRepositoryState }
    | { kind: 'effect_applied_with_warning'; errorCode: ScmOperationErrorCode; effect: ScmOperationEffect; repositoryState?: ScmOperationRepositoryState }
    | { kind: 'failed'; errorCode: ScmOperationErrorCode; repositoryState?: ScmOperationRepositoryState }
    | { kind: 'cancelled'; errorCode?: ScmOperationErrorCode; repositoryState: ScmOperationRepositoryState }
    | { kind: 'outcome_unknown'; errorCode: ScmOperationErrorCode; reconciliation: ScmOperationReconciliation; repositoryState?: ScmOperationRepositoryState }
)>;

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
        headOid?: string;
        upstream: string | null;
        upstreamOid?: string;
        ahead: number;
        behind: number;
        detached: boolean;
    };
    stashCount?: number;
    operationState?: ScmOperationState | null;
    operationStateVersion?: 1;
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
        isComplete?: boolean;
    };
};

export type ScmBranchListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
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

export type ScmBranchCreateRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    name: string;
    checkout?: boolean;
    startPoint?: string;
};

export type ScmBranchCreateResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmBranchCheckoutRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    name: string;
    strategy: 'stash_on_current_branch' | 'bring_changes';
    overwriteCurrentBranchStash?: boolean;
};

export type ScmBranchCheckoutResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    didCreateStash?: boolean;
    didPopStash?: boolean;
    stashRef?: string | null;
    stashOid?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmRemotePublishRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    remote?: string;
};

export type ScmRemotePublishResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
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
    operationStateVersion?: 1;
    outcomeVersion?: 1;
};
export type ScmWorktreesEnrichmentRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { worktreePaths: string[] };
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

export type ScmDiffFileRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    path: string;
    area?: 'included' | 'pending' | 'both';
};

export type ScmDiffFileResponse = {
    success: boolean;
    diff?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmDiffCommitRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    commit: string;
    beforeTreeOid?: string;
};
export type ScmDiffCommitResponse = ScmDiffFileResponse & {
    beforeTreeOid?: string;
    afterTreeOid?: string;
    files?: { path: string; previousPath?: string; changeKind: string; unifiedDiff: string }[];
};
export type ScmChangeApplyRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    paths?: ScmSelectedMutationPath[];
    patch?: string;
};

export type ScmChangeApplyResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmChangeDiscardRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    entries: { path: ScmSelectedMutationPath; kind: ScmWorkingEntry['kind'] }[];
};

export type ScmChangeDiscardResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmCommitCreateRequest = ScmShape<Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    message: string;
    mode?: 'commit' | 'amend';
    signOff?: boolean;
    allowPublishedAmend?: boolean;
    expectedHeadOid?: string | null;
    expectedRef?: string | null;
    expectedCandidateTreeOid?: string;
    preparedTreeOid?: string;
    expectedIndexTreeOid?: string;
    acceptedHookTreeOid?: string;
    scope?:
        | { kind: 'all-pending' }
        | {
            kind: 'paths';
            include: ScmSelectedMutationPath[];
            exclude?: ScmSelectedMutationPath[];
        };
    patches?: { path: ScmSelectedMutationPath; patch: string }[];
}>;

export type ScmCommitPublication = {
    state: 'not_published' | 'published' | 'unknown';
    expectedHeadOid: string | null;
    expectedRef: string | null;
    candidateOid?: string;
    actualMessage?: string;
    indexReconciliation: 'not_required' | 'pending' | 'reconciled' | 'failed';
    indexTreeOid?: string;
    hookName?: string;
    committedAtMs?: number;
    signed?: boolean;
};
export type ScmCommitHookContentChanges = {
    beforeTreeOid: string;
    afterTreeOid: string;
    changes: { path: ScmSelectedMutationPath; previousPath?: ScmSelectedMutationPath; kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type_changed' }[];
};
export type ScmCommitCreateResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    publication?: ScmCommitPublication;
    hookContentChanges?: ScmCommitHookContentChanges;
    stdout?: string;
    stderr?: string;
    commitSha?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmCommitResolveOutcomeRequest = ScmShape<Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    candidateOid: string;
    expectedHeadOid: string | null;
    expectedRef: string | null;
}>;
export type ScmCommitResolveOutcomeResponse = {
    success: boolean;
    publication: ScmCommitPublication;
    candidateTreeOid?: string;
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

export type ScmLogListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { limit?: number; skip?: number; query?: string; range?: 'incoming' };
export type ScmLogListResponse = {
    success: boolean;
    entries?: ScmLogEntry[];
    /**
     * Echoed `true` only by producers that honored a request `query`; absence means the
     * producer ignored the query and returned a recent page.
     */
    queryApplied?: boolean;
    rangeApplied?: boolean;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmCommitBackoutRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { commit: string };
export type ScmCommitUndoLastRequest = ScmShape<Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { expectedHeadOid: string }>;
export type ScmCommitUndoLastResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    undoneCommitSha?: string;
    headOid?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmCommitBackoutResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmRemoteRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    remote?: string;
    branch?: string;
    dirtyPolicy?: ScmDirtyPolicy;
    reconcile?: ScmReconcilePolicy;
    pushMode?: ScmPushMode;
    expectedRemoteOid?: string;
};
export type ScmRemoteMutationKind = 'push' | 'pull';
export type ScmRemoteMutationReason =
    | 'operation_in_progress'
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
    blockActiveOperation?: boolean;
    allowDetachedPushWithExplicitSource?: boolean;
};

export type ScmRemoteAddRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    name: string;
    fetchUrl: string;
    pushUrl?: string;
};

export type ScmRemoteSetUrlRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    name: string;
    fetchUrl?: string;
    pushUrl?: string | null;
};

export type ScmRemoteRemoveRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { name: string };
export type ScmRemoteManagementResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    remotes?: ScmRemoteInfo[];
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmRemoteResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmBranchIntegrationRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { sourceRef: string };
export type ScmBranchOperationControlRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    operation: ScmRepositoryOperationKind;
};

export type ScmConflictAcceptSideRequest = ScmShape<Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    path: ScmSelectedMutationPath;
    side: 'ours' | 'theirs';
}>;
export type ScmConflictMarkResolvedRequest = ScmShape<Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    paths: ScmSelectedMutationPath[];
}>;
export type ScmConflictAcceptSideResponse = ScmBranchIntegrationResponse;
export type ScmConflictMarkResolvedResponse = ScmBranchIntegrationResponse;

export type ScmBranchIntegrationResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    operationState?: ScmOperationState | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmStashEntry = {
    stashRef: string;
    stashOid?: string;
    kind: 'branch' | 'transient' | 'unmanaged';
    branch?: string;
    createdAt?: number;
    message?: string;
};

export type ScmStashListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { includeAll?: boolean };
export type ScmStashListResponse = {
    success: boolean;
    stashes?: ScmStashEntry[];
    managedStashes?: ScmStashEntry[];
    managedCount?: number;
    totalCount?: number;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmStashCreateRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { message?: string };
export type ScmStashCreateResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stashCreated?: boolean;
    stashRef?: string | null;
    stashOid?: string;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmStashDropRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { stashRef: string };
export type ScmStashDropResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmStashPopRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { stashRef: string };
export type ScmStashPopResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmStashApplyRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { stashRef: string };
export type ScmStashApplyResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmStashShowRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & { stashRef: string; maxBytes?: number };
export type ScmStashShowResponse = {
    success: boolean;
    diff?: string;
    truncated?: boolean;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmWorktreeCreateRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    displayName?: string;
    baseRef?: string;
    branchMode?: 'new' | 'existing';
};

export type ScmWorktreeCreateResponse = {
    success: true;
    outcome?: ScmOperationOutcome;
    worktreePath: string;
    branchName: string;
    sourceRootPath?: string;
    repositoryRootPath?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
} | {
    success: false;
    outcome?: ScmOperationOutcome;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};

export type ScmWorktreeRemoveRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    worktreePath: string;
    confirmed: true;
    authorizationToken: 'remove-worktree';
};

export type ScmWorktreeRemoveResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
    stdout?: string;
    stderr?: string;
    error?: string;
    errorCode?: ScmOperationErrorCode;
};
export type ScmWorktreePruneRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'>;
export type ScmWorktreePruneResponse = {
    success: boolean;
    outcome?: ScmOperationOutcome;
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
    outcomeVersion?: 1;
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
        outcome?: ScmOperationOutcome;
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
    outcomeVersion?: 1;
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
        outcome?: ScmOperationOutcome;
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
        outcome?: ScmOperationOutcome;
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

export type ScmRepositoryInitRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    [key: string]: unknown;
    initialBranch?: string;
};

export type ScmRepositoryInitResponse =
    | ({
        [key: string]: unknown;
        success: true;
        outcome?: ScmOperationOutcome;
        alreadyInitialized: boolean;
        snapshot?: ScmWorkingSnapshot;
        stdout?: string;
        stderr?: string;
    })
    | ({
        [key: string]: unknown;
        success: false;
        outcome?: ScmOperationOutcome;
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

export type ScmRepositoryRemoveIndexLockRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    confirmed: true;
    confirmationToken: 'remove-stale-index-lock';
};

export type ScmRepositoryRemoveIndexLockResponse =
    | ({
        [key: string]: unknown;
        success: true;
        outcome?: ScmOperationOutcome;
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
        outcome?: ScmOperationOutcome;
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
        outcome?: ScmOperationOutcome;
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
        outcome?: ScmOperationOutcome;
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

export type ScmPullRequestListRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
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

export type ScmPullRequestGetRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
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

export type ScmPullRequestOpenComposeRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    [key: string]: unknown;
    providerId?: string;
    base: string;
    head: string;
};

export type ScmPullRequestOpenComposeResponse =
    | ({
        [key: string]: unknown;
        success: true;
        outcome?: ScmOperationOutcome;
        nextAction: ScmFollowupAction;
        composeUrl?: string;
    })
    | ({
        [key: string]: unknown;
        success: false;
        outcome?: ScmOperationOutcome;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestOpenOrReuseRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    [key: string]: unknown;
    providerId?: string;
    base: string;
    head?: string;
    headRepositoryNameWithOwner?: string;
    title?: string;
    body?: string;
    draft?: boolean;
    defaultBranchPushPolicy?: ScmDefaultBranchPushPolicy;
};

export type ScmPullRequestOpenOrReuseResponse =
    | ({
        [key: string]: unknown;
        success: true;
        outcome?: ScmOperationOutcome;
        pullRequest?: ScmPullRequestSummary | null;
        reused?: boolean;
        composeUrl?: string;
        nextAction: ScmFollowupAction;
        authState?: ScmPullRequestAuthState;
    })
    | ({
        [key: string]: unknown;
        success: false;
        outcome?: ScmOperationOutcome;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestCheckoutRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    [key: string]: unknown;
    prReference: ScmPullRequestReference;
};

export type ScmPullRequestCheckoutResponse =
    | ({
        [key: string]: unknown;
        success: true;
        outcome?: ScmOperationOutcome;
        pullRequest?: ScmPullRequestSummary | null;
        branch?: string;
        headSha?: string | null;
        baseSha?: string | null;
    })
    | ({
        [key: string]: unknown;
        success: false;
        outcome?: ScmOperationOutcome;
        error: string;
        errorCode?: ScmOperationErrorCode;
    });

export type ScmPullRequestPrepareWorktreeRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
    [key: string]: unknown;
    sourcePath: string;
    prReference: ScmPullRequestReference;
    mode?: 'local' | 'worktree';
};

export type ScmPullRequestPrepareWorktreeResponse =
    | ({
        [key: string]: unknown;
        success: true;
        outcome?: ScmOperationOutcome;
        targetPath: string;
        branch?: string;
        pullRequest?: ScmPullRequestSummary | null;
    })
    | ({
        [key: string]: unknown;
        success: false;
        outcome?: ScmOperationOutcome;
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

export type ScmPullRequestRunStackedRequest = Pick<ScmStatusSnapshotRequest, 'cwd' | 'backendPreference' | 'outcomeVersion'> & {
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
        outcome?: ScmOperationOutcome;
        pullRequest?: ScmPullRequestSummary | null;
        composeUrl?: string;
        branch?: string | null;
        commitSha?: string | null;
        commitPublication?: ScmCommitPublication;
        nextAction: ScmFollowupAction;
        events: ScmPullRequestRunStackedProgressEvent[];
    })
    | ({
        [key: string]: unknown;
        success: false;
        outcome?: ScmOperationOutcome;
        commitSha?: string | null;
        commitPublication?: ScmCommitPublication;
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
    SCM_SOURCE_CHANGED: 'SCM_SOURCE_CHANGED';
    COMMAND_FAILED: 'COMMAND_FAILED';
    CHANGE_APPLY_FAILED: 'CHANGE_APPLY_FAILED';
    COMMIT_REQUIRED: 'COMMIT_REQUIRED';
    COMMIT_HOOK_FAILED: 'COMMIT_HOOK_FAILED';
    COMMIT_HOOK_CONTENT_CHANGED: 'COMMIT_HOOK_CONTENT_CHANGED';
    COMMIT_HEAD_CHANGED: 'COMMIT_HEAD_CHANGED';
    COMMIT_STAGING_CONFLICT: 'COMMIT_STAGING_CONFLICT';
    COMMIT_SIGNING_FAILED: 'COMMIT_SIGNING_FAILED';
    COMMIT_IDENTITY_REQUIRED: 'COMMIT_IDENTITY_REQUIRED';
    COMMIT_EMPTY: 'COMMIT_EMPTY';
    COMMIT_AMEND_PUBLISHED: 'COMMIT_AMEND_PUBLISHED';
    COMMIT_UNDO_PUBLISHED: 'COMMIT_UNDO_PUBLISHED';
    COMMIT_UNDO_MERGE: 'COMMIT_UNDO_MERGE';
    COMMIT_UNDO_NO_PARENT: 'COMMIT_UNDO_NO_PARENT';
    COMMIT_UNDO_HEAD_CHANGED: 'COMMIT_UNDO_HEAD_CHANGED';
    INDEX_LOCKED: 'INDEX_LOCKED';
    INDEX_RECONCILIATION_FAILED: 'INDEX_RECONCILIATION_FAILED';
    REMOTE_NETWORK_FAILED: 'REMOTE_NETWORK_FAILED';
    COMMAND_CANCELLED: 'COMMAND_CANCELLED';
    COMMAND_TIMEOUT: 'COMMAND_TIMEOUT';
    COMMAND_OUTPUT_LIMIT_EXCEEDED: 'COMMAND_OUTPUT_LIMIT_EXCEEDED';
    COMMAND_OUTCOME_UNKNOWN: 'COMMAND_OUTCOME_UNKNOWN';
    REPOSITORY_REFRESH_FAILED: 'REPOSITORY_REFRESH_FAILED';
    STASH_CREATE_FAILED: 'STASH_CREATE_FAILED';
    STASH_APPLY_FAILED: 'STASH_APPLY_FAILED';
    STASH_DROP_FAILED: 'STASH_DROP_FAILED';
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
export const ScmOperationOutcomeSchema: {
    parse(value: unknown): ScmOperationOutcome;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: ScmOperationOutcome }>
        | Readonly<{ success: false; error: unknown }>;
} = canonicalScmOperationOutcomeSchema;

export const normalizeScmOperationOutcome: (response: Readonly<{
    success: boolean;
    outcome?: ScmOperationOutcome;
    errorCode?: ScmOperationErrorCode;
    error?: string;
    commitSha?: string;
    publication?: ScmCommitPublication;
}>) => ScmOperationOutcome = canonicalNormalizeScmOperationOutcome;
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
    request: Readonly<Pick<ScmRemoteRequest, 'remote' | 'branch' | 'dirtyPolicy' | 'reconcile' | 'pushMode' | 'expectedRemoteOid'>>,
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
    ScmRemoteUrlScheme,
    ScmTransportIdentityV1,
} from './remoteUrl.js';

/** @realm daemon */
export { evaluateScmRemoteMutationPreconditions } from './remoteMutationPreconditions.js';

export type {
    ScmRemoteMutationGuardResult,
    ScmRemoteMutationReasonMapper,
} from './remoteMutationPreconditions.js';

export type ScmReviewWorkspaceSourceTip = Readonly<{
    repository: Readonly<{
        kind: ScmHostingProviderKind;
        deployment: string;
        repository: string;
    }>;
    cloneUrl: string;
    branch: string;
    sourceHeadSha: string;
    fetchRef: string;
}>;

export type ScmReviewWorkspaceCurrentness =
    | Readonly<{ kind: 'currentAtObservedHead' }>
    | Readonly<{
        kind: 'movedToObservedHead';
        fromSha: string;
        observedHeadSha: string;
        recoveryRef: string;
    }>
    | Readonly<{
        kind: 'preservedStale';
        resolvedHeadSha: string;
        observedHeadSha: string;
        reason: 'localCommits' | 'dirtyWorktree' | 'unresolvedHead';
    }>;
