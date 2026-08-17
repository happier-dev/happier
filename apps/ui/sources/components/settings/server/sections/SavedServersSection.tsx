import * as React from 'react';
import { Platform } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { type ItemAction } from '@/components/ui/lists/itemActions';
import { useServerRetentionPolicies } from '@/hooks/server/useServerRetentionPolicies';
import { t } from '@/text';
import { formatSavedServerRetentionSummary } from '@/sync/domains/server/retention/formatServerRetentionPolicy';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { resolveServerProfileScopeId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';

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
    const retentionPoliciesByServerId = useServerRetentionPolicies(props.servers.map((profile) => resolveServerProfileScopeId(profile)));
    const supportsWholeRowPress = Platform.OS !== 'web';
    return (
        <ItemGroup title={t('server.savedServersTitle')}>
            {groups.map((group) => {
                const targetKey = `group:${group.id}`;
                const isSelected = props.activeTargetKey ? props.activeTargetKey === targetKey : false;
                const actions: ItemAction[] = [
                    {
                        id: 'switch',
                        title: t('server.switchToServer'),
                        icon: 'arrows-left-right',
                        onPress: () => props.onSwitchGroup?.(group),
                    },
                    {
                        id: 'rename',
                        title: t('common.rename'),
                        icon: 'pencil',
                        onPress: () => props.onRenameGroup?.(group),
                    },
                    {
                        id: 'remove',
                        title: t('common.remove'),
                        icon: 'trash',
                        destructive: true,
                        onPress: () => props.onRemoveGroup?.(group),
                    },
                ];
                  return (
                      <Item
                          key={targetKey}
                          title={group.name}
                          subtitle={t('server.serverCount', { count: group.serverIds.length })}
                          icon={<Icon name="stack" size={16} color={theme.colors.text.secondary} />}
                          selected={isSelected}
                          showChevron={false}
                          detail={isSelected ? t('server.active') : undefined}
                          onPress={supportsWholeRowPress ? () => props.onSwitchGroup?.(group) : undefined}
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
                const scopeId = resolveServerProfileScopeId(profile);
                const targetKey = `server:${scopeId}`;
                const isActive = props.activeTargetKey
                    ? props.activeTargetKey === targetKey
                    : scopeId === props.activeServerId || profile.id === props.activeServerId;
                const isDeviceDefault = typeof props.deviceDefaultServerId === 'string'
                    && props.deviceDefaultServerId.trim().length > 0
                    && (scopeId === props.deviceDefaultServerId || profile.id === props.deviceDefaultServerId);
                const authStatus = props.authStatusByServerId[scopeId]
                    ?? props.authStatusByServerId[profile.id]
                    ?? 'unknown';
                const statusLabel =
                    authStatus === 'signedIn'
                        ? t('server.signedIn')
                        : authStatus === 'signedOut'
                            ? t('server.signedOut')
                            : t('server.authStatusUnknown');
                const retentionSummary = isActive
                    ? null
                    : formatSavedServerRetentionSummary(
                        retentionPoliciesByServerId[scopeId] ?? retentionPoliciesByServerId[profile.id] ?? null,
                    );
                const subtitle = [toServerUrlDisplay(profile.serverUrl), statusLabel, retentionSummary]
                    .filter((value): value is string => Boolean(value))
                    .join('\n');
                const actions: ItemAction[] = Platform.OS === 'web'
                    ? [
                        {
                            id: 'switch-device',
                            title: t('server.makeDefaultOnDevice'),
                            icon: 'device-mobile',
                            inlineTestID: `saved-server-switch-${profile.id}`,
                            onPress: () => props.onSwitch(profile, 'device'),
                        },
                        {
                            id: 'rename',
                            title: t('common.rename'),
                            icon: 'pencil',
                            onPress: () => props.onRename(profile),
                        },
                        {
                            id: 'remove',
                            title: t('common.remove'),
                            icon: 'trash',
                            destructive: true,
                            onPress: () => props.onRemove(profile),
                        },
                    ]
                    : [
                        {
                            id: 'switch',
                            title: t('server.switchToServer'),
                            icon: 'arrows-left-right',
                            inlineTestID: `saved-server-switch-${profile.id}`,
                            onPress: () => props.onSwitch(profile, 'device'),
                        },
                        {
                            id: 'rename',
                            title: t('common.rename'),
                            icon: 'pencil',
                            onPress: () => props.onRename(profile),
                        },
                        {
                            id: 'remove',
                            title: t('common.remove'),
                            icon: 'trash',
                            destructive: true,
                            onPress: () => props.onRemove(profile),
                        },
                    ];

                return (
                    <Item
                        key={profile.id}
                        testID={`saved-server-row-${profile.id}`}
                        title={profile.name}
                        subtitle={subtitle}
                        subtitleLines={0}
                        icon={<Icon name="hard-drives" size={16} color={theme.colors.text.secondary} />}
                        selected={isActive}
                        showChevron={false}
                        detail={isActive ? t('server.active') : isDeviceDefault ? t('server.default') : undefined}
                        onPress={supportsWholeRowPress ? () => props.onSwitch(profile, 'device') : undefined}
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
