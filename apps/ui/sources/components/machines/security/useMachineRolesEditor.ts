import * as React from 'react';
import { MachineRolesMutationResultV1Schema } from '@happier-dev/protocol/machines/roles/machineRolesV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { readSyncedMachineRolesList } from '@/sync/domains/machines/roles/machineRoles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

/** A settled choice stays visible until its matching Machine publication arrives. */
type PendingRoles = Readonly<{ active: readonly string[]; settledAtVersion: number | null }>;

export function useMachineRolesEditor(input: Readonly<{
    scope: ServerAccountScope | string;
    machine: Machine;
    machineName: string;
    online: boolean | null;
}>) {
    const { scope, machine, machineName, online } = input;
    const serverId = typeof scope === 'string' ? scope : scope.serverId;
    const list = React.useMemo(() => readSyncedMachineRolesList(machine), [machine]);
    const { execute } = useMountedActionExecution(scope);
    const [pending, setPending] = React.useState<PendingRoles | null>(null);
    const syncedVersion = list.status === 'ready' ? list.metadataVersion : null;
    React.useEffect(() => {
        if (pending?.settledAtVersion != null && syncedVersion != null && syncedVersion >= pending.settledAtVersion) setPending(null);
    }, [pending, syncedVersion]);

    const canManage = canManageMachine(machine);
    const readOnlyReason = !canManage ? t('machineDetailPage.roles.notManager')
        : online !== true ? t('machineDetailPage.roles.offline', { machine: machineName }) : null;
    const busy = pending !== null && pending.settledAtVersion === null;
    const shownActive = new Set(pending?.active ?? (list.status === 'ready' ? list.roles.filter(role => role.selected).map(role => role.id) : []));
    const setRole = React.useCallback(async (roleId: string, on: boolean) => {
        if (list.status !== 'ready') return false;
        const current = list.policy.active.filter(id => id !== roleId);
        const next = on ? [...current, roleId] : current;
        setPending({ active: next, settledAtVersion: null });
        const result = await execute('machines.roles.set', {
            serverId, machineId: machine.id, expectedMetadataVersion: list.metadataVersion,
            expectedPolicy: list.policy, policy: { active: next },
        });
        const parsed = result.ok ? MachineRolesMutationResultV1Schema.safeParse(result.result) : null;
        if (parsed?.success && (parsed.data.status === 'applied' || parsed.data.status === 'satisfied' || parsed.data.status === 'unchanged')) {
            setPending({ active: parsed.data.policy.active, settledAtVersion: parsed.data.metadataVersion });
            return true;
        }
        setPending(null);
        if (parsed?.success) {
            switch (parsed.data.status) {
                case 'conflict':
                    Modal.alert(t('machineDetailPage.roles.title'), t('machineDetailPage.roles.changed'));
                    break;
                case 'outcomeUnknown':
                    Modal.alert(t('machineDetailPage.roles.title'), t('errors.scmOutcomeUnknown'));
                    break;
                case 'locked':
                    Modal.alert(t('machineDetailPage.roles.saveFailed'), t('machineDetailPage.lockedMachine'));
                    break;
                case 'invalid':
                    Modal.alert(t('machineDetailPage.roles.saveFailed'), t('errors.invalidFormat'));
                    break;
                case 'unavailable':
                    Modal.alert(t('machineDetailPage.roles.saveFailed'), t('common.unavailable'));
                    break;
            }
            return false;
        }
        if (!result.ok && result.errorCode === 'action_account_scope_changed') return false;
        Modal.alert(t('machineDetailPage.roles.saveFailed'), result.ok ? undefined
            : resolveActionExecutionErrorMessage(result, t('common.requestFailed')));
        return false;
    }, [execute, list, machine.id, serverId]);

    return { list, shownActive, canManage, readOnlyReason, busy, setRole };
}
