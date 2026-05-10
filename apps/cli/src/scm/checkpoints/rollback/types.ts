import type {
    CheckpointCodeRollbackBackupMode,
    CheckpointCodeRollbackReceiptId,
    CheckpointCodeRollbackRequest,
    SessionRollbackCodeMode,
} from '@happier-dev/protocol';

export type CheckpointRollbackPlanStatus = 'ready' | 'unavailable' | 'aborted';

export type CheckpointCodeRollbackPlan = Readonly<{
    status: CheckpointRollbackPlanStatus;
    request: CheckpointCodeRollbackRequest;
    requiresConversationRollback: boolean;
    requiresCodeRollback: boolean;
    requiresBackupCheckpoint: boolean;
    requiresGitStash: boolean;
    diagnostics: readonly string[];
    receipts: readonly CheckpointCodeRollbackReceiptId[];
}>;

export type CheckpointRollbackAdapterContext = Readonly<{
    request: CheckpointCodeRollbackRequest;
    sessionId: string;
    turnId: string;
    cwd: string;
    expectedStartRef: string;
    expectedFinalRef: string;
    codeMode: SessionRollbackCodeMode;
    backupMode: CheckpointCodeRollbackBackupMode;
}>;

export type CheckpointRollbackApplyContext = CheckpointRollbackAdapterContext & Readonly<{
    backupCaptured: boolean;
}>;

export type CheckpointRollbackOrchestrationDependencies = Readonly<{
    captureBackup: (context: CheckpointRollbackAdapterContext) => Promise<
        | { success: true; backupCheckpointRef: string; receipts: readonly CheckpointCodeRollbackReceiptId[] }
        | { success: false; diagnostics: readonly string[]; receipts?: readonly CheckpointCodeRollbackReceiptId[] }
    >;
    createStash?: (context: CheckpointRollbackAdapterContext) => Promise<
        | { success: true; gitStashRef: string; diagnostics?: readonly string[] }
        | { success: false; diagnostics: readonly string[] }
    >;
    applyReversePatch: (input: CheckpointRollbackApplyContext) => Promise<
        | {
            status: 'applied' | 'conflict' | 'unavailable' | 'aborted';
            changedPaths: readonly string[];
            skippedPaths: readonly string[];
            receipts: readonly CheckpointCodeRollbackReceiptId[];
            diagnostics: readonly string[];
        }
    >;
}>;

export type { CheckpointCodeRollbackBackupMode, CheckpointCodeRollbackReceiptId, CheckpointCodeRollbackRequest, SessionRollbackCodeMode };
