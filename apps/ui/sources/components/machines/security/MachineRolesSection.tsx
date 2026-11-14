import * as React from 'react';
import { CoreMachineRoleIdV1Schema, MachineRolesMutationResultV1Schema, type CoreMachineRoleIdV1, type MachineRoleListEntryV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import { readSyncedMachineRolesList } from '@/sync/domains/machines/roles/machineRoles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

function isCoreRoleId(id: string): id is CoreMachineRoleIdV1 { return CoreMachineRoleIdV1Schema.safeParse(id).success; }

/** A saved choice waits here until synced metadata reaches its version, so the switch never flickers back. */
type PendingRoles = Readonly<{ active: readonly string[]; settledAtVersion: number | null }>;

/**
 * Machine → Security → Roles (OWNER-RULINGS 2026-11-12): what this Machine runs, one switch per role. The state is
 * the synced `rolesV1` read by the protocol roles owner, so it shows while the Machine is offline; a change is one
 * `machines.roles.set` (Machine Manage, compare-and-swap) applied by the daemon. Plugin parts of a built-in role
 * (`partOf`) follow that role and get no switch of their own.
 */
export const MachineRolesSection = React.memo(function MachineRolesSection(props: Readonly<{
    serverId: string;
    machine: Machine;
    machineName: string;
    online: boolean | null;
}>) {
    const { machine, serverId, machineName } = props;
    const list = React.useMemo(() => readSyncedMachineRolesList(machine), [machine]);
    const { execute } = useMountedActionExecution(serverId);
    const [pending, setPending] = React.useState<PendingRoles | null>(null);
    const syncedVersion = list.status === 'ready' ? list.metadataVersion : null;
    React.useEffect(() => {
        if (pending?.settledAtVersion != null && syncedVersion != null && syncedVersion >= pending.settledAtVersion) setPending(null);
    }, [pending, syncedVersion]);

    const canManage = canManageMachine(machine);
    const readOnlyReason = !canManage ? t('machineDetailPage.roles.notManager')
        : props.online !== true ? t('machineDetailPage.roles.offline', { machine: machineName }) : null;
    const busy = pending !== null && pending.settledAtVersion === null;

    const toggle = React.useCallback(async (role: MachineRoleListEntryV1, on: boolean) => {
        if (list.status !== 'ready') return;
        const current = list.policy.active;
        const next = on ? [...current.filter(id => id !== role.id), role.id] : current.filter(id => id !== role.id);
        setPending({ active: next, settledAtVersion: null });
        const result = await execute('machines.roles.set', {
            serverId, machineId: machine.id, expectedMetadataVersion: list.metadataVersion,
            expectedPolicy: list.policy, policy: { active: next },
        });
        const parsed = result.ok ? MachineRolesMutationResultV1Schema.safeParse(result.result) : null;
        if (parsed?.success && (parsed.data.status === 'applied' || parsed.data.status === 'satisfied' || parsed.data.status === 'unchanged')) {
            setPending({ active: parsed.data.policy.active, settledAtVersion: parsed.data.metadataVersion });
            return;
        }
        setPending(null);
        if (parsed?.success && parsed.data.status === 'conflict') {
            Modal.alert(t('machineDetailPage.roles.title'), t('machineDetailPage.roles.changed'));
            return;
        }
        if (!result.ok && result.errorCode === 'action_account_scope_changed') return;
        Modal.alert(t('machineDetailPage.roles.saveFailed'), result.ok ? undefined : result.error);
    }, [execute, list, machine.id, serverId]);

    if (list.status !== 'ready') return null;
    const shownActive = new Set(pending?.active ?? list.roles.filter(role => role.selected).map(role => role.id));
    const switchable = list.roles.filter(role => role.partOf === undefined);
    return (
        <ItemGroup testID="machine-roles-section" title={t('machineDetailPage.roles.title')}
            description={readOnlyReason ?? t('machineDetailPage.roles.description', { machine: machineName })}>
            {switchable.map(role => {
                const on = shownActive.has(role.id);
                const copy = isCoreRoleId(role.id) ? {
                    title: t(`machineDetailPage.roles.${role.id}.title`),
                    description: t(`machineDetailPage.roles.${role.id}.description`),
                } : { title: role.title, description: role.description };
                // Plugin parts (`partOf`) follow this switch; name them so the owner knows what it turns off.
                const parts = list.roles.filter(part => part.partOf === role.id).map(part => part.title);
                const subtitle = [copy.description,
                    ...(parts.length > 0 ? [t('machineDetailPage.roles.pluginParts', { parts: parts.join(', ') })] : []),
                    ...(role.id === 'sessions' && !on ? [t('machineDetailPage.roles.sessionsOffNote')] : [])].join(' ');
                const disabled = readOnlyReason !== null || busy;
                return (
                    <Item key={role.id} testID={`machine-roles-row-${role.id}`} title={copy.title} subtitle={subtitle}
                        showChevron={false} disabled={disabled}
                        onPress={() => { void toggle(role, !on); }}
                        rightElement={<Switch value={on} disabled={disabled} onValueChange={next => { void toggle(role, next); }} />}
                    />
                );
            })}
        </ItemGroup>
    );
});
