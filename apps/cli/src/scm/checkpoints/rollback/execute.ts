import type { CheckpointCodeRollbackResult } from '@happier-dev/protocol';

import { CHECKPOINT_ROLLBACK_RECEIPT_IDS } from './receipts';
import type { CheckpointRollbackOrchestrationDependencies, CheckpointCodeRollbackRequest } from './types';
import { planCheckpointCodeRollback } from './plan';

function uniqueReceipts(
    receipts: readonly CheckpointCodeRollbackResult['receipts'][number][],
): readonly CheckpointCodeRollbackResult['receipts'][number][] {
    return [...new Set(receipts)];
}

export async function executeCheckpointCodeRollback(input: Readonly<{
    request: CheckpointCodeRollbackRequest;
    conversationRollbackSupported: boolean;
    deps: CheckpointRollbackOrchestrationDependencies;
}>): Promise<CheckpointCodeRollbackResult> {
    const plan = planCheckpointCodeRollback({
        request: input.request,
        conversationRollbackSupported: input.conversationRollbackSupported,
    });
    if (plan.status !== 'ready') {
        return {
            status: plan.status,
            changedPaths: [],
            skippedPaths: [],
            receipts: plan.receipts,
            diagnostics: plan.diagnostics,
        };
    }

    if (!plan.requiresCodeRollback) {
        return {
            status: 'conversation_only',
            changedPaths: [],
            skippedPaths: [],
            receipts: [],
            diagnostics: [],
        };
    }

    const adapterContext = {
        request: input.request,
        sessionId: input.request.sessionId,
        turnId: input.request.turnId,
        cwd: input.request.cwd,
        expectedStartRef: input.request.expectedStartRef,
        expectedFinalRef: input.request.expectedFinalRef,
        codeMode: input.request.codeMode,
        backupMode: input.request.backupMode,
    } as const;

    const backup = await input.deps.captureBackup(adapterContext);
    if (!backup.success) {
        return {
            status: 'unavailable',
            changedPaths: [],
            skippedPaths: [],
            receipts: uniqueReceipts([...(backup.receipts ?? []), CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted]),
            diagnostics: backup.diagnostics,
        };
    }

    let gitStashRef: string | undefined;
    if (plan.requiresGitStash) {
        const stash = input.deps.createStash
            ? await input.deps.createStash(adapterContext)
            : { success: false as const, diagnostics: ['git_stash_unavailable'] };
        if (!stash.success) {
            return {
                status: 'aborted',
                backupCheckpointRef: backup.backupCheckpointRef,
                changedPaths: [],
                skippedPaths: [],
                receipts: uniqueReceipts([...backup.receipts, CHECKPOINT_ROLLBACK_RECEIPT_IDS.aborted]),
                diagnostics: stash.diagnostics,
            };
        }
        gitStashRef = stash.gitStashRef;
    }

    const applied = await input.deps.applyReversePatch({ ...adapterContext, backupCaptured: true });
    return {
        status: applied.status,
        backupCheckpointRef: backup.backupCheckpointRef,
        ...(gitStashRef ? { gitStashRef } : {}),
        changedPaths: applied.changedPaths,
        skippedPaths: applied.skippedPaths,
        receipts: uniqueReceipts([...backup.receipts, ...applied.receipts]),
        diagnostics: applied.diagnostics,
    };
}
