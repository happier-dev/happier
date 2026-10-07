import type { TranscriptAccountActorMetadata } from "@happier-dev/session-core/messages";
import { z } from "zod";
import type { PermissionMode, ModelMode } from "@/sync/domains/permissions/permissionTypes";
import type {
    PendingDeliveryBlockedReason,
    PendingActivationAuthorizationV1,
    PrimaryTurnStatusV1,
    ScmBackendId,
    ScmHostingProviderRef,
    ScmPullRequestStatusProjection,
    SessionAccessAccountSummaryV1,
    SessionMessageRole,
    SessionReportsToV1,
    SessionReportsV1,
    SessionRuntimeIssueV1,
    SessionTurnsProjectionV1,
    SessionContextUsageSnapshotV1,
    SessionViewerProjectionV1,
} from "@happier-dev/protocol";
import { CliUpdateFactsSchema } from '@happier-dev/protocol/machines/cliUpdateFacts';
import { WindowsRemoteSessionLaunchModeSchema } from '@happier-dev/protocol/sessions/metadata/windowsRemoteSessionLaunchMode';
import type { Metadata, AgentState } from "@happier-dev/session-core/state";
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import type { ScmOperationState as ProtocolScmOperationState } from '@happier-dev/protocol/scm';

export interface Session {
    id: string,
    serverId?: string,
    seq: number,
    /**
     * Session content encryption mode. Missing means legacy/unknown and should be treated as `e2ee`.
     */
    encryptionMode?: 'e2ee' | 'plain',
    createdAt: number,
    updatedAt: number,
    meaningfulActivityAt?: number | null,
    active: boolean,
    activeAt: number,
    /**
     * Global server-side archive marker. Archived sessions should be hidden from the main list by default.
     * Optional for mixed-version safety with older servers.
     */
    archivedAt?: number | null,
    /**
     * Server-side pending queue (V2) summary fields.
     * Optional for mixed-version safety with older servers.
     */
    pendingVersion?: number,
    pendingCount?: number,
    pendingBlockedCount?: number,
    pendingActivationAuthorization?: PendingActivationAuthorizationV1 | null,
    lastViewedSessionSeq?: number | null,
    unreadSince?: number | null,
    /** Absent only for supported Homes predating private viewer projection. */
    viewer?: SessionViewerProjectionV1,
    pendingPermissionRequestCount?: number,
    pendingUserActionRequestCount?: number,
    pendingRequestObservedAt?: number | null,
    /** The Session this one reports to (ORC R-03). Ids only; membership grants nothing. */
    reportsTo?: SessionReportsToV1 | null,
    origin?: import('@happier-dev/protocol').SessionAwarenessOriginV1,
    workDepth?: number,
    /** Direct `reportsTo` children, counted by the server (awareness `reports`). */
    reports?: SessionReportsV1 | null,
    latestTurnId?: string | null,
    latestTurnStatus?: PrimaryTurnStatusV1 | null,
    latestTurnStatusObservedAt?: number | null,
    rollbackEligibleTurnStarts?: readonly number[] | null,
    sessionTurns?: SessionTurnsProjectionV1 | null,
    latestReadyEventSeq?: number | null,
    latestReadyEventAt?: number | null,
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null,
    runtimeActivityActiveCount?: number | null,
    runtimeActivityState?: 'active' | 'idle' | 'unknown' | null,
    runtimeActivityObservedAt?: number | null,
    runtimeActivityRevision?: number | null,
    /**
     * Server-readable transcript authority. Missing on older servers; linked sessions
     * with no value must fail closed as legacy-unknown rather than infer persistence.
     */
    currentStorageState?: 'machine_only' | 'server_partial' | 'snapshot_complete' | 'hosted' | 'legacy_external_unknown',
    acceptedThroughServerSeq?: number | null,
    materializedThroughSourceAt?: number | null,
    publishedThroughServerSeq?: number | null,
    /** Server-owned sharing admission. Missing on older servers and fails closed for snapshots. */
    transcriptShareable?: boolean,
    /**
     * The one human Account currently responsible for this Session.
     *
     * `undefined` means this server did not project responsibility and must never
     * be rendered as "No one"; `null` is a supporting server stating the Session
     * is unassigned.
     */
    responsibleAccountId?: string | null,
    /**
     * Safe current summary for `responsibleAccountId`, projected at read/mutation
     * time. `null` when unassigned; omitted exactly when the id is omitted. It
     * lets the section render the named assignee without loading candidates.
     */
    responsibleAccount?: SessionAccessAccountSummaryV1 | null,
    /**
     * Safe audience-existence signal projected by the server's current-recipient
     * owner: true when the current authorized human audience contains another
     * Account besides this viewer. Presence-independent; never a roster and
     * never authorization. Omitted means the producer did not project it, which
     * preserves the last known value instead of asserting solo.
     */
    hasOtherNamedCollaborator?: boolean,
    metadataLayoutVersion?: number,
    /** Producer-owned memory-only route projection; never changes the Session access role. */
    metadataProjection?: 'sessionOnly',
    metadata: Metadata | null,
    /**
     * Ephemeral safe shared title retained for an authorized layout-v1 recipient while the
     * encrypted metadata is locked. It is a string-only projection; owner metadata and other
     * encrypted fields must never be copied here, and it is cleared on access/Home changes.
     */
    lockedDisplayTitle?: string | null,
    /**
     * Owner-only layout-v1 metadata after the account-scoped envelope has been
     * opened. The wire ciphertext is consumed at the session read boundary.
     */
    /**
     * Ephemeral owner compatibility projection. It is derived from the strict
     * shared and owner envelopes and is never serialized as shared metadata.
     */
    ownerMetadataView?: Metadata | null,
    /** Memory-only bounded input produced with the Session metadata tuple. */
    composerOptionsInput?: ComposerOptionsInputV1 | null,
    metadataVersion: number,
    agentState: AgentState | null,
    agentStateVersion: number,
    thinking: boolean,
    thinkingAt: number,
    /** Device-observed runtime presence. Durable Session `active` state never manufactures it. */
    presence?: "online" | number,
    optimisticThinkingAt?: number | null; // Local-only timestamp used for immediate "processing" UI feedback after submit
    resumingAt?: number | null; // Local-only: set at resume initiation; cleared by post-attach activity, definitive failure, or a bounded post-acceptance fallback.
    thinkingGraceUntil?: number | null; // Local-only timestamp used to debounce thinking indicator and avoid flicker between streaming chunks
    lastTurnCompletedAt?: number | null; // Local-only explicit terminal lifecycle timestamp used for completion surfaces
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: PermissionMode | null; // Local permission mode, not synced to server
    permissionModeUpdatedAt?: number | null; // Local timestamp to coordinate inferred (from last message) vs user-selected mode, not synced to server
    modelMode?: ModelMode | null; // Local model mode, not synced to server
    modelModeUpdatedAt?: number | null; // Local timestamp used to arbitrate model overrides across devices, not synced to server
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindowTokens?: number;
        contextSnapshot: SessionContextUsageSnapshotV1;
        contextSnapshotStale: boolean;
        timestamp: number;
    } | null;
    // Sharing-related fields
    access?: import('@/sync/engine/sessions/normalizeSessionAccessProjection').NormalizedSessionAccessProjection | null;
    /**
     * Settled outcome of this viewer's Session data-key hydration. Derived by the canonical
     * encryption owner, never persisted as a second availability store, and the only field a
     * consumer should read to decide whether Session content is showable.
     */
    encryptedContentAvailability?: import('@/sync/domains/session/encryptedContentAvailability').SessionContentAvailability | null;
    owner?: string; // User ID of the session owner (for shared sessions)
    ownerProfile?: {
        id: string;
        username: string | null;
        firstName: string | null;
        lastName: string | null;
        avatar: string | null;
    }; // Owner profile information (for shared sessions)
    accessLevel?: 'view' | 'edit' | 'admin'; // Access level for shared sessions
    canApprovePermissions?: boolean; // Whether the current user can approve permission prompts for this shared session
}

