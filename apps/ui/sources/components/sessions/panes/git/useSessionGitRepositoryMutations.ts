import * as React from 'react';
import type { ScmOperationState } from '@happier-dev/protocol';

type ScmRepositoryOperationKind = ScmOperationState['kind'];

import { runSessionScmMutation, type ScmMutationResponse } from '@/scm/operations/runSessionScmMutation';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { storage } from '@/sync/domains/state/storage';
import {
    sessionScmBranchMerge,
    sessionScmBranchOperationAbort,
    sessionScmBranchOperationContinue,
    sessionScmBranchOperationSkip,
    sessionScmBranchRebase,
    sessionScmCommitUndoLast,
    sessionScmRemoteAdd,
    sessionScmRemoteRemove,
    sessionScmRemoteSetUrl,
} from '@/sync/ops/sessions';
import type { ScmProjectOperationKind } from '@/sync/runtime/orchestration/projectManager';
import { t } from '@/text';

/**
 * The session's repository-level writes (remotes, merge/rebase and their continue/abort), each through the one
 * project operation lock and log (the shared `runSessionScmMutation` executor), so the Git pane's outcome line reports
 * them like every other write.
 */
export function useSessionGitRepositoryMutations(input: Readonly<{
    sessionId: string;
    serverId?: string;
    sessionPath: string | null;
    refreshAfterUndo?: () => Promise<void>;
}>) {
    const { sessionId, serverId, sessionPath } = input;
    const refresh = React.useCallback(async () => {
        await scmStatusSync.invalidateFromMutationAndAwait(sessionId, serverId);
    }, [serverId, sessionId]);
    const run = React.useCallback(async <T extends ScmMutationResponse>(mutation: {
        operation: ScmProjectOperationKind;
        fallbackError: string;
        call: () => Promise<T>;
        refreshAfterMutation?: () => Promise<void>;
    }): Promise<ScmMutationResponse> => {
        const result = await runSessionScmMutation({
            state: storage.getState(),
            sessionId, serverId,
            operation: mutation.operation,
            cwd: sessionPath,
            run: mutation.call,
            fallbackError: mutation.fallbackError,
            refreshAfterMutation: async () => {
                await (mutation.refreshAfterMutation ?? refresh)();
                const error = storage.getState().getSessionProjectScmSnapshotError(sessionId, serverId);
                if (error) throw new Error(error.message);
            },
        });
        if (!result.started) return { success: false, error: result.message };
        return result.response === 'cancelled' ? { success: false } : result.response;
    }, [refresh, serverId, sessionId, sessionPath]);

    return React.useMemo(() => ({
        refresh,
        undoLastCommit: (expectedHeadOid: string) => run({
            operation: 'commit_undo',
            fallbackError: t('sessionGitPane.flow.undo.failed'),
            call: () => sessionScmCommitUndoLast(sessionId, { expectedHeadOid }, serverId),
            refreshAfterMutation: input.refreshAfterUndo ?? refresh,
        }),
        addRemote: (request: Parameters<typeof sessionScmRemoteAdd>[1]) => run({
            operation: 'remote_add',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.addFailed'),
            call: () => sessionScmRemoteAdd(sessionId, request, serverId),
        }),
        setRemoteUrl: (request: Parameters<typeof sessionScmRemoteSetUrl>[1]) => run({
            operation: 'remote_set_url',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.saveFailed'),
            call: () => sessionScmRemoteSetUrl(sessionId, request, serverId),
        }),
        removeRemote: (name: string) => run({
            operation: 'remote_remove',
            fallbackError: t('files.sourceControlOperations.update.remotes.errors.removeFailed'),
            call: () => sessionScmRemoteRemove(sessionId, { name }, serverId),
        }),
        mergeBranch: (sourceRef: string) => run({
            operation: 'branch_merge',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.mergeFailed'),
            call: () => sessionScmBranchMerge(sessionId, { sourceRef }, serverId),
        }),
        rebaseBranch: (sourceRef: string) => run({
            operation: 'branch_rebase',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.rebaseFailed'),
            call: () => sessionScmBranchRebase(sessionId, { sourceRef }, serverId),
        }),
        continueBranchOperation: (operation: ScmRepositoryOperationKind) => run({
            operation: 'branch_operation_continue',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed'),
            call: () => sessionScmBranchOperationContinue(sessionId, { operation }, serverId),
        }),
        skipBranchOperation: (operation: ScmRepositoryOperationKind) => run({
            operation: 'branch_operation_skip',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.continueFailed'),
            call: () => sessionScmBranchOperationSkip(sessionId, { operation }, serverId),
        }),
        abortBranchOperation: (operation: ScmRepositoryOperationKind) => run({
            operation: 'branch_operation_abort',
            fallbackError: t('files.sourceControlOperations.update.branchIntegration.errors.abortFailed'),
            call: () => sessionScmBranchOperationAbort(sessionId, { operation }, serverId),
        }),
    }), [input.refreshAfterUndo, refresh, run, serverId, sessionId]);
}
