import * as React from 'react';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePush,
    sessionScmRepositoryRemoveIndexLock,
} from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import { executeScmRemoteOperation, type ScmRemoteOperationKind } from '@/scm/operations/executeScmRemoteOperation';
import { withSessionProjectScmOperationLock } from '@/scm/operations/withOperationLock';
import { reportSessionScmOperation } from '@/scm/operations/reporting';
import { tracking } from '@/track';
import { useMountedRef } from '@/hooks/ui/useMountedRef';

export type RunScmRemoteOperationOptions = Readonly<{
    skipConfirmation?: boolean;
}>;

const SCM_REMOTE_POST_OPERATION_REFRESH_TIMEOUT_MS = 5_000;

async function awaitScmRemotePostOperationRefresh(refresh: () => Promise<void>): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const refreshPromise = refresh();

    try {
        await Promise.race([
            refreshPromise,
            new Promise<void>((resolve) => {
                timeoutId = setTimeout(() => {
                    timedOut = true;
                    resolve();
                }, SCM_REMOTE_POST_OPERATION_REFRESH_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }

    if (timedOut) {
        void refreshPromise.catch(() => {});
    }
}

export function useScmRemoteOperations(input: {
    sessionId: string;
    sessionPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmRemoteConfirmPolicy: ScmRemoteConfirmPolicy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    refreshScmData: () => Promise<void>;
    loadCommitHistory: (opts?: { reset?: boolean }) => Promise<void>;
    surface?: 'files' | 'update';
}) {
    const {
        sessionId,
        sessionPath,
        scmSnapshot,
        scmWriteEnabled,
        scmCommitStrategy,
        scmRemoteConfirmPolicy,
        scmPushRejectPolicy,
        refreshScmData,
        loadCommitHistory,
        surface = 'update',
    } = input;
    const [scmRemoteOperationBusy, setScmRemoteOperationBusy] = React.useState(false);
    const [scmRemoteOperationStatus, setScmRemoteOperationStatus] = React.useState<string | null>(null);
    const mountedRef = useMountedRef();

    const setScmRemoteOperationBusySafe = React.useCallback((value: boolean) => {
        if (!mountedRef.current) return;
        setScmRemoteOperationBusy(value);
    }, [mountedRef]);
    const setScmRemoteOperationStatusSafe = React.useCallback((value: string | null) => {
        if (!mountedRef.current) return;
        setScmRemoteOperationStatus(value);
    }, [mountedRef]);

    const pullPreflight = React.useMemo(
        () =>
            evaluateScmOperationPreflight({
                intent: 'pull',
                scmWriteEnabled,
                sessionPath,
                snapshot: scmSnapshot,
                commitStrategy: scmCommitStrategy,
            }),
        [scmCommitStrategy, scmSnapshot, scmWriteEnabled, sessionPath],
    );
    const pushPreflight = React.useMemo(
        () =>
            evaluateScmOperationPreflight({
                intent: 'push',
                scmWriteEnabled,
                sessionPath,
                snapshot: scmSnapshot,
                commitStrategy: scmCommitStrategy,
            }),
        [scmCommitStrategy, scmSnapshot, scmWriteEnabled, sessionPath],
    );

    const runRemoteOperation = React.useCallback(async (
        kind: ScmRemoteOperationKind,
        options?: RunScmRemoteOperationOptions,
    ) => {
        await executeScmRemoteOperation({
            kind,
            repoPath: sessionPath,
            scmSnapshot,
            scmWriteEnabled,
            scmCommitStrategy,
            scmRemoteConfirmPolicy,
            scmPushRejectPolicy,
            surface,
            tracking,
            setScmOperationBusy: setScmRemoteOperationBusySafe,
            setScmOperationStatus: setScmRemoteOperationStatusSafe,
            runWithOperationLock: async (operation, run) => {
                const lockResult = await withSessionProjectScmOperationLock({
                    state: storage.getState(),
                    sessionId,
                    operation,
                    run,
                });
                return lockResult.started ? { started: true } : lockResult;
            },
            executeRemoteOperation: async (operation, remoteTarget) => {
                return operation === 'fetch'
                    ? await sessionScmRemoteFetch(sessionId, { remote: remoteTarget.remote })
                    : operation === 'pull'
                        ? await sessionScmRemotePull(sessionId, {
                            remote: remoteTarget.remote,
                            branch: remoteTarget.branch ?? undefined,
                        })
                        : await sessionScmRemotePush(sessionId, {
                            remote: remoteTarget.remote,
                            branch: remoteTarget.branch ?? undefined,
                        });
            },
            removeIndexLock: (request) => sessionScmRepositoryRemoveIndexLock(sessionId, request),
            reportOperation: ({ operation, status, detail, rawError, errorCode }) => {
                reportSessionScmOperation({
                    state: storage.getState(),
                    sessionId,
                    operation,
                    status,
                    detail,
                    rawError,
                    errorCode,
                    surface,
                    tracking,
                });
            },
            refreshAfterSuccess: async (operation) => {
                if (operation === 'pull' || operation === 'push') {
                    await awaitScmRemotePostOperationRefresh(async () => {
                        await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                        if (mountedRef.current) {
                            await loadCommitHistory({ reset: true });
                        }
                    });
                    return;
                }
                if (mountedRef.current) {
                    await awaitScmRemotePostOperationRefresh(refreshScmData);
                }
            },
            shouldContinue: () => mountedRef.current,
            skipConfirmation: options?.skipConfirmation,
        });
    }, [
        loadCommitHistory,
        mountedRef,
        refreshScmData,
        scmCommitStrategy,
        scmPushRejectPolicy,
        scmRemoteConfirmPolicy,
        scmSnapshot,
        scmWriteEnabled,
        sessionId,
        sessionPath,
        surface,
    ]);

    return {
        scmRemoteOperationBusy,
        scmRemoteOperationStatus,
        pullPreflight,
        pushPreflight,
        runRemoteOperation,
    };
}