export type PendingDeliveryStatus = 'server_queued' | 'server_delivering' | 'external_handoff' | 'blocked';

export type { PendingDeliveryBlockedReason };

export interface PendingMessage extends TranscriptAccountActorMetadata {
    recipient?: Extract<import('@happier-dev/protocol').ParticipantRecipientRoutingIdentityV1, { kind: 'execution_run' }>;
    id: string;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
    source?: 'local_outbound' | 'server_pending';
    deliveryStatus?: 'queued' | 'accepted';
    /** Durable-outbox authority for local outbound rows; never inferred from the active server. */
    pendingOutboxScope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope;
    /** Durable local outbox operation; `cancel` must never be presented or retried as a send. */
    pendingOutboxOperation?: 'enqueue' | 'cancel';
    sendState?: 'unconfirmed' | 'failed';
    pendingDeliveryStatus?: PendingDeliveryStatus;
    /** Descriptive detail for a delivering row; never an outcome or settlement authority. */
    pendingDeliveryDetail?: import('@happier-dev/protocol').PendingDeliveryDetailV1;
    pendingDeliveryStatusRaw?: string;
    pendingDeliveryBlockedReason?: PendingDeliveryBlockedReason;
    pendingDeliveryBlockedReasonRaw?: string;
    /** Server-owned action intent for this durable Pending row. */
    pendingRequestedAction?: import('@happier-dev/protocol').PendingRequestedActionV1;
    /** Corrupt non-null action data is visible and never treated as ordinary enqueue. */
    pendingRequestedActionMalformed?: boolean;
    /** Protocol-owned role for eligibility decisions; null means an older/unknown row. */
    messageRole?: 'user' | 'non_user' | null;
    text: string;
    displayText?: string;
    pendingDecryptFailure?: { kind: 'decrypt_failed' };
    rawRecord: any;
}

