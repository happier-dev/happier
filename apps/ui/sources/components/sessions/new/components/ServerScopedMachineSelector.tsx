import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import type {
    ServerScopedMachine,
    ServerScopedMachineGroup,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

type ServerScopedMachineSelectorProps = Readonly<{
    groups: ReadonlyArray<ServerScopedMachineGroup>;
    selectedMachineId: string | null;
    selectedServerId: string | null;
    onSelect: (machine: ServerScopedMachine) => void;
}>;

const emptyTextStyle = {
    ...Typography.default(),
    fontSize: 13,
    opacity: 0.8,
    paddingHorizontal: 16,
    paddingVertical: 8,
};

export function ServerScopedMachineSelector(props: ServerScopedMachineSelectorProps) {
    const { theme } = useUnistyles();

    return (
        <>
            {props.groups.map((group) => {
                const title = `${group.serverName} (${group.machines.length})`;
                return (
                    <ItemGroup key={group.serverId} title={title}>
                        {group.loading ? (
                            <View>
                                <Text style={[emptyTextStyle, { color: theme.colors.textSecondary }]}>
                                    {t('common.loading')}
                                </Text>
                            </View>
                        ) : null}
                        {!group.loading && group.signedOut ? (
                            <View>
                                <Text style={[emptyTextStyle, { color: theme.colors.textSecondary }]}>
                                    {t('server.signedOut')}
                                </Text>
                            </View>
                        ) : null}
                        {!group.loading && !group.signedOut && group.machines.length === 0 ? (
                            <View>
                                <Text style={[emptyTextStyle, { color: theme.colors.textSecondary }]}>
                                    {t('newSession.noMachinesFound')}
                                </Text>
                            </View>
                        ) : null}
                        {!group.loading && !group.signedOut
                            ? group.machines.map((machine) => {
                                const isSelected = props.selectedMachineId === machine.id
                                    && props.selectedServerId === group.serverId;
                                const online = isMachineOnline(machine);
                                return (
                                    <Item
                                        key={`${group.serverId}::${machine.id}`}
                                        title={machine.metadata?.displayName || machine.metadata?.host || machine.id}
                                        subtitle={machine.metadata?.host || machine.id}
                                        icon={<Ionicons name="desktop-outline" size={20} color={theme.colors.textSecondary} />}
                                        selected={isSelected}
                                        detail={online ? t('status.online') : t('status.offline')}
                                        onPress={() => props.onSelect(machine)}
                                    />
                                );
                            })
                            : null}
                    </ItemGroup>
                );
            })}
        </>
    );
}
