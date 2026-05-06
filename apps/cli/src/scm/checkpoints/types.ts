import type { FileChangeEvidence, TurnChangeSet } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../types';

export type RepositoryCheckpointCapturePhase = 'message-start' | 'turn-start' | 'turn-final';

export type RepositoryCheckpointRef = Readonly<{
    scopeId: string;
    encodedScope: string;
    phase: RepositoryCheckpointCapturePhase;
    checkpointId: string;
    ref: string;
}>;

export type RepositoryCheckpointRefs = Readonly<{
    scopeId: string;
    encodedScope: string;
    messageStart?: RepositoryCheckpointRef;
    turnStart?: RepositoryCheckpointRef;
    turnFinal?: RepositoryCheckpointRef;
}>;

export type RepositoryCheckpointAvailabilityReason =
    | 'not_repo'
    | 'unsupported_scm'
    | 'missing_repo_root'
    | 'command_failed'
    | 'permission_denied'
    | 'missing_git';

export type RepositoryCheckpointTurnProjectionUnavailableReason =
    | RepositoryCheckpointAvailabilityReason
    | 'missing_source'
    | 'missing_base'
    | 'missing_final'
    | 'invalid_ref'
    | 'diff_failed'
    | 'capture_failed';

export type RepositoryCheckpointTurnProjectionStatus = 'available' | 'unavailable';

export type RepositoryCheckpointAvailability =
    | Readonly<{
        available: true;
        repoRoot: string;
        mode: '.git';
    }>
    | Readonly<{
        available: false;
        reason: RepositoryCheckpointAvailabilityReason;
        message: string;
    }>;

export type RepositoryCheckpointReceiptId =
    | 'checkpoint.captured'
    | 'checkpoint.aliased'
    | 'checkpoint.finalized'
    | 'checkpoint.diff_computed'
    | 'checkpoint.cleanup_pruned';

export type RepositoryCheckpointReceipt = Readonly<{
    id: RepositoryCheckpointReceiptId;
    ref?: string;
    commitSha?: string;
    treeSha?: string;
    phase?: RepositoryCheckpointCapturePhase;
    prunedCount?: number;
    refs?: readonly string[];
}>;

export type RepositoryCheckpointCaptureRequest = Readonly<{
    context: ScmBackendContext;
    checkpointRef: RepositoryCheckpointRef;
    message?: string;
}>;

export type RepositoryCheckpointCaptureResult =
    | Readonly<{
        success: true;
        checkpointRef: RepositoryCheckpointRef;
        commitSha: string;
        treeSha: string;
        receipts: readonly RepositoryCheckpointReceipt[];
    }>
    | Readonly<{
        success: false;
        kind: 'unavailable' | 'failed';
        reason: RepositoryCheckpointAvailabilityReason | 'capture_failed';
        error: string;
        receipts: readonly RepositoryCheckpointReceipt[];
    }>;

export type RepositoryCheckpointAliasRequest = Readonly<{
    context: ScmBackendContext;
    sourceRef: RepositoryCheckpointRef;
    targetRef: RepositoryCheckpointRef;
}>;

export type RepositoryCheckpointAliasResult =
    | Readonly<{
        success: true;
        sourceRef: RepositoryCheckpointRef;
        targetRef: RepositoryCheckpointRef;
        commitSha: string;
        receipts: readonly RepositoryCheckpointReceipt[];
    }>
    | Readonly<{
        success: false;
        kind: 'unavailable' | 'failed';
        reason: RepositoryCheckpointTurnProjectionUnavailableReason;
        error: string;
        receipts: readonly RepositoryCheckpointReceipt[];
    }>;

export type RepositoryCheckpointDiffBaseRefSource =
    | 'turn_start'
    | 'message_start'
    | 'previous_final'
    | 'unavailable';

export type RepositoryCheckpointAttributionScope =
    | 'exclusive_worktree'
    | 'shared_worktree'
    | 'unknown';

export type RepositoryCheckpointDiffRequest = Readonly<{
    context: ScmBackendContext;
    baseRef: RepositoryCheckpointRef;
    finalRef: RepositoryCheckpointRef;
    baseRefSource: Exclude<RepositoryCheckpointDiffBaseRefSource, 'unavailable'>;
    attributionScope: RepositoryCheckpointAttributionScope;
}>;

export type RepositoryCheckpointDiffResult =
    | Readonly<{
        success: true;
        baseRef: RepositoryCheckpointRef;
        finalRef: RepositoryCheckpointRef;
        baseRefSource: Exclude<RepositoryCheckpointDiffBaseRefSource, 'unavailable'>;
        contentConfidence: 'exact';
        attributionScope: RepositoryCheckpointAttributionScope;
        files: readonly FileChangeEvidence[];
        receipts: readonly RepositoryCheckpointReceipt[];
    }>
    | Readonly<{
        success: false;
        kind: 'unavailable' | 'failed';
        reason: RepositoryCheckpointTurnProjectionUnavailableReason;
        error: string;
        baseRefSource: RepositoryCheckpointDiffBaseRefSource;
        contentConfidence: 'unavailable';
        attributionScope: RepositoryCheckpointAttributionScope;
        receipts: readonly RepositoryCheckpointReceipt[];
    }>;

export type RepositoryCheckpointTurnProjection = Readonly<{
    status: RepositoryCheckpointTurnProjectionStatus;
    turnChangeSet: TurnChangeSet;
}>;

export type RepositoryCheckpointListedRef = Readonly<{
    ref: string;
    committedAtMs: number | null;
}>;

export type RepositoryCheckpointCleanupRequest = Readonly<{
    scopeId: string;
    refs: readonly RepositoryCheckpointListedRef[];
    nowMs?: number;
    maxAgeMs?: number;
    maxFinalizedTurns?: number;
    deleteRef: (ref: string) => Promise<void>;
}>;

export type RepositoryCheckpointCleanupResult =
    | Readonly<{
        success: true;
        prunedCount: number;
        prunedRefs: readonly string[];
        receipts: readonly RepositoryCheckpointReceipt[];
    }>
    | Readonly<{
        success: false;
        prunedCount: number;
        prunedRefs: readonly string[];
        error: string;
        receipts: readonly RepositoryCheckpointReceipt[];
    }>;