export interface DiscardedPendingMessage extends PendingMessage {
    discardedAt: number;
    discardedReason: 'switch_to_local' | 'manual' | 'dismissed_uncertain' | 'resent_as_new';
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    messageRole?: SessionMessageRole | null,
    content: any,
    createdAt: number,
}

//
// Machine states
//

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    happyHomeDir: z.string(), // Directory for Happier auth, settings, logs (usually .happy/ or .happy-dev/)
    homeDir: z.string(), // User's home directory (matches CLI field name)
    // Optional fields that may be added in future versions
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(), // Custom display name for the machine
    windowsRemoteSessionLaunchMode: WindowsRemoteSessionLaunchModeSchema.optional(),
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    daemonTerminalSessionAttachSupported: z.boolean().optional(),
    daemonSessionGoalControlsSupported: z.boolean().optional(),
    // Daemon status fields
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']).optional(),
    // K5 — this machine's Happier CLI update facts. Absent from daemons that predate them; a
    // malformed value degrades to absent rather than failing the whole metadata record.
    cliUpdate: CliUpdateFactsSchema.optional().catch(undefined),
});

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export type MachineLockedReason =
    | 'encryption_material_unavailable'
    | 'decryption_failed'
    | 'content_unreadable';

export type MachineAvailability =
    | Readonly<{ kind: 'available' }>
    | Readonly<{
        kind: 'locked';
        reason: MachineLockedReason;
    }>;

export interface Machine {
    id: string;
    kind?: import('@happier-dev/protocol').MachineKind;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;  // Changed from lastActiveAt to activeAt for consistency
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    replacedAt?: number | string | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
    installationId?: string | null;
    contentPublicKeyFingerprint?: string | null;
    operationProtocolCapabilities?: import('@happier-dev/protocol').MachineOperationProtocolCapabilitiesV1 | null;
    operationProtocolCapabilitiesRevision?: number | null;
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: any | null;  // Dynamic daemon state (runtime info)
    daemonStateVersion: number;
    storageMode?: 'plain' | 'e2ee';
    /**
     * Persisted rows that this client cannot read remain visible and carry an
     * explicit locked state instead of looking like ordinary empty Machines.
     */
    availability?: MachineAvailability;
}

//
// Source Control Status
//

export interface ScmStatus {
    isComplete?: boolean;
    branch: string | null;
    isDirty: boolean;
    /**
     * How many files changed, untracked included: the length of `selectScmChangedFiles`, so every
     * surface that shows a change count shows this one.
     */
    changedFileCount: number;
    includedCount: number;
    lastUpdatedAt: number;
    // Line change statistics - separated by included vs pending
    includedLinesAdded: number;
    includedLinesRemoved: number;
    pendingLinesAdded: number;
    pendingLinesRemoved: number;
    // Computed totals
    linesAdded: number;      // includedLinesAdded + pendingLinesAdded
    linesRemoved: number;    // includedLinesRemoved + pendingLinesRemoved
    linesChanged: number;    // Total lines that were modified (added + removed)
    // Branch tracking information (from porcelain v2)
    upstreamBranch?: string | null; // Name of upstream branch
    aheadCount?: number; // Commits ahead of upstream
    behindCount?: number; // Commits behind upstream
    stashCount?: number; // Number of stash entries
}

export type ScmEntryKind =
    | 'modified'
    | 'added'
    | 'deleted'
    | 'renamed'
    | 'copied'
    | 'untracked'
    | 'conflicted';

