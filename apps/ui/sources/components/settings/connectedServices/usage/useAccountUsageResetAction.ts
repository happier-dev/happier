import * as React from 'react';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useConnectedServiceRecoveryCreditMachineTarget } from '@/hooks/server/connectedServices/useConnectedServiceRecoveryCreditMachineTarget';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import { resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey } from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';
import { readMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1, readSelectedMachineAdministrationTarget } from '@/sync/domains/machines/administration/selectionPreferences';
import { doesMachineAdministrationTargetMatchActiveAccount, resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import type { ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';

export type AccountUsageResetAction = Readonly<{
    pending: boolean;
    /** Applies one usage reset (the given provider credit, or the next one), then refreshes the account. */
    use: (providerCreditId: string | null) => Promise<void>;
}>;

/**
 * "Use one" for an account's usage resets (Codex): the incumbent quota-reset Action
 * reaches the canonical consume operation with the built-in ingress service id and the account id. It runs
 * on the machine a live session signs in with this account, else on the machine chosen for connected
 * accounts; with neither it says why instead of guessing. The typed receipt is spoken; a success
 * refreshes the shared account cache so every surface shows the fresh window.
 */
export function useAccountUsageResetAction(params: Readonly<{
    /** The built-in service id the consume operation speaks (usage resets exist for built-in services only). */
    legacyServiceId: ConnectedServiceId;
    accountId: string;
    /** Detail admission: null refuses; a machine id must still be the fresh Account choice. */
    machineId?: string | null;
    snapshotFetchedAtMs: number | null;
    onApplied: () => void;
}>): AccountUsageResetAction {
    const activeServer = useActiveServerSnapshot();
    const { execute, isCurrent } = useMountedActionExecution(activeServer.serverId);
    const sessionMachineId = useConnectedServiceRecoveryCreditMachineTarget({
        serviceId: params.legacyServiceId,
        profileId: params.accountId,
    });
    const [pending, setPending] = React.useState(false);
    const { legacyServiceId, accountId, snapshotFetchedAtMs, onApplied, machineId: admittedMachineId } = params;
    const use = React.useCallback(async (providerCreditId: string | null) => {
        if (pending) return;
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
        setPending(true);
        try {
            const execution = await execute('connectedServices.quota.reset', {
                machineId,
                serviceId: legacyServiceId,
                profileId: accountId,
                sourceSnapshotFetchedAtMs: snapshotFetchedAtMs,
                ...(providerCreditId ? { providerCreditId } : {}),
            });
            if (!execution.ok) {
                if (isCurrent() && execution.errorCode !== 'cancelled' && !isActionApprovalDeclinedErrorCode(execution.errorCode)) {
                    await Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(execution, t('errors.operationFailed')));
                }
                return;
            }
            const parsed = ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.safeParse(execution.result);
            if (!parsed.success) {
                if (isCurrent()) await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }
            const result = parsed.data;
            if (!result.ok) {
                if (isCurrent()) {
                    await Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(result, t('errors.operationFailed')));
                }
                return;
            }
            const noticeKey = resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey(result.receipt.status);
            if (noticeKey && isCurrent()) await Modal.alert(t('common.info'), t(noticeKey));
            onApplied();
        } finally {
            setPending(false);
        }
    }, [accountId, activeServer, admittedMachineId, execute, isCurrent, legacyServiceId, onApplied, pending, sessionMachineId, snapshotFetchedAtMs]);
    return { pending, use };
}
