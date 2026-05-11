import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { McpServerBindingTargetV1 } from '@happier-dev/protocol';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

type BindingTargetType = McpServerBindingTargetV1['t'];

export function describeBindingTarget(target: McpServerBindingTargetV1, machines: readonly Machine[]): string {
    if (target.t === 'allMachines') return t('settings.mcpServersBindingTargetAllMachines');
    const machine = machines.find((m) => m.id === target.machineId) ?? null;
    const machineLabel = machine?.metadata?.displayName || machine?.metadata?.host || target.machineId;
    if (target.t === 'machine') return t('settings.mcpServersBindingTargetMachine', { machine: machineLabel });
    return t('settings.mcpServersBindingTargetWorkspace', { machine: machineLabel, path: target.workspaceRoot });
}

export const McpBindingTargetFields = React.memo(function McpBindingTargetFields(props: Readonly<{
    target: McpServerBindingTargetV1;
    machines: readonly Machine[];
    onChangeTargetType: (nextType: BindingTargetType) => void;
    onChangeMachineId: (machineId: string) => void;
    onOpenWorkspacePicker: () => void;
}>) {
    const { theme } = useUnistyles();
    const [openMenu, setOpenMenu] = React.useState<null | 'targetType' | 'machine'>(null);

    const targetTypeItems = React.useMemo((): DropdownMenuItem[] => {
        return [
            {
                id: 'allMachines',
                title: t('settings.mcpServersBindingTargetAllMachines'),
                subtitle: t('settings.mcpServersBindingTargetAllMachinesSubtitle'),
                icon: <Ionicons name="globe-outline" size={22} color={theme.colors.text.secondary} />,
            },
            {
                id: 'machine',
                title: t('settings.mcpServersBindingTargetMachineTitle'),
                subtitle: t('settings.mcpServersBindingTargetMachineSubtitle'),
                icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
            },
            {
                id: 'workspace',
                title: t('settings.mcpServersBindingTargetWorkspaceTitle'),
                subtitle: t('settings.mcpServersBindingTargetWorkspaceSubtitle'),
                icon: <Ionicons name="folder-outline" size={22} color={theme.colors.text.secondary} />,
            },
        ];
    }, [theme.colors.text.secondary]);

    const machineItems = React.useMemo((): DropdownMenuItem[] => {
        return props.machines.map((machine) => ({
            id: machine.id,
            title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            subtitle: machine.id,
            icon: <Ionicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
        }));
    }, [props.machines, theme.colors.text.secondary]);

    const selectedMachineId = props.target.t === 'allMachines'
        ? null
        : props.target.machineId;

    return (
        <>
            <DropdownMenu
                open={openMenu === 'targetType'}
                onOpenChange={(open) => setOpenMenu(open ? 'targetType' : null)}
                items={targetTypeItems}
                selectedId={props.target.t}
                onSelect={(id) => {
                    setOpenMenu(null);
                    props.onChangeTargetType(id as BindingTargetType);
                }}
                itemTrigger={{
                    title: t('settings.mcpServersBindingTarget'),
                    subtitle: t('settings.mcpServersBindingTargetSubtitle'),
                    icon: <Ionicons name="pin-outline" size={29} color={theme.colors.accent.purple} />,
                }}
                rowKind="item"
                connectToTrigger
                variant="default"
            />

            {props.target.t !== 'allMachines' ? (
                <DropdownMenu
                    open={openMenu === 'machine'}
                    onOpenChange={(open) => setOpenMenu(open ? 'machine' : null)}
                    items={machineItems}
                    selectedId={selectedMachineId}
                    onSelect={(id) => {
                        setOpenMenu(null);
                        props.onChangeMachineId(id);
                    }}
                    itemTrigger={{
                        title: t('settings.mcpServersBindingMachine'),
                        subtitle: t('settings.mcpServersBindingMachineSubtitle'),
                        icon: <Ionicons name="laptop-outline" size={29} color={theme.colors.accent.indigo} />,
                    }}
                    rowKind="item"
                    connectToTrigger
                    variant="default"
                />
            ) : null}

            {props.target.t === 'workspace' ? (
                <Item
                    title={t('settings.mcpServersBindingWorkspaceRootTitle')}
                    subtitle={props.target.workspaceRoot}
                    icon={<Ionicons name="folder-outline" size={29} color={theme.colors.accent.blue} />}
                    onPress={props.onOpenWorkspacePicker}
                />
            ) : null}
        </>
    );
});
