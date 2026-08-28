import * as React from 'react';

import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import {
    readActionOperationDestinationServerId,
    readActionOperationDestinationSessionId,
} from '@/components/inbox/actionOperations/actionOperationPresentation';
import { createNewSessionActionOperationOrigin } from '@/components/sessions/new/navigation/newSessionActionOperationOrigin';
import { clearCapturedNewSessionDraftAfterLaunch } from '@/components/sessions/new/modules/newSessionDraftLifecycle';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useActionOperationByRequestId } from '@/sync/domains/actionOperations/useActionOperations';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { requireLocalSessionVisibleForRoute } from '@/sync/runtime/orchestration/serverScopedRpc/localSessionRouteReadiness';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { settleSpawnAttemptCustodyFromActionOperation } from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

type NewSessionReentryRouter = Readonly<{
    replace(path: unknown, options?: unknown): void;
}>;

export function useNewSessionActionOperationReconciliation(params: Readonly<{
    draftId: string;
    requestId: string | null;
    draftScope: ServerAccountScope | null;
    localCreationInFlight: boolean;
    disableDraftPersistence: () => void;
    resetLaunchRequestId: (requestId: null) => void;
    router: NewSessionReentryRouter;
}>): Readonly<{ isCreatingFromOperation: boolean }> {
    const operation = useActionOperationByRequestId(
        params.draftScope ? params.requestId : null,
        params.draftScope?.accountId ?? null,
    );
    const handledTerminalOperationIdRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!params.requestId || !params.draftScope) return;
        actionOperationPresentationCoordinator.register({
            requestId: params.requestId,
            onStart: 'current',
            origin: createNewSessionActionOperationOrigin(params.draftScope, params.draftId),
        });
    }, [params.draftId, params.draftScope, params.requestId]);

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
    }, [operation, params.localCreationInFlight, params.resetLaunchRequestId]);

    React.useEffect(() => {
        if (
            params.localCreationInFlight
            || !params.requestId
            || !params.draftScope
            || !operation
            || operation.actionId !== 'session.spawn_new'
            || operation.state !== 'succeeded'
            || handledTerminalOperationIdRef.current === operation.operationId
        ) {
            return;
        }
        const sessionId = readActionOperationDestinationSessionId(operation);
        if (!sessionId) return;
        const requestId = params.requestId;
        const draftScope = params.draftScope;
        const destinationServerId = readActionOperationDestinationServerId(operation) ?? draftScope.serverId;
        handledTerminalOperationIdRef.current = operation.operationId;
        let cancelled = false;
        let completed = false;

        void (async () => {
            try {
                await requireLocalSessionVisibleForRoute({
                    sessionId,
                    serverId: destinationServerId,
                    getStoredSession: (candidateSessionId) => storage.getState().sessions[candidateSessionId] ?? null,
                    ensureSessionVisibleForMessageRoute: sync.ensureSessionVisibleForMessageRoute,
                });
                if (cancelled) return;
                params.disableDraftPersistence();
                await clearCapturedNewSessionDraftAfterLaunch({
                    scope: draftScope,
                    draftId: params.draftId,
                    launchUserAttemptId: requestId,
                });
                params.router.replace(buildScopedSessionRouteHref({
                    sessionId,
                    serverId: destinationServerId,
                }), {
                    dangerouslySingular() {
                        return 'session';
                    },
                });
                actionOperationPresentationCoordinator.acknowledgeRequestPresented(requestId, operation);
                await settleSpawnAttemptCustodyFromActionOperation({
                    scope: {
                        serverId: destinationServerId,
                        accountId: draftScope.accountId,
                    },
                    userAttemptId: requestId,
                    createdSessionId: sessionId,
                });
                completed = true;
            } catch (error) {
                handledTerminalOperationIdRef.current = null;
                captureExceptionIfEnabled(error, {
                    tags: {
                        area: 'new_session',
                        action: 'reconcile_action_operation_success',
                    },
                    extra: {
                        operationId: operation.operationId,
                        sessionId,
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
    ]);

    return {
        isCreatingFromOperation: operation?.actionId === 'session.spawn_new'
            && (operation.state === 'accepted' || operation.state === 'running'),
    };
}
