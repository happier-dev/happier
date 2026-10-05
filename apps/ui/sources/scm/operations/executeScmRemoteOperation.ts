import { Modal } from '@/modal';
import { t } from '@/text';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteConfirmDialog,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
    type RemoteOperationKind,
    type RemoteTargetDisplay,
} from '@/scm/operations/remoteFeedback';
import { inferRemoteTargetFromSnapshot, resolveForceWithLeaseTarget } from '@/scm/operations/remoteTarget';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { trackBlockedScmOperation, type ScmOperationTracker } from '@/scm/operations/reporting';
import { tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy, ScmRemoteConfirmPolicy } from '@/scm/settings/preferences';
import { shouldConfirmRemoteOperation } from '@/scm/settings/remoteConfirmationPolicy';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    SCM_OPERATION_ERROR_CODES,
    type ScmOperationErrorCode,
    type ScmRemoteResponse,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
    normalizeScmOperationOutcome,
    createScmOperationUnknownOutcome,
    type ScmOperationOutcome,
    type ScmRemotePolicy,
    admitScmRemotePolicy,
} from '@happier-dev/protocol/scm';

export type ScmRemoteOperationKind = RemoteOperationKind;

type ScmOperationSurface = 'files' | 'file' | 'commit' | 'update';

type RemoteOperationReportInput = Readonly<{
    operation: ScmRemoteOperationKind;
    status: 'failed' | 'success';
    detail: string;
    rawError?: string;
    errorCode?: ScmOperationErrorCode;
    outcome?: ScmOperationOutcome;
}>;

type ScmRemoteOperationLockResult =
    | { started: false; message: string }
    | { started: true };

