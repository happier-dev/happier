import * as React from 'react';

import { ApprovalProfileSelect } from '@/components/approvals/ApprovalProfileSelect';
import { setApprovalProfileMachineDefault } from '@/components/settings/actions/approvalProfileWrites';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useApprovalProfiles } from '@/hooks/approvals/useApprovalProfiles';
import { t } from '@/text';

/**
 * Machine → Security "Approval profile": which saved profile my Sessions on this Machine use when they don't pick
 * one. It is my Account's preference (OWNER Q4), so it reads the same for me on a shared Machine and changes nobody
 * else's Sessions; it reaches running Sessions at their next Action.
 */
export const MachineApprovalProfileSection = React.memo(function MachineApprovalProfileSection(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
}>) {
    const source = useApprovalProfiles(undefined, props.serverId);
    const stored = source.machineApprovalProfiles[props.machineId] ?? null;
    const [pending, setPending] = React.useState<Readonly<{ value: string | null }> | null>(null);
    const change = async (next: string | null) => {
        if (pending !== null || next === stored) return;
        setPending({ value: next });
        try {
            await setApprovalProfileMachineDefault(source.execute, props.machineId, next);
        } finally {
            setPending(null);
        }
    };
    return (
        // One row names the decision; its line says whose Sessions it covers (mockup: Machine › Security row).
        <ItemGroup testID="machine-approval-profile-section">
            <ApprovalProfileSelect mode="machine" testID="machine-approval-profile" source={source}
                value={pending ? pending.value : stored} disabled={pending !== null}
                description={t('workflows.triggers.guided.profile.machineSectionDescription', { machine: props.machineName })}
                onChange={(value) => { void change(value); }} />
        </ItemGroup>
    );
});
