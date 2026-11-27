import * as React from 'react';
import { isActionApprovalDeclinedErrorCode, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useConnectedServiceRecoveryCreditMachineTarget } from '@/hooks/server/connectedServices/useConnectedServiceRecoveryCreditMachineTarget';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import {
    getConnectedServiceQuotaRecoveryCreditCheckInput,
    hasNewRecoveryCreditObservation,
    readConnectedServiceQuotaRecoveryCreditActionPresentation,
    resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey,
    type UnconfirmedAccountUsageReset,
} from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';
import { readMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, readSelectedMachineAdministrationTarget } from '@/sync/domains/machines/administration/selectionPreferences';
import { doesMachineAdministrationTargetMatchActiveAccount, resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

export type AccountUsageResetAction = Readonly<{
    pending: boolean;
    /** Ends the caller's wait. An issued provider request can still complete. */
    cancelWait?: () => void;
    outcome: UnconfirmedAccountUsageReset | null;
    /** Applies one usage reset and returns the shared Action's settlement. */
    use: (providerCreditId: string | null) => Promise<ActionExecuteResult | undefined>;
    /** Requests a quota refresh. A later usage publication replaces the temporary status. */
    check: () => Promise<void>;
}>;

/** Spend a published reset on the account's Session Machine or the selected Connected Accounts Machine. */
export function useAccountUsageResetAction(params: Readonly<{
    serviceId: string;
    accountId: string;
    /** Detail admission: null refuses; a machine id must still be the fresh Account choice. */
    machineId?: string | null;
    snapshotFetchedAtMs: number | null;
    onApplied: () => void;
    recoveryCreditsObservedAtMs?: number | null;
    /** Keep the invoked row visible if its credit inventory changes before the result. */
    onRetainRow?: (retain: boolean) => void;
}>): AccountUsageResetAction {
    const activeServer = useActiveServerSnapshot();
    const { binding, execute, isCurrent } = useMountedActionExecution(activeServer.serverId);
    const sessionMachineId = useConnectedServiceRecoveryCreditMachineTarget({
        serviceId: params.serviceId,
        profileId: params.accountId,
    });
    const [activity, setActivity] = React.useState<AbortController | 'checking' | null>(null);
    const pending = activity !== null;
    const cancelWait = React.useCallback(() => {
        if (activity && activity !== 'checking') activity.abort();
    }, [activity]);
    const [presented, setPresented] = React.useState<Readonly<{
        binding: typeof binding;
        serviceId: string;
        accountId: string;
        machineId: string;
        previousObservationAtMs: number | null;
        outcome: UnconfirmedAccountUsageReset;
    }> | null>(null);
    const { serviceId, accountId, snapshotFetchedAtMs, recoveryCreditsObservedAtMs, onApplied, onRetainRow, machineId: admittedMachineId } = params;
    const newestObservationAtMs = React.useRef(snapshotFetchedAtMs);
    React.useLayoutEffect(() => { newestObservationAtMs.current = snapshotFetchedAtMs; }, [snapshotFetchedAtMs]);
    const current = presented?.binding === binding && presented?.serviceId === serviceId
        && presented.accountId === accountId ? presented : null;
    const quotaUpdated = current !== null && hasNewRecoveryCreditObservation(recoveryCreditsObservedAtMs, current.previousObservationAtMs);
    const outcome = quotaUpdated ? null : current?.outcome ?? null;
    React.useEffect(() => {
        if (!quotaUpdated) return;
        setPresented(null);
        onRetainRow?.(false);
    }, [onRetainRow, quotaUpdated]);
    const use = React.useCallback(async (providerCreditId: string | null) => {
        if (pending || outcome?.kind === 'unknown') return;
        const state = storage.getState();
        const selected = readSelectedMachineAdministrationTarget(
            state.settings.machineAdministrationTargetsLocalV1,
            MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts,
            readMachineAdministrationTargetObservation(state.settingsScope, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts),
        );
        const selectedMachine = doesMachineAdministrationTargetMatchActiveAccount({
            target: selected, activeAccountServerId: activeServer.serverId,
        }) ? resolveFreshMachineAdministrationExecutionTarget(selected)?.machine.id ?? null : null;
        // The distinct session usage surface retains its bound-session target;
        // Account detail must not substitute that target for its explicit choice.
        const machineId = admittedMachineId === undefined
            ? sessionMachineId ?? selectedMachine
            : admittedMachineId !== null && admittedMachineId === selectedMachine ? admittedMachineId : null;
        if (!machineId) {
            await Modal.alert(t('common.error'), t('connectedServices.quota.recoveryCreditMachineUnavailable'));
            return;
        }
        const waiter = new AbortController();
        setActivity(waiter);
        onRetainRow?.(true);
        setPresented(null);
        let nextOutcome: UnconfirmedAccountUsageReset | null = null;
        try {
            const execution = await execute('connectedServices.quota.reset', {
                machineId,
                serviceId,
                profileId: accountId,
                sourceSnapshotFetchedAtMs: snapshotFetchedAtMs,
                ...(providerCreditId ? { providerCreditId } : {}),
            }, { signal: waiter.signal });
            if (!isCurrent()) return execution;
            const { outcome, failure, result } = readConnectedServiceQuotaRecoveryCreditActionPresentation(execution);
            nextOutcome = outcome?.kind === 'unknown' ? outcome : null;
            if (outcome?.kind === 'used') {
                onApplied();
            } else if (outcome?.kind === 'unknown') {
                return execution;
            } else if (failure) {
                if (failure.errorCode !== 'cancelled' && !isActionApprovalDeclinedErrorCode(failure.errorCode)) {
                    await Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(failure, t('errors.operationFailed')));
                }
            } else if (result?.ok) {
                const noticeKey = resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey(result.receipt.status);
                if (noticeKey) await Modal.alert(t('common.info'), t(noticeKey));
                onApplied();
            } else {
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
            }
            return execution;
        } finally {
            setActivity(null);
            if (nextOutcome && isCurrent()) setPresented({
                binding, serviceId, accountId, machineId,
                previousObservationAtMs: newestObservationAtMs.current,
                outcome: nextOutcome,
            });
            else onRetainRow?.(false);
        }
    }, [accountId, activeServer, admittedMachineId, binding, execute, isCurrent, serviceId, onApplied, onRetainRow, outcome, pending, sessionMachineId, snapshotFetchedAtMs]);
    const check = React.useCallback(async () => {
        if (pending || !outcome || !current || !isCurrent()) return;
        const input = getConnectedServiceQuotaRecoveryCreditCheckInput(serviceId, accountId, current.machineId);
        if (!input) return;
        setActivity('checking');
        try {
            await execute('connectedServices.quota.refresh', input);
        } finally {
            setActivity(null);
        }
    }, [accountId, current, execute, isCurrent, serviceId, outcome, pending]);
    return { pending, outcome, use, check, ...(activity && activity !== 'checking' ? { cancelWait } : {}) };
}