export async function executeScmRemoteOperation(input: Readonly<{
    kind: ScmRemoteOperationKind;
    repoPath: string | null;
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmRemoteConfirmPolicy: ScmRemoteConfirmPolicy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    surface: ScmOperationSurface;
    tracking?: ScmOperationTracker | null;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    runWithOperationLock: (
        kind: ScmRemoteOperationKind,
        run: () => Promise<void>,
    ) => Promise<ScmRemoteOperationLockResult>;
    executeRemoteOperation: (
        kind: ScmRemoteOperationKind,
        target: RemoteTargetDisplay,
    ) => Promise<ScmRemoteResponse>;
    removeIndexLock?: (
        request: ScmRepositoryRemoveIndexLockRequest,
    ) => Promise<ScmRepositoryRemoveIndexLockResponse>;
    reportOperation: (input: RemoteOperationReportInput) => void;
    refreshAfterSuccess: (kind: ScmRemoteOperationKind) => Promise<void>;
    shouldContinue?: (() => boolean) | null;
    skipConfirmation?: boolean;
    retrySkipConfirmation?: boolean;
    policy?: ScmRemotePolicy;
    /** The person explicitly chose pull-then-push; a confirmed pull and refresh must finish first. */
    pushAfterPull?: boolean;
    /** Read the canonical refreshed project snapshot before admitting a following push. */
    readSnapshotAfterSuccess?: () => ScmWorkingSnapshot | null;
    /**
     * Where a failure is shown. `outcomeLine`: the surface renders the operation log's terminal result inline
     * (the session Git pane), so no modal is raised and a rejected push is not followed by a fetch prompt (the
     * inline failure offers Fetch). `alert` (default): surfaces without an outcome line.
     */
    failureFeedback?: 'alert' | 'outcomeLine';
}>): Promise<void> {
    const inlineFailures = input.failureFeedback === 'outcomeLine';
    const leasePush = input.policy?.pushMode === 'force_with_lease';
    const leaseTarget = leasePush ? resolveForceWithLeaseTarget(input.scmSnapshot) : null;
    const admission = admitScmRemotePolicy(input.policy ?? {}, input.scmSnapshot?.capabilities);
    if (!admission.success || (leasePush && (input.kind !== 'push' || !leaseTarget || leaseTarget.expectedRemoteOid !== input.policy?.expectedRemoteOid))) {
        const outcome: ScmOperationOutcome = !admission.success ? admission.outcome : {
            v: 1, kind: 'needs_input', errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            nextActions: [{ kind: 'refresh' }], message: t('sessionGitPane.flow.lease.fetchFirst'),
        };
        input.reportOperation({ operation: input.kind, status: 'failed', detail: outcome.message ?? '', errorCode: 'errorCode' in outcome ? outcome.errorCode : undefined, outcome });
        return;
    }
    const preflight = evaluateScmOperationPreflight({
        intent: input.kind,
        scmWriteEnabled: input.scmWriteEnabled,
        sessionPath: input.repoPath,
        snapshot: input.scmSnapshot,
        commitStrategy: input.scmCommitStrategy,
        remotePolicy: input.policy,
    });
    if (!preflight.allowed) {
        trackBlockedScmOperation({
            operation: input.kind,
            reason: 'preflight',
            message: preflight.message,
            surface: input.surface,
            tracking: input.tracking,
        });
        Modal.alert(t('common.error'), preflight.message);
        return;
    }
    if (!input.repoPath) return;
    const repoPath = input.repoPath;

    const remoteTarget = leaseTarget ?? inferRemoteTargetFromSnapshot(input.scmSnapshot);
    let shouldOfferFetchAfterPushReject = false;
    let pullRefreshed = false;
    const isPullOrPush = input.kind === 'pull' || input.kind === 'push';
    const shouldConfirmRemote = input.skipConfirmation === true
        ? false
        : shouldConfirmRemoteOperation(input.scmRemoteConfirmPolicy, input.kind);

    if (isPullOrPush && (leasePush || shouldConfirmRemote)) {
        const dialog = leaseTarget ? {
            title: t('sessionGitPane.flow.lease.confirmTitle'),
            body: t('sessionGitPane.flow.lease.confirmBody', { target: `${remoteTarget.remote}/${remoteTarget.branch}`, oid: leaseTarget.expectedRemoteOid.slice(0, 7) }),
            confirmText: t('sessionGitPane.flow.lease.push'),
            cancelText: t('common.cancel'),
        } : buildRemoteConfirmDialog({
            kind: input.kind,
            target: remoteTarget,
            detachedHeadLabel: t('files.detachedHead'),
        });
        const confirmed = await Modal.confirm(
            dialog.title,
            dialog.body,
            { confirmText: dialog.confirmText, cancelText: dialog.cancelText, ...(leasePush ? { destructive: true } : {}) },
        );
        if (!confirmed) return;
    }

    const lockResult = await input.runWithOperationLock(input.kind, async () => {
        let appliedOutcome: Extract<ScmOperationOutcome, { kind: 'succeeded' }> | null = null;
        input.setScmOperationBusy(true);
        input.setScmOperationStatus(buildRemoteOperationBusyLabel(input.kind, remoteTarget, t('files.detachedHead')));
        try {
            const runRemoteOperation = () => input.executeRemoteOperation(input.kind, remoteTarget);
            let response = await runRemoteOperation();
            if (normalizeScmOperationOutcome(response).kind === 'failed' && input.removeIndexLock) {
                response = await runScmOperationWithGitIndexLockRecovery({
                    cwd: repoPath,
                    failedResponse: response,
                    removeIndexLock: input.removeIndexLock,
                    retryOriginalOperation: runRemoteOperation,
                });
            }
            const outcome = normalizeScmOperationOutcome(response);
            if (outcome.kind !== 'succeeded') {
                const message = getScmUserFacingError({
                    errorCode: response.errorCode,
                    error: response.error,
                    fallback: response.error || `Failed to ${input.kind}`,
                });
                if (
                    input.kind === 'push'
                    && response.errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD
                ) {
                    shouldOfferFetchAfterPushReject = !leasePush;
                }
                input.reportOperation({
                    operation: input.kind,
                    status: 'failed',
                    outcome,
                    detail: message,
                    rawError: response.error,
                    errorCode: response.errorCode,
                });
                if (inlineFailures) return;
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    errorCode: response.errorCode,
                    onRetry: () => {
                        void executeScmRemoteOperation({
                            ...input,
                            skipConfirmation: input.retrySkipConfirmation,
                            kind: input.kind,
                        });
                    },
                    shouldContinue: input.shouldContinue ?? null,
                });
                if (!shownDaemonUnavailable) {
                    Modal.alert(t('common.error'), message);
                }
                return;
            }

            appliedOutcome = { ...outcome, effect: outcome.effect ?? { kind: 'remote', remote: remoteTarget.remote, ...(remoteTarget.branch ? { branch: remoteTarget.branch } : {}) } };
            input.reportOperation({
                operation: input.kind,
                status: 'success',
                outcome: appliedOutcome,
                detail: buildRemoteOperationSuccessDetail(
                    input.kind,
                    remoteTarget,
                    response.stdout ?? '',
                    t('files.detachedHead'),
                ),
            });
            input.setScmOperationStatus('Refreshing repository status…');
            await input.refreshAfterSuccess(input.kind);
            pullRefreshed = input.kind === 'pull';
        } catch (error) {
            const outcome: ScmOperationOutcome = appliedOutcome ? {
                v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED,
                effect: appliedOutcome.effect ?? { kind: 'remote', remote: remoteTarget.remote, ...(remoteTarget.branch ? { branch: remoteTarget.branch } : {}) },
                nextActions: [{ kind: 'refresh' }],
            } : createScmOperationUnknownOutcome({ kind: 'remote_ref', remote: remoteTarget.remote, ...(remoteTarget.branch ? { branch: remoteTarget.branch } : {}) });
            const detail = getScmUserFacingError({ error: error instanceof Error ? error.message : String(error ?? ''), fallback: `Failed to ${input.kind}` });
            input.reportOperation({ operation: input.kind, status: 'failed', outcome, errorCode: outcome.errorCode, detail });
            if (!inlineFailures) Modal.alert(t('common.error'), detail);
        } finally {
            input.setScmOperationBusy(false);
            input.setScmOperationStatus(null);
        }
    });

    if (!lockResult.started) {
        trackBlockedScmOperation({
            operation: input.kind,
            reason: 'lock',
            message: lockResult.message,
            surface: input.surface,
            tracking: input.tracking,
        });
        Modal.alert(t('common.error'), lockResult.message);
        return;
    }

    if (input.pushAfterPull && input.kind === 'pull' && pullRefreshed && input.shouldContinue?.() !== false) {
        // Pull's dirty/reconciliation choice does not become a push policy. This is still an ordinary
        // push, never force, and it takes the same canonical lock/preflight/RPC/report path.
        const snapshot = input.readSnapshotAfterSuccess?.() ?? null;
        const refreshedTarget = inferRemoteTargetFromSnapshot(snapshot);
        if (snapshot && (snapshot.branch.head !== input.scmSnapshot?.branch.head || refreshedTarget.remote !== remoteTarget.remote || refreshedTarget.branch !== remoteTarget.branch)) {
            input.reportOperation({ operation: 'push', status: 'failed', detail: t('sessionGitPane.fidelity.branchChanged'), outcome: {
                v: 1, kind: 'needs_input', errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, nextActions: [{ kind: 'refresh' }],
            } });
            return;
        }
        await executeScmRemoteOperation({ ...input, scmSnapshot: snapshot, kind: 'push', policy: undefined, pushAfterPull: false, skipConfirmation: true });
        return;
    }

    if (shouldOfferFetchAfterPushReject && input.scmPushRejectPolicy === 'auto_fetch') {
        await executeScmRemoteOperation({ ...input, kind: 'fetch' });
        return;
    }

    if (shouldOfferFetchAfterPushReject && input.scmPushRejectPolicy === 'prompt_fetch' && !inlineFailures) {
        const fetchDialog = buildNonFastForwardFetchPromptDialog({
            target: remoteTarget,
            detachedHeadLabel: t('files.detachedHead'),
        });
        const confirmed = await Modal.confirm(
            fetchDialog.title,
            fetchDialog.body,
            { confirmText: fetchDialog.confirmText, cancelText: fetchDialog.cancelText },
        );
        if (confirmed) {
            await executeScmRemoteOperation({ ...input, kind: 'fetch' });
        }
    }
}
