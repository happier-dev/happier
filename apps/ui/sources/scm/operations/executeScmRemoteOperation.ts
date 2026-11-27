import { Modal } from '@/modal';
import { t } from '@/text';
import { evaluateScmOperationPreflight } from '@/scm/core/operationPolicy';
import {
    buildNonFastForwardFetchPromptDialog,
    buildRemoteOperationBusyLabel,
    buildRemoteOperationSuccessDetail,
    type RemoteOperationKind,
    type RemoteTargetDisplay,
} from '@/scm/operations/remoteFeedback';
import { inferRemoteTargetFromSnapshot, resolveForceWithLeaseTarget } from '@/scm/operations/remoteTarget';
import { getScmUserFacingError } from '@/scm/operations/userFacingErrors';
import { trackBlockedScmOperation, type ScmOperationTracker } from '@/scm/operations/reporting';
import { alertScmOperationFailure, tryShowDaemonUnavailableAlertForScmOperationFailure } from '@/scm/operations/scmDaemonUnavailableAlert';
import type { ScmCommitStrategy } from '@/scm/settings/commitStrategy';
import type { ScmPushRejectPolicy } from '@/scm/settings/preferences';
import { runScmOperationWithGitIndexLockRecovery } from '@/scm/operations/gitIndexLockRecovery';
import { isScmActionNotRun, readUiScmActionFailure } from '@/sync/ops/scm/scmActionInvocation';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
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
    failure?: ActionExecuteFailure;
}>;

type ScmRemoteOperationLockResult =
    | { started: false; message: string }
    | { started: true };

export async function executeScmRemoteOperation(input: Readonly<{
    kind: ScmRemoteOperationKind;
    repoPath: string | null;
    workspace?: WorkspaceScopeBase['workspace'];
    scmSnapshot: ScmWorkingSnapshot | null;
    scmWriteEnabled: boolean;
    scmCommitStrategy: ScmCommitStrategy;
    scmPushRejectPolicy: ScmPushRejectPolicy;
    surface: ScmOperationSurface;
    tracking?: ScmOperationTracker | null;
    setScmOperationBusy: (busy: boolean) => void;
    setScmOperationStatus: (status: string | null) => void;
    runWithOperationLock: (
        kind: ScmRemoteOperationKind,
        run: (markRunning: () => void) => Promise<void>,
    ) => Promise<ScmRemoteOperationLockResult>;
    executeRemoteOperation: (
        kind: ScmRemoteOperationKind,
        target: RemoteTargetDisplay,
        call: Readonly<{ confirmedByPerson: boolean; onDispatched: () => void }>,
    ) => Promise<ScmRemoteResponse>;
    removeIndexLock?: (
        request: ScmRepositoryRemoveIndexLockRequest,
    ) => Promise<ScmRepositoryRemoveIndexLockResponse>;
    reportOperation: (input: RemoteOperationReportInput) => void;
    refreshAfterSuccess: (kind: ScmRemoteOperationKind) => Promise<void>;
    shouldContinue?: (() => boolean) | null;
    /**
     * The person already answered this press in a dialog of their own (a pull or push choice), so the remote
     * Action's default confirmation is not asked again. Confirmation itself belongs to the Action executor.
     */
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
        workspace: input.workspace,
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

    const lockResult = await input.runWithOperationLock(input.kind, async (markRunning) => {
        let appliedOutcome: Extract<ScmOperationOutcome, { kind: 'succeeded' }> | null = null;
        // The pane is busy ("Pushing to origin/main…") once the Action reaches the Machine, not while its
        // confirmation dialog is open and never for a decline or a waiting approval. Until then the lock
        // only serializes presses (`queued`); the Action's dispatch makes it `running`.
        const showBusy = () => {
            markRunning();
            input.setScmOperationBusy(true);
            input.setScmOperationStatus(buildRemoteOperationBusyLabel(input.kind, remoteTarget, t('files.detachedHead')));
        };
        try {
            const runRemoteOperation = (confirmedByPerson: boolean) =>
                input.executeRemoteOperation(input.kind, remoteTarget, { confirmedByPerson, onDispatched: showBusy });
            // A lease push is always confirmed by the Action itself; the replay after index-lock recovery is the same press.
            let response = await runRemoteOperation(input.skipConfirmation === true && !leasePush);
            // Declined, or waiting on an approval: nothing ran and nothing failed.
            if (isScmActionNotRun(response)) return;
            if (normalizeScmOperationOutcome(response).kind === 'failed' && input.removeIndexLock) {
                response = await runScmOperationWithGitIndexLockRecovery({
                    cwd: repoPath,
                    failedResponse: response,
                    removeIndexLock: input.removeIndexLock,
                    retryOriginalOperation: () => runRemoteOperation(true),
                });
            }
            const outcome = normalizeScmOperationOutcome(response);
            if (outcome.kind !== 'succeeded') {
                const message = getScmUserFacingError({
                    ...response,
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
                    failure: readUiScmActionFailure(response) ?? undefined,
                });
                if (inlineFailures) return;
                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForScmOperationFailure({
                    failure: readUiScmActionFailure(response),
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
                    alertScmOperationFailure({ failure: readUiScmActionFailure(response), message });
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
            input.reportOperation({ operation: input.kind, status: 'failed', outcome, errorCode: outcome.errorCode, detail,
                failure: readUiScmActionFailure(error) ?? undefined });
            if (!inlineFailures) alertScmOperationFailure({ failure: readUiScmActionFailure(error), message: detail });
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
