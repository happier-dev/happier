import * as React from 'react';
import { DIRECT_SESSION_TAKEOVER_ACTION_IDS, type ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { showDirectSessionTakeoverDialog } from '@/components/sessions/directSessions/takeover/showDirectSessionTakeoverDialog';
import { Modal } from '@/modal';
import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { machineDirectSessionTakeover, machineDirectSessionTakeoverPersistStart } from '@/sync/ops/machineDirectSessions';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { getActionOperation, cancelActionOperation } from '@/sync/ops/actionOperations';
import { storage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { isActionOperationCancellationRequested, selectActionOperationObservationForOperation, selectActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useActionOperations } from '@/sync/domains/actionOperations/useActionOperations';
import { reconcileActionOperationsOnce } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { randomUUID } from '@/platform/randomUUID';
import { hasDerivedRetainedSessionLink } from '@/sync/domains/session/directSessions/retainedSessionLink';
import { storeRetainedSessionLink } from '@/sync/ops/storeRetainedSessionLink';
import { sync } from '@/sync/sync';
import { t } from '@/text';

type DirectTakeoverMode = 'direct' | 'persisted';

type UseDirectSessionTakeoverParams = Readonly<{
    sessionId: string;
    hasWriteAccess: boolean;
    directSessionRuntime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'status' | 'refreshNow'>;
}>;

type UseDirectSessionTakeoverResult = Readonly<{
    takeoverInFlight: DirectTakeoverMode | null;
    importOperation: ActionOperationSnapshotV1 | null;
    importStatusError: string | null;
    cancelImport: () => Promise<void>;
    refreshImport: () => Promise<void>;
    requestTakeover: (mode: DirectTakeoverMode, options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>) => Promise<boolean>;
    ensureReadyForSend: () => Promise<boolean>;
}>;

const IMPORT_ACTION_ID = DIRECT_SESSION_TAKEOVER_ACTION_IDS.persisted;

function isImportActive(operation: ActionOperationSnapshotV1 | null): boolean {
    return operation?.state === 'accepted' || operation?.state === 'running';
}

export function useDirectSessionTakeover(params: UseDirectSessionTakeoverParams): UseDirectSessionTakeoverResult {
    const [requestInFlight, setRequestInFlight] = React.useState<DirectTakeoverMode | null>(null);
    const [importStatusError, setImportStatusError] = React.useState<string | null>(null);
    const operationRef = React.useRef<ActionOperationSnapshotV1 | null>(null);
    const importAddressRef = React.useRef<{ owner: string; machineId: string } | null>(null);
    const accountScope = useActiveServerAccountScope();
    const accountId = accountScope?.accountId ?? '';
    const owner = JSON.stringify([accountId, params.sessionId]);
    const requestInFlightRef = React.useRef(false);
    const statusInFlightRef = React.useRef<Promise<void> | null>(null);
    const terminalHandledRef = React.useRef<string | null>(null);
    const terminalRefreshPromiseRef = React.useRef<Promise<boolean> | null>(null);
    const terminalRefreshingRef = React.useRef(false);
    const pendingImportRef = React.useRef<((ready: boolean) => void) | null>(null);
    const currentParamsRef = React.useRef(params);
    currentParamsRef.current = params;
    // Conversion removes the direct link before the daemon publishes its terminal snapshot.
    const machineId = importAddressRef.current?.owner === owner
        ? importAddressRef.current.machineId
        : params.directSessionRuntime.directSessionLink?.machineId;
    const mountedOwnerRef = React.useRef<string | null>(owner);

    React.useEffect(() => {
        mountedOwnerRef.current = owner;
        importAddressRef.current = null;
        terminalHandledRef.current = null;
        terminalRefreshPromiseRef.current = null;
        terminalRefreshingRef.current = false;
        requestInFlightRef.current = false;
        statusInFlightRef.current = null;
        setRequestInFlight(null);
        setImportStatusError(null);
        return () => {
            mountedOwnerRef.current = null;
            pendingImportRef.current?.(false);
            pendingImportRef.current = null;
        };
    }, [owner]);

    const operations = useActionOperations({ accountId, machineId: machineId ?? '', sessionId: params.sessionId, actionId: IMPORT_ACTION_ID });
    const importOperation = React.useMemo(() => operations.reduce<ActionOperationSnapshotV1 | null>((latest, operation) =>
        latest && latest.createdAt > operation.createdAt ? latest : operation, null), [operations]);
    operationRef.current = importOperation;
    const observation = React.useSyncExternalStore(actionOperationStore.subscribe, () => {
        const state = actionOperationStore.getState();
        return importOperation ? selectActionOperationObservationForOperation(state, importOperation)
            : selectActionOperationObservation(state, { accountId, machineId: machineId ?? '' });
    });
    const activeImport = isImportActive(importOperation) && observation === 'available';
    const observationError = observation === 'available' ? null : t('chatFooter.directImportStatusUnavailable');

    const refreshTerminalProjection = React.useCallback((operation: ActionOperationSnapshotV1): Promise<boolean> => {
        if (mountedOwnerRef.current !== owner || operationRef.current?.operationId !== operation.operationId
            || isImportActive(operation)) return Promise.resolve(false);
        if (terminalHandledRef.current === operation.operationId) return terminalRefreshPromiseRef.current ?? Promise.resolve(false);
        terminalHandledRef.current = operation.operationId;
        terminalRefreshingRef.current = true;
        const pendingImport = pendingImportRef.current;
        setRequestInFlight('persisted');
        const refresh = (async () => {
            let refreshed = false;
            try {
                await Promise.all([
                    currentParamsRef.current.directSessionRuntime.refreshNow(),
                    sync.refreshSessionMessages(params.sessionId),
                    sync.refreshSessions(),
                ]);
                refreshed = true;
                if (mountedOwnerRef.current === owner) setImportStatusError(null);
            } catch (error) {
                if (mountedOwnerRef.current === owner) {
                    terminalHandledRef.current = null;
                    setImportStatusError(error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
                }
            } finally {
                if (mountedOwnerRef.current === owner) {
                    if (pendingImportRef.current === pendingImport) {
                        pendingImport?.(refreshed && operation.state === 'succeeded');
                        pendingImportRef.current = null;
                    }
                    terminalRefreshingRef.current = false;
                    if (refreshed) importAddressRef.current = null;
                    setRequestInFlight(null);
                }
            }
            return mountedOwnerRef.current === owner && refreshed && operation.state === 'succeeded';
        })();
        terminalRefreshPromiseRef.current = refresh;
        return refresh;
    }, [owner, params.sessionId]);

    React.useEffect(() => {
        if (!importOperation) return;
        importAddressRef.current = { owner, machineId: importOperation.scope.machineId };
        if (observation !== 'available') {
            pendingImportRef.current?.(false);
            pendingImportRef.current = null;
            return;
        }
        if (!isImportActive(importOperation)) void refreshTerminalProjection(importOperation);
    }, [importOperation, observation, owner, refreshTerminalProjection]);

    const refreshImport = React.useCallback(async () => {
        if (!accountId || !machineId || mountedOwnerRef.current !== owner) return;
        if (statusInFlightRef.current) return statusInFlightRef.current;
        const refresh = (async () => {
            const operation = operationRef.current;
            try {
                const serverId = resolvePreferredServerIdForSessionId(params.sessionId);
                if (operation) {
                    const result = await getActionOperation({ machineId: operation.scope.machineId, operationId: operation.operationId, serverId });
                    if (mountedOwnerRef.current !== owner) return;
                    if (result.kind === 'not_found') { actionOperationStore.markUnavailable(operation.operationId); return; }
                    actionOperationStore.mergeFullSnapshot(result.operation);
                    const latest = actionOperationStore.getState().operationsById.get(result.operation.operationId);
                    if (!latest || operationRef.current?.operationId !== latest.operationId) return;
                    actionOperationStore.setObservation(latest.scope, 'available');
                    if (isImportActive(latest)) setImportStatusError(null);
                    else await refreshTerminalProjection(latest);
                } else {
                    await reconcileActionOperationsOnce({ scope: { accountId, machineId, serverId }, shouldContinue: () => mountedOwnerRef.current === owner });
                    if (mountedOwnerRef.current === owner) setImportStatusError(null);
                }
            } catch (error) {
                if (mountedOwnerRef.current === owner && (!operation || operationRef.current?.operationId === operation.operationId)) {
                    actionOperationStore.setObservation({ accountId, machineId }, 'status_unavailable');
                    setImportStatusError(error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
                }
            }
        })();
        statusInFlightRef.current = refresh;
        try { await refresh; } finally { if (statusInFlightRef.current === refresh) statusInFlightRef.current = null; }
    }, [accountId, machineId, owner, params.sessionId, refreshTerminalProjection]);

    // Recover once on entry; the shared runtime owns connection reconciliation and live revisions.
    React.useEffect(() => {
        if (!accountId || !machineId || operationRef.current) return;
        void refreshImport();
    }, [accountId, machineId, owner, refreshImport]);

    const cancelImport = React.useCallback(async () => {
        const operation = operationRef.current;
        if (!params.hasWriteAccess || !operation || !isImportActive(operation) || operation.cancellation !== 'supported' || isActionOperationCancellationRequested(operation)) return;
        try {
            const result = await cancelActionOperation({ machineId: operation.scope.machineId, operationId: operation.operationId,
                serverId: resolvePreferredServerIdForSessionId(params.sessionId) });
            if (result.kind !== 'requested' && result.kind !== 'already_settled') throw new Error(t('inbox.actionOperations.stopFailed'));
        } catch (error) {
            if (mountedOwnerRef.current === owner) setImportStatusError(error instanceof Error ? error.message : t('inbox.actionOperations.stopFailed'));
        }
    }, [owner, params.hasWriteAccess, params.sessionId]);

    const readLatestStatus = React.useCallback(async () => {
        return await currentParamsRef.current.directSessionRuntime.refreshNow();
    }, []);

    const requestTakeover = React.useCallback(async (
        mode: DirectTakeoverMode,
        options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>,
    ): Promise<boolean> => {
        if (!params.hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return false;
        }
        if (!machineId || (mode === 'persisted' && !accountId) || requestInFlightRef.current || terminalRefreshingRef.current
            || (isImportActive(operationRef.current) && observation === 'available')) return false;
        requestInFlightRef.current = true;
        setRequestInFlight(mode);
        try {
            let latestStatus = await readLatestStatus();
            if (!latestStatus || mountedOwnerRef.current !== owner || terminalRefreshingRef.current) return false;
            const serverId = resolvePreferredServerIdForSessionId(params.sessionId);
            if (latestStatus.machineOnline && hasDerivedRetainedSessionLink(storage.getState().sessions[params.sessionId]?.metadata)) {
                await storeRetainedSessionLink(params.sessionId, serverId);
                if (mountedOwnerRef.current !== owner || terminalRefreshingRef.current) return false;
                latestStatus = await readLatestStatus();
                const available = mode === 'persisted' ? latestStatus?.canTakeOverPersist : latestStatus?.canTakeOverDirect;
                if (!latestStatus || !available || mountedOwnerRef.current !== owner || terminalRefreshingRef.current) {
                    Modal.alert(t('common.error'), t('errors.failedToSwitchControl'));
                    return false;
                }
            }
            if (!latestStatus.machineOnline) {
                Modal.alert(t('common.error'), t('chatFooter.directSessionMachineOffline'));
                return false;
            }
            let forceStop = options?.forceStop === true;
            if (!forceStop && latestStatus.canForceStop && options?.promptForForceStop !== false) {
                const confirmed = await Modal.confirm(
                    t('chatFooter.directTakeoverForceStopConfirmTitle'),
                    t('chatFooter.directTakeoverForceStopConfirmBody'),
                    { confirmText: t('chatFooter.directTakeoverForceStopConfirmAction'), cancelText: t('common.cancel') },
                );
                if (!confirmed) return false;
                forceStop = true;
            }
            if (mountedOwnerRef.current !== owner || terminalRefreshingRef.current) return false;
            setImportStatusError(null);
            const request = { machineId, sessionId: params.sessionId, ...(forceStop ? { forceStop: true } : {}) };
            if (mode === 'persisted') {
                terminalHandledRef.current = null;
                const requestId = randomUUID();
                let result;
                try {
                    result = await machineDirectSessionTakeoverPersistStart({ ...request, requestId }, { serverId });
                } catch (error) {
                    // A lost start acknowledgement does not prove that the daemon failed to start.
                    await reconcileActionOperationsOnce({ scope: { accountId, machineId, serverId }, shouldContinue: () => mountedOwnerRef.current === owner });
                    const recovered = Array.from(actionOperationStore.getState().operationsById.values()).find(operation =>
                        operation.actionId === IMPORT_ACTION_ID && operation.scope.accountId === accountId
                        && operation.scope.machineId === machineId && operation.scope.sessionId === params.sessionId
                        && (operation.requestId === requestId || isImportActive(operation)));
                    if (!recovered) throw error;
                    result = { ok: true as const, operation: recovered };
                }
                if (mountedOwnerRef.current !== owner) return false;
                if (!result.ok) {
                    Modal.alert(t('common.error'), result.error === 'direct_session_import_requires_daemon_upgrade'
                        ? t('chatFooter.directImportRequiresDaemonUpgrade') : result.error);
                    return false;
                }
                if (!result.operation) throw new Error(t('chatFooter.directImportStatusUnavailable'));
                importAddressRef.current = { owner, machineId: result.operation.scope.machineId };
                actionOperationStore.mergeFullSnapshot(result.operation);
                const latest = actionOperationStore.getState().operationsById.get(result.operation.operationId) ?? result.operation;
                operationRef.current = latest;
                if (!isImportActive(latest)) return await refreshTerminalProjection(latest);
                return await new Promise<boolean>((resolve) => { pendingImportRef.current = resolve; });
            }
            const result = await machineDirectSessionTakeover(request, { serverId });
            if (!result.ok) { Modal.alert(t('common.error'), result.error); return false; }
            await Promise.all([readLatestStatus(), sync.refreshSessionMessages(params.sessionId)]);
            return true;
        } catch (error) {
            if (mountedOwnerRef.current !== owner) return false;
            if (mode === 'persisted') setImportStatusError(error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            return false;
        } finally {
            if (mountedOwnerRef.current === owner) {
                requestInFlightRef.current = false;
                if (!terminalRefreshingRef.current) setRequestInFlight(null);
            }
        }
    }, [accountId, machineId, observation, owner, params.hasWriteAccess, params.sessionId, readLatestStatus, refreshTerminalProjection]);

    const ensureReadyForSend = React.useCallback(async (): Promise<boolean> => {
        if (requestInFlightRef.current || terminalRefreshingRef.current || (isImportActive(operationRef.current) && observation === 'available')) return false;
        if (!currentParamsRef.current.directSessionRuntime.directSessionLink) return true;
        const latestStatus = await readLatestStatus();
        if (!latestStatus || latestStatus.runnerActive) return true;
        if (!latestStatus.machineOnline) {
            Modal.alert(t('common.error'), t('chatFooter.directSessionMachineOffline'));
            return false;
        }
        const resolution = await showDirectSessionTakeoverDialog({
            canTakeOverDirect: latestStatus.canTakeOverDirect,
            canTakeOverPersist: latestStatus.canTakeOverPersist,
            canForceStop: latestStatus.canForceStop,
        });
        if (!resolution.action) return false;
        return requestTakeover(resolution.action, { forceStop: resolution.forceStop, promptForForceStop: false });
    }, [observation, readLatestStatus, requestTakeover]);

    return React.useMemo(() => ({
        takeoverInFlight: activeImport ? 'persisted' : requestInFlight,
        importOperation, importStatusError: importStatusError ?? observationError, cancelImport, refreshImport, requestTakeover, ensureReadyForSend,
    }), [activeImport, requestInFlight, importOperation, importStatusError, observationError, cancelImport, refreshImport, requestTakeover, ensureReadyForSend]);
}
