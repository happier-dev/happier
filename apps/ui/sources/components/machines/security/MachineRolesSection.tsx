import * as React from 'react';
import { CoreMachineRoleIdV1Schema, type CoreMachineRoleIdV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { useMachineRolesEditor } from './useMachineRolesEditor';

function isCoreRoleId(id: string): id is CoreMachineRoleIdV1 { return CoreMachineRoleIdV1Schema.safeParse(id).success; }

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
    const { machine, serverId, machineName, online } = props;
    const { list, shownActive, readOnlyReason, busy, setRole } = useMachineRolesEditor({ scope: serverId, machine, machineName, online });

    if (list.status !== 'ready') return null;
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
                        onPress={() => { void setRole(role.id, !on); }}
                        rightElement={<Switch value={on} disabled={disabled} onValueChange={next => { void setRole(role.id, next); }} />}
                    />
                );
            })}
        </ItemGroup>
    );
});
