import * as React from 'react';

import { useConnectedServiceRecoveryCreditMachineTarget } from '@/hooks/server/connectedServices/useConnectedServiceRecoveryCreditMachineTarget';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import { resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey } from '@/sync/domains/connectedServices/connectedServiceQuotaRecoveryCreditReceiptPresentation';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { doesMachineAdministrationTargetMatchActiveAccount, resolveFreshMachineAdministrationExecutionTarget } from '@/sync/domains/machines/administration/useTargetSelection';
import { connectedServiceQuotaRecoveryCreditConsume } from '@/sync/ops/connectedServiceQuotaRecoveryCredits';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import type { ConnectedServiceId } from '@happier-dev/protocol';

export type AccountUsageResetAction = Readonly<{
    pending: boolean;
    /** Applies one usage reset (the given provider credit, or the next one), then refreshes the account. */
    use: (providerCreditId: string | null) => Promise<void>;
}>;

/**
 * "Use one" for an account's usage resets (Codex): the one consume operation
 * (`connectedServiceQuotaRecoveryCreditConsume`) with the built-in ingress service id and the account id. It runs
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
    const sessionMachineId = useConnectedServiceRecoveryCreditMachineTarget({
        serviceId: params.legacyServiceId,
        profileId: params.accountId,
    });
    const [pending, setPending] = React.useState(false);
    const { legacyServiceId, accountId, snapshotFetchedAtMs, onApplied, machineId: admittedMachineId } = params;
    const use = React.useCallback(async (providerCreditId: string | null) => {
        if (pending) return;
        const selected = storage.getState().settings.machineAdministrationTargetsLocalV1[
            MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts
        ] ?? null;
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
            const result = await connectedServiceQuotaRecoveryCreditConsume({
                machineId,
                serverId: activeServer.serverId,
                expectedActiveServer: activeServer,
                serviceId: legacyServiceId,
                profileId: accountId,
                sourceSnapshotFetchedAtMs: snapshotFetchedAtMs,
                ...(providerCreditId ? { providerCreditId } : {}),
            });
            if (!result.ok) {
                await Modal.alert(t('common.error'), result.error || result.errorCode);
                return;
            }
            const noticeKey = resolveConnectedServiceQuotaRecoveryCreditReceiptNoticeKey(result.receipt.status);
            if (noticeKey) await Modal.alert(t('common.info'), t(noticeKey));
            onApplied();
        } finally {
            setPending(false);
        }
    }, [accountId, activeServer, admittedMachineId, legacyServiceId, onApplied, pending, sessionMachineId, snapshotFetchedAtMs]);
    return { pending, use };
}
