import * as React from 'react';
import { Platform } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { type ItemAction } from '@/components/ui/lists/itemActions';
import { t } from '@/text';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

type SavedServersSectionProps = Readonly<{
    servers: ReadonlyArray<ServerProfile>;
    serverGroups?: ReadonlyArray<ServerSelectionGroup>;
    activeServerId: string;
    deviceDefaultServerId?: string | null;
    activeTargetKey?: string | null;
    authStatusByServerId: Record<string, 'signedIn' | 'signedOut' | 'unknown'>;
    onSwitch: (profile: ServerProfile, scope?: 'tab' | 'device') => Promise<void> | void;
    onSwitchGroup?: (profile: ServerSelectionGroup) => Promise<void> | void;
    onRenameGroup?: (profile: ServerSelectionGroup) => Promise<void> | void;
    onRemoveGroup?: (profile: ServerSelectionGroup) => Promise<void> | void;
    onRename: (profile: ServerProfile) => Promise<void> | void;
    onRemove: (profile: ServerProfile) => Promise<void> | void;
}>;

export function SavedServersSection(props: SavedServersSectionProps) {
    const { theme } = useUnistyles();
    const groups = Array.isArray(props.serverGroups) ? props.serverGroups : [];
    return (
        <ItemGroup title={t('server.savedServersTitle')}>
            {groups.map((group) => {
                const targetKey = `group:${group.id}`;
                const isSelected = props.activeTargetKey ? props.activeTargetKey === targetKey : false;
                const actions: ItemAction[] = [
                    {
                        id: 'switch',
                        title: t('server.switchToServer'),
                        icon: 'swap-horizontal-outline',
                        onPress: () => props.onSwitchGroup?.(group),
                    },
                    {
                        id: 'rename',
                        title: t('common.rename'),
                        icon: 'pencil-outline',
                        onPress: () => props.onRenameGroup?.(group),
                    },
                    {
                        id: 'remove',
                        title: t('common.remove'),
                        icon: 'trash-outline',
                        destructive: true,
                        onPress: () => props.onRemoveGroup?.(group),
                    },
                ];
                return (
                    <Item
                        key={targetKey}
                        title={group.name}
                        subtitle={`${group.serverIds.length} server${group.serverIds.length === 1 ? '' : 's'}`}
                        icon={<Ionicons name="albums-outline" size={18} color={theme.colors.textSecondary} />}
                        selected={isSelected}
                        showChevron={false}
                        detail={isSelected ? t('server.active') : undefined}
                        onPress={() => props.onSwitchGroup?.(group)}
                        rightElement={(
                            <ItemRowActions
                                title={group.name}
                                actions={actions}
                                compactActionIds={['switch']}
                                pinnedActionIds={['switch']}
                                overflowPosition="beforePinned"
                            />
                        )}
                    />
                );
            })}
            {props.servers.map((profile) => {
                const targetKey = `server:${profile.id}`;
                const isActive = props.activeTargetKey
                    ? props.activeTargetKey === targetKey
                    : profile.id === props.activeServerId;
                const isDeviceDefault = typeof props.deviceDefaultServerId === 'string'
                    && props.deviceDefaultServerId.trim().length > 0
                    && profile.id === props.deviceDefaultServerId;
                const authStatus = props.authStatusByServerId[profile.id] ?? 'unknown';
                const statusLabel =
                    authStatus === 'signedIn'
                        ? t('server.signedIn')
                        : authStatus === 'signedOut'
                            ? t('server.signedOut')
                            : t('server.authStatusUnknown');
                const subtitle = `${toServerUrlDisplay(profile.serverUrl)}\n${statusLabel}`;
                const actions: ItemAction[] = Platform.OS === 'web'
                    ? [
                        {
                            id: 'switch-device',
                            title: t('server.makeDefaultOnDevice'),
                            icon: 'phone-portrait-outline',
                            onPress: () => props.onSwitch(profile, 'device'),
                        },
                        {
                            id: 'rename',
                            title: t('common.rename'),
                            icon: 'pencil-outline',
                            onPress: () => props.onRename(profile),
                        },
                        {
                            id: 'remove',
                            title: t('common.remove'),
                            icon: 'trash-outline',
                            destructive: true,
                            onPress: () => props.onRemove(profile),
                        },
                    ]
                    : [
                        {
                            id: 'switch',
                            title: t('server.switchToServer'),
                            icon: 'swap-horizontal-outline',
                            onPress: () => props.onSwitch(profile, 'device'),
                        },
                        {
                            id: 'rename',
                            title: t('common.rename'),
                            icon: 'pencil-outline',
                            onPress: () => props.onRename(profile),
                        },
                        {
                            id: 'remove',
                            title: t('common.remove'),
                            icon: 'trash-outline',
                            destructive: true,
                            onPress: () => props.onRemove(profile),
                        },
                    ];

                return (
                    <Item
                        key={profile.id}
                        title={profile.name}
                        subtitle={subtitle}
                        subtitleLines={0}
                        icon={<Ionicons name="server-outline" size={18} color={theme.colors.textSecondary} />}
                        selected={isActive}
                        showChevron={false}
                        detail={isActive ? t('server.active') : isDeviceDefault ? t('server.default') : undefined}
                        onPress={() => props.onSwitch(profile, 'device')}
                        rightElement={(
                            <ItemRowActions
                                title={profile.name}
                                actions={actions}
                                compactActionIds={Platform.OS === 'web' ? ['switch-device'] : ['switch']}
                                pinnedActionIds={Platform.OS === 'web' ? ['switch-device'] : ['switch']}
                                overflowPosition="beforePinned"
                            />
                        )}
                    />
                );
            })}
        </ItemGroup>
    );
}
