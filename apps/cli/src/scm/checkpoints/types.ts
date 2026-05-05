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
