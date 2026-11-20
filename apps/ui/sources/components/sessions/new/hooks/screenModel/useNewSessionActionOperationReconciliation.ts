import * as React from 'react';
import type { ActionOperationFailureV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import {
    readActionOperationDestinationServerId,
    readActionOperationDestinationSessionId,
    readActionOperationSessionSpawnNewInitialInput,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { createNewSessionActionOperationOrigin } from '@/components/sessions/new/navigation/newSessionActionOperationOrigin';
import {
    presentCreatedNewSession,
    projectAcceptedNewSessionFirstTurn,
} from '@/components/sessions/new/navigation/presentCreatedNewSession';
import {
    clearCapturedNewSessionDraftAfterLaunch,
    preserveCreatedSessionDraftAfterUnacceptedFirstTurn,
    readCapturedNewSessionFirstTurnText,
} from '@/components/sessions/new/modules/newSessionDraftLifecycle';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { buildManualSessionCreationKey, readManualSessionSpawnOperation, readManualSessionSpawnOperationDetails } from '@/sync/domains/session/spawn/manualSessionSpawnOperation';
import { qualifyActionOperationSnapshot } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR } from '@/sync/runtime/sessionMessageDeliveryErrors';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { settleSpawnAttemptCustodyFromActionOperation } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import type { SessionSpawnNewInitialInputDispositionV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import type { NewSessionLaunchApprovalNoticeState } from '@/components/sessions/new/components/NewSessionLaunchApprovalNotice';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { persistCreatedSessionAuthoringOrigin } from '@/components/sessions/new/modules/newSessionAuthoringOrigin';
import { readSpawnAttemptCustodyState } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import { sync } from '@/sync/sync';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type NewSessionReentryRouter = Readonly<{
    replace(path: unknown, options?: unknown): void;
}>;

export type NewSessionLaunchApproval = Readonly<{
    /** The launch waiting on an approval, or null. */
    pending: Readonly<{ artifactId: string; serverId: string }> | null;
    notice: NewSessionLaunchApprovalNoticeState | null;
    /** The launch's front door deferred to an approval; this owner waits on it and settles the launch. */
    request: (approval: ActionApprovalContinuation) => void;
}>;

/**
 * A durable Action operation rejoined without its mounted creation completion: consume the
 * submitted draft on success, then present the Session and retire launch custody.
 * False when presentation was abandoned because the surface went away.
 */
async function settleCreatedNewSessionLaunch(input: Readonly<{
    sessionId: string;
    destinationServerId: string;
    draftScope: ServerAccountScope;
    draftId: string;
    requestId: string;
    initialInputLocalId: string | null;
    capturedFirstTurnText: string | null;
    router: NewSessionReentryRouter;
    isStillActive: () => boolean;
    operation?: QualifiedActionOperation;
    disableDraftPersistence: () => void;
}>): Promise<boolean> {
    const { sessionId, destinationServerId, draftScope, requestId, initialInputLocalId, capturedFirstTurnText } = input;
    const draft = readNewSessionDraftFromRepository({ scope: draftScope, draftId: input.draftId });
    const sourceOriginAccount = draft?.authoringOrigin ? await captureLazyActionAccountContext(draftScope.serverId) : null;
    const isStillActive = () => input.isStillActive() && sourceOriginAccount?.accountLifetime.isCurrent() !== false;
    try {
        if (!isStillActive()) return false;
        if (draft?.authoringOrigin) {
            sourceOriginAccount?.assertCurrent();
            if (draft.authoringOrigin.accountId !== draftScope.accountId || sourceOriginAccount?.accountId !== draftScope.accountId) throw Object.assign(new Error('Authoring origin Account retired'), {
                code: 'authoring_origin_scope_changed', phase: 'authoring_origin',
            });
            const custodyState = readSpawnAttemptCustodyState({ serverId: destinationServerId,
                accountId: input.operation?.snapshot.scope.accountId ?? draftScope.accountId });
            const matching = custodyState.status === 'valid' ? Object.values(custodyState.attempts).filter(
                attempt => attempt.userAttemptId === requestId && attempt.machineId === input.operation?.snapshot.scope.machineId,
            ) : [];
            await persistCreatedSessionAuthoringOrigin({ sessionId, serverId: destinationServerId,
                origin: draft.authoringOrigin,
                originPersistence: (matching.length === 1 ? matching[0]?.authoringOriginPersistence : undefined) ?? 'unknown',
                shouldContinue: isStillActive, updateSessionMetadataWithRetry: sync.patchSessionMetadataWithRetry,
            });
        }
        if (!isStillActive()) return false;
        const destinationAccountId = input.operation?.snapshot.scope.accountId ?? draftScope.accountId;
        if (capturedFirstTurnText && !initialInputLocalId) {
            preserveCreatedSessionDraftAfterUnacceptedFirstTurn({
                scope: { serverId: destinationServerId, accountId: destinationAccountId },
                sessionId,
                draftText: capturedFirstTurnText,
            });
        }
        input.disableDraftPersistence();
        await clearCapturedNewSessionDraftAfterLaunch({
            scope: draftScope,
            draftId: input.draftId,
            launchUserAttemptId: requestId,
        });
        const presentation = await presentCreatedNewSession({
            sessionId,
            serverId: destinationServerId,
            accountId: destinationAccountId,
            requestId: input.operation?.snapshot.requestId ?? requestId,
            router: input.router,
            isStillActive,
            ...(input.operation ? { operation: input.operation } : {}),
            prepareDestination: capturedFirstTurnText && initialInputLocalId
                ? () => projectAcceptedNewSessionFirstTurn({
                    sessionId,
                    localId: initialInputLocalId,
                    text: capturedFirstTurnText,
                })
                : undefined,
        });
        if (presentation !== 'opened') {
            if (presentation === 'unavailable') {
                throw new Error(CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR);
            }
            return false;
        }
        if (!isStillActive()) return false;
        await settleSpawnAttemptCustodyFromActionOperation({
            scope: {
                serverId: destinationServerId,
                accountId: destinationAccountId,
            },
            userAttemptId: requestId,
            createdSessionId: sessionId,
        });
        return true;
    } finally { sourceOriginAccount?.dispose(); }
}

function readAcceptedInitialInputLocalId(initialInput: SessionSpawnNewInitialInputDispositionV1 | null | undefined): string | null {
    return initialInput?.status === 'accepted' || initialInput?.status === 'alreadyAccepted'
        ? initialInput.localId
        : null;
}

export function useNewSessionActionOperationReconciliation(params: Readonly<{
    draftId: string;
    requestId: string | null;
    draftScope: ServerAccountScope | null;
    localCreationInFlight: boolean;
    disableDraftPersistence: () => void;
    resetLaunchRequestId: (requestId: null) => void;
    onOperationFailure?: (failure: ActionOperationFailureV1) => void;
    router: NewSessionReentryRouter;
}>): Readonly<{ isCreatingFromOperation: boolean; launchApproval: NewSessionLaunchApproval }> {
    const draft = params.draftScope ? readNewSessionDraftFromRepository({ scope: params.draftScope, draftId: params.draftId }) : null;
    const executionServerId = draft?.executionTarget?.kind === 'machine' ? draft.executionTarget.target.serverId
        : draft?.targetServerId ?? params.draftScope?.serverId;
    const crossHome = Boolean(executionServerId && params.draftScope
        && !areServerProfileIdentifiersEquivalent(executionServerId, params.draftScope.serverId));
    const [targetAccount, setTargetAccount] = React.useState<LazyActionAccountContext | null>(null);
    React.useEffect(() => {
        if (!crossHome || !executionServerId || !params.requestId || params.localCreationInFlight) { setTargetAccount(null); return; }
        const cancellation = new AbortController();
        let captured: LazyActionAccountContext | null = null;
        void captureLazyActionAccountContext(executionServerId, cancellation.signal).then(account => {
            captured = account;
            if (cancellation.signal.aborted) { account.dispose(); return; }
            account.assertCurrent();
            setTargetAccount(account);
        }).catch(error => {
            if (!cancellation.signal.aborted) captureExceptionIfEnabled(error, {
                tags: { area: 'new_session', action: 'reconcile_target_account' },
            });
        });
        return () => { cancellation.abort(); captured?.dispose(); };
    }, [crossHome, executionServerId, params.draftScope?.accountId, params.draftScope?.serverId, params.requestId, params.localCreationInFlight]);
    const executionScope = crossHome ? targetAccount?.accountLifetime.isCurrent()
        && areServerProfileIdentifiersEquivalent(targetAccount.serverId, executionServerId ?? '')
        ? targetAccount.accountLifetime.scope : null : params.draftScope;
    const readOperation = () => executionScope && params.requestId
        ? readManualSessionSpawnOperation(executionScope, params.requestId)
        : null;
    const operation = React.useSyncExternalStore(actionOperationStore.subscribe, readOperation, readOperation);
    const handledTerminalOperationIdRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!params.requestId || !params.draftScope || !executionScope) return;
        for (const requestId of [params.requestId, buildManualSessionCreationKey(params.requestId)]) {
            actionOperationPresentationCoordinator.register({
                serverId: executionScope.serverId,
                accountId: executionScope.accountId,
                requestId,
                onStart: 'current',
                origin: createNewSessionActionOperationOrigin(params.draftScope, params.draftId),
            });
        }
    }, [params.draftId, params.draftScope, params.requestId, executionScope]);

    React.useEffect(() => {
        if (
            params.localCreationInFlight
            || !operation
            || operation.actionId !== 'session.spawn_new'
            || (operation.state !== 'failed' && operation.state !== 'cancelled')
            || handledTerminalOperationIdRef.current === operation.operationId
        ) {
            return;
        }
        handledTerminalOperationIdRef.current = operation.operationId;
        params.resetLaunchRequestId(null);
        if (operation.state === 'failed' && operation.error) {
            params.onOperationFailure?.(operation.error);
        }
    }, [operation, params.localCreationInFlight, params.onOperationFailure, params.resetLaunchRequestId]);

    React.useEffect(() => {
        if (
            params.localCreationInFlight
            || !params.requestId
            || !params.draftScope
            || !executionScope
            || !operation
            || operation.actionId !== 'session.spawn_new'
            || operation.state !== 'succeeded'
            || handledTerminalOperationIdRef.current === operation.operationId
        ) {
            return;
        }
        const requestId = params.requestId;
        const draftScope = params.draftScope;
        const capturedFirstTurnText = readCapturedNewSessionFirstTurnText({
            scope: draftScope,
            draftId: params.draftId,
            launchUserAttemptId: requestId,
        });
        handledTerminalOperationIdRef.current = operation.operationId;
        let cancelled = false;
        let completed = false;

        void (async () => {
            try {
                const settled = await readManualSessionSpawnOperationDetails(executionScope, operation,
                    () => !cancelled && (!crossHome || targetAccount?.accountLifetime.isCurrent() === true));
                if (!settled) return;
                const sessionId = readActionOperationDestinationSessionId(settled);
                if (!sessionId) return;
                const destinationServerId = readActionOperationDestinationServerId(settled, executionScope.serverId)
                    ?? executionScope.serverId;
                const initialInputLocalId = readAcceptedInitialInputLocalId(readActionOperationSessionSpawnNewInitialInput(settled));
                completed = await settleCreatedNewSessionLaunch({
                    sessionId,
                    destinationServerId,
                    draftScope,
                    draftId: params.draftId,
                    requestId,
                    initialInputLocalId,
                    capturedFirstTurnText,
                    router: params.router,
                    isStillActive: () => !cancelled && (!crossHome || targetAccount?.accountLifetime.isCurrent() === true),
                    operation: qualifyActionOperationSnapshot(executionScope.serverId, settled),
                    disableDraftPersistence: params.disableDraftPersistence,
                });
            } catch (error) {
                handledTerminalOperationIdRef.current = null;
                captureExceptionIfEnabled(error, {
                    tags: {
                        area: 'new_session',
                        action: 'reconcile_action_operation_success',
                    },
                    extra: {
                        operationId: operation.operationId,
                        sessionId: readActionOperationDestinationSessionId(operation),
                    },
                });
            }
        })();

        return () => {
            cancelled = true;
            if (!completed && handledTerminalOperationIdRef.current === operation.operationId) {
                handledTerminalOperationIdRef.current = null;
            }
        };
    }, [
        operation,
        params.disableDraftPersistence,
        params.draftId,
        params.draftScope,
        params.localCreationInFlight,
        params.router,
        executionScope,
        targetAccount,
        crossHome,
    ]);

    // Retain the originating creation owner's continuation. Its result resumes that same
    // attachment/first-turn completion; this projection only observes the approval and shows it.
    const appRouter = useRouter();
    const approval = useActionApprovalContinuation({
        scopeKey: `new-session-launch:${params.draftScope?.serverId ?? ''}:${params.draftScope?.accountId ?? ''}:${params.draftId}`,
        serverId: params.draftScope?.serverId ?? '',
        onExecuted: noop,
    });
    const request = approval.requestApproval;
    const pendingServerId = params.draftScope?.serverId ?? null;
    const pendingArtifactId = approval.approvalPending && approval.approvalId && pendingServerId ? approval.approvalId : null;
    const openApproval = React.useCallback(() => {
        if (!pendingArtifactId || !pendingServerId) return;
        appRouter.pushRetainingCurrent(buildApprovalHref(pendingArtifactId, pendingServerId));
    }, [appRouter, pendingArtifactId, pendingServerId]);
    const notice = React.useMemo<NewSessionLaunchApprovalNoticeState | null>(() => (
        pendingArtifactId ? { summary: approval.approvalSummary, onOpen: openApproval } : null
    ), [approval.approvalSummary, openApproval, pendingArtifactId]);
    const launchApproval = React.useMemo<NewSessionLaunchApproval>(() => ({
        pending: pendingArtifactId && pendingServerId ? { artifactId: pendingArtifactId, serverId: pendingServerId } : null,
        notice,
        request,
    }), [notice, pendingArtifactId, pendingServerId, request]);

    return {
        isCreatingFromOperation: (operation?.actionId === 'session.spawn_new'
            && (operation.state === 'accepted' || operation.state === 'running'))
            || pendingArtifactId !== null,
        launchApproval,
    };
}

function noop(): void {}
