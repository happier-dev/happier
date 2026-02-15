import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Text as RNText, View } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';

import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';

type ThemeColors = Readonly<{
    textSecondary: string;
    status: Readonly<{
        connected: string;
        disconnected: string;
    }>;
}>;

function renderMachineSubtitle(params: Readonly<{
    machine: Machine;
    serverId: string;
    textSecondaryColor: string;
}>): React.ReactNode {
    const isOnline = isMachineOnline(params.machine);
    const host = params.machine.metadata?.host || 'Unknown';
    const displayName = params.machine.metadata?.displayName;
    const platform = params.machine.metadata?.platform || '';

    const subtitleTop = displayName && displayName !== host ? host : '';
    const statusText = isOnline ? t('status.online') : t('status.offline');
    const statusLineText = platform ? `${platform} • ${statusText}` : statusText;

    return (
        <View style={{ gap: 2 }}>
            {subtitleTop ? (
                <RNText style={[Typography.default(), { fontSize: 14, color: params.textSecondaryColor, lineHeight: 20 }]}>
                    {subtitleTop}
                </RNText>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <RNText
                    style={[
                        Typography.default(),
                        { fontSize: 14, color: params.textSecondaryColor, lineHeight: 20, flexShrink: 1 },
                    ]}
                    numberOfLines={1}
                >
                    {statusLineText}
                </RNText>
                <RNText style={[Typography.default(), { fontSize: 14, color: params.textSecondaryColor, lineHeight: 20, opacity: 0.8 }]}>
                    {' • '}
                </RNText>
                <MachineCliGlyphs machineId={params.machine.id} serverId={params.serverId} isOnline={isOnline} />
            </View>
        </View>
    );
}

type ActiveSelectionMachinesSectionProps = Readonly<{
    hasAnyVisibleMachines: boolean;
    showMachinesGroupedByServer: boolean;
    visibleMachineGroups: ReadonlyArray<ActiveSelectionMachineGroup>;
    allMachines: ReadonlyArray<Machine>;
    activeServerId: string;
    machinesTitle: React.ReactNode;
    themeColors: ThemeColors;
    onOpenMachine: (machineId: string, serverId?: string) => void;
}>;

export const ActiveSelectionMachinesSection = React.memo(function ActiveSelectionMachinesSection(
    props: ActiveSelectionMachinesSectionProps,
) {
    return (
        <>
            {props.hasAnyVisibleMachines && props.showMachinesGroupedByServer
                ? props.visibleMachineGroups.map((group) => {
                    const serverStatusLabel =
                        group.status === 'signedOut'
                            ? t('server.signedOut')
                            : group.status === 'loading'
                                ? t('status.connecting')
                                : group.status === 'error'
                                    ? t('status.error')
                                    : null;
                    const serverSubtitle = serverStatusLabel
                        ? `${group.machines.length} machine${group.machines.length === 1 ? '' : 's'} • ${serverStatusLabel}`
                        : `${group.machines.length} machine${group.machines.length === 1 ? '' : 's'}`;

                    return (
                        <ItemGroup
                            key={`machines-group-${group.serverId}`}
                            title={group.serverName}
                            footer={serverSubtitle}
                        >
                            {group.machines.length === 0 ? (
                                <Item
                                    title={t('newSession.noMachinesFound')}
                                    subtitle={serverStatusLabel ?? undefined}
                                    icon={<Ionicons name="desktop-outline" size={29} color={props.themeColors.textSecondary} />}
                                    showChevron={false}
                                />
                            ) : null}
                            {group.machines.map((machine) => {
                                const isOnline = isMachineOnline(machine);
                                const host = machine.metadata?.host || 'Unknown';
                                const displayName = machine.metadata?.displayName;
                                const title = displayName || host;

                                return (
                                    <Item
                                        key={`machine-${group.serverId}-${machine.id}`}
                                        title={title}
                                        subtitle={renderMachineSubtitle({
                                            machine,
                                            serverId: group.serverId,
                                            textSecondaryColor: props.themeColors.textSecondary,
                                        })}
                                        icon={
                                            <Ionicons
                                                name="desktop-outline"
                                                size={29}
                                                color={isOnline ? props.themeColors.status.connected : props.themeColors.status.disconnected}
                                            />
                                        }
                                        onPress={() => props.onOpenMachine(machine.id, group.serverId)}
                                    />
                                );
                            })}
                        </ItemGroup>
                    );
                })
                : null}
            {props.hasAnyVisibleMachines && !props.showMachinesGroupedByServer ? (
                <ItemGroup title={props.machinesTitle}>
                    {[...props.allMachines].map((machine) => {
                        const isOnline = isMachineOnline(machine);
                        const host = machine.metadata?.host || 'Unknown';
                        const displayName = machine.metadata?.displayName;
                        const title = displayName || host;

                        return (
                            <Item
                                key={machine.id}
                                title={title}
                                subtitle={renderMachineSubtitle({
                                    machine,
                                    serverId: props.activeServerId,
                                    textSecondaryColor: props.themeColors.textSecondary,
                                })}
                                icon={
                                    <Ionicons
                                        name="desktop-outline"
                                        size={29}
                                        color={isOnline ? props.themeColors.status.connected : props.themeColors.status.disconnected}
                                    />
                                }
                                onPress={() => props.onOpenMachine(machine.id)}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}
        </>
    );
});