export interface ScmPathStats {
    isComplete?: boolean;
    includedAdded: number;
    includedRemoved: number;
    pendingAdded: number;
    pendingRemoved: number;
    isBinary: boolean;
}

export interface ScmCommitSelectionPatch {
    path: string;
    patch: string;
}

export interface ScmCapabilities {
    capabilityScope?: 'local-backend';
    readStatus: boolean;
    readDiffFile: boolean;
    readDiffCommit: boolean;
    readLog: boolean;
    writeInclude: boolean;
    writeExclude: boolean;
    writeCommit: boolean;
    writeCommitUndoLast?: boolean;
    writeCommitPathSelection?: boolean;
    writeCommitLineSelection?: boolean;
    writeBackout: boolean;
    writeDiscard?: boolean;
    writeRemoteFetch: boolean;
    writeRemotePull: boolean;
    writeRemotePush: boolean;
    writeRemotePublish?: boolean;
    readBranches?: boolean;
    writeBranchCreate?: boolean;
    writeBranchCheckout?: boolean;
    writeBranchMerge?: boolean;
    writeBranchRebase?: boolean;
    writeBranchOperationControl?: boolean;
    writeRemoteAdd?: boolean;
    writeRemoteSetUrl?: boolean;
    writeRemoteRemove?: boolean;
    readHostingProvider?: boolean;
    readPullRequestStatus?: boolean;
    writePullRequestCreate?: boolean;
    /** The daemon can create a Draft pull request (older daemons would open a regular one). */
    writePullRequestDraftCreate?: boolean;
    /** The backend can skip the commit being replayed (rebase / cherry-pick). */
    writeBranchOperationSkip?: boolean;
    /** Pull accepts an explicit dirty-tree policy and a rebase/merge choice (`dirtyPolicy`, `reconcile`). */
    writeRemotePolicies?: boolean;
    /** Push accepts an explicit force-with-lease with the expected remote object ID. */
    writeRemoteForceWithLease?: boolean;
    /** The daemon can put the working tree's changes aside (`scm.stash.create`). */
    writeStashCreate?: boolean;
    writePullRequestCheckout?: boolean;
    writePullRequestPrepareWorktree?: boolean;
    writePullRequestRunStacked?: boolean;
    defaultBranchPushPolicy?: 'allow' | 'requires-feature-branch' | 'deny';
    writeRepositoryInit?: boolean;
    readHostingRepositoryPublishTargets?: boolean;
    writeHostingRepositoryPublish?: boolean;
    writeRepositoryRemoveIndexLock?: boolean;
    readStash?: boolean;
    writeStash?: boolean;
    worktreeCreate: boolean;
    changeSetModel?: 'index' | 'working-copy';
    supportedDiffAreas?: Array<'included' | 'pending' | 'both'>;
    operationLabels?: {
        commit?: string;
        include?: string;
        exclude?: string;
        backout?: string;
        fetch?: string;
        pull?: string;
        push?: string;
    };
}

export interface ScmRemoteInfo {
    name: string;
    fetchUrl?: string;
    pushUrl?: string;
}

export type ScmOperationState = ProtocolScmOperationState;

export interface ScmWorkingEntry {
    path: string;
    previousPath: string | null;
    kind: ScmEntryKind;
    includeStatus: string;
    pendingStatus: string;
    hasIncludedDelta: boolean;
    hasPendingDelta: boolean;
    stats: ScmPathStats;
}

export interface ScmWorkingSnapshot {
    projectKey: string;
    fetchedAt: number;
    repo: {
        isRepo: boolean;
        rootPath: string | null;
        backendId?: ScmBackendId | null;
        mode?: '.git' | '.sl' | null;
        defaultBranch?: string | null;
        worktrees?: Array<{
            id?: string;
            path: string;
            branch: string | null;
            isCurrent: boolean;
            isMain?: boolean;
            isPrunable?: boolean;
            changeCount?: number;
            lastActivityAt?: number;
        }>;
        remotes?: ScmRemoteInfo[];
    };
    capabilities?: ScmCapabilities;
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
    hostingProvider?: ScmHostingProviderRef | null;
    pullRequestStatus?: ScmPullRequestStatusProjection | null;
    hasConflicts: boolean;
    entries: ScmWorkingEntry[];
    totals: {
        isComplete?: boolean;
        includedFiles: number;
        pendingFiles: number;
        untrackedFiles: number;
        includedAdded: number;
        includedRemoved: number;
        pendingAdded: number;
        pendingRemoved: number;
    };
}
