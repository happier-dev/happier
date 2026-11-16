import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { HomeMark } from '@/components/homes/HomeMark';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ITEM_ROW_ACTIONS_COMPACT_THRESHOLD_PX, type ItemAction } from '@/components/ui/lists/itemActions';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { t } from '@/text';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    resolveHomeTargetSummary,
    type HomeConnectionSummary,
} from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveHomeDisplayLabel, resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import {
    resolveCurrentHomeAttention,
    resolveHomeRowActions,
    type HomeRowMenuAction,
    type HomeRowPrimaryAction,
} from './homeRowActions';

type SavedServersSectionProps = Readonly<{
    servers: ReadonlyArray<ServerProfile>;
    serverGroups?: ReadonlyArray<ServerSelectionGroup>;
    activeServerId: string;
    deviceDefaultServerId?: string | null;
    activeGroupId?: string | null;
    authStatusByServerId: Record<string, 'signedIn' | 'signedOut' | 'unknown'>;
    homeConnectionSummaryByServerId?: Readonly<Record<string, HomeConnectionSummary>>;
    onSwitch: (profile: ServerProfile, scope?: 'tab' | 'device') => Promise<void> | void;
    onSignIn?: (profile: ServerProfile) => void;
    onRetry?: (profile: ServerProfile) => Promise<void> | void;
    onSwitchGroup?: (profile: ServerSelectionGroup) => Promise<void> | void;
    onEditGroupMembers?: (profile: ServerSelectionGroup) => void;
    onRenameGroup?: (profile: ServerSelectionGroup) => Promise<void> | void;
    onRemoveGroup?: (profile: ServerSelectionGroup) => Promise<void> | void;
    onRename: (profile: ServerProfile) => Promise<void> | void;
    onRemove: (profile: ServerProfile) => Promise<void> | void;
    /** Homes whose own answer admits this account to Home Administration (scope or profile ids). */
    administrableServerIds?: ReadonlySet<string>;
    onOpenAdministration?: (profile: ServerProfile) => void;
}>;

type HomeRowModel = Readonly<{
    profile: ServerProfile;
    label: string;
    accessibleName: string;
    isActive: boolean;
    isDeviceDefault: boolean;
    administrable: boolean;
    summary: HomeConnectionSummary;
}>;

const PRIMARY_ACTION_TEST_ID_PREFIX: Readonly<Record<HomeRowPrimaryAction, string>> = {
    switch: 'saved-server-switch',
    signIn: 'saved-server-sign-in',
    retry: 'saved-server-retry',
};

/**
 * The Homes this device knows: first the one it uses now ("This device uses"), with the page's one
 * banner when that Home needs sign-in or cannot be reached, then the other saved Homes and Home
 * groups. Each Home row offers the one action its real connection state needs; everything rarer is
 * in its `⋯` menu, which is the row's only control on a phone.
 */
export function SavedServersSection(props: SavedServersSectionProps) {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const compact = width < ITEM_ROW_ACTIONS_COMPACT_THRESHOLD_PX;
    const routineScope = resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost());
    const groups = Array.isArray(props.serverGroups) ? props.serverGroups : [];

    const rows = props.servers.map((profile): Omit<HomeRowModel, 'accessibleName'> => {
        const scopeId = resolveServerProfileScopeId(profile);
        const isActive = areServerProfileIdentifiersEquivalent(scopeId, props.activeServerId)
            || areServerProfileIdentifiersEquivalent(profile.id, props.activeServerId);
        const authStatus = props.authStatusByServerId[scopeId]
            ?? props.authStatusByServerId[profile.id]
            ?? 'unknown';
        const summary = props.homeConnectionSummaryByServerId?.[scopeId]
            ?? props.homeConnectionSummaryByServerId?.[profile.id]
            ?? resolveHomeTargetSummary({ authStatus });
        const isDeviceDefault = props.deviceDefaultServerId != null
            && areServerProfileIdentifiersEquivalent(scopeId, props.deviceDefaultServerId);
        return {
            profile,
            label: resolveHomeDisplayLabel(profile, profile.id, props.activeServerId),
            isActive,
            isDeviceDefault,
            administrable: props.onOpenAdministration != null && (
                props.administrableServerIds?.has(scopeId) === true
                || props.administrableServerIds?.has(profile.id) === true
            ),
            summary,
        };
    });
    const labelCounts = new Map<string, number>();
    for (const row of rows) {
        const key = row.label.trim().toLocaleLowerCase();
        labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
    }
    // Same-named Homes are told apart by address for assistive tech only; the visible row stays clean.
    const namedRows = rows.map((row): HomeRowModel => ({
        ...row,
        accessibleName: (labelCounts.get(row.label.trim().toLocaleLowerCase()) ?? 0) > 1
            ? `${row.label}, ${toServerUrlDisplay(row.profile.serverUrl)}`
            : row.label,
    }));
    const current = namedRows.find((row) => row.isActive) ?? null;
    const saved = namedRows.filter((row) => row !== current);
    const attention = current ? resolveCurrentHomeAttention(current.summary) : null;

    const renderHomeRow = (row: HomeRowModel) => {
        const { profile, accessibleName } = row;
        const unnamed = resolveHomeDisplayName(profile) === null;
        const { primary, menu } = resolveHomeRowActions({
            isCurrent: row.isActive,
            isDeviceDefault: row.isDeviceDefault,
            isUnnamed: unnamed,
            isWeb: Platform.OS === 'web',
            routineScope,
            summaryKind: row.summary.kind,
        });
        const statusLabel = t(row.summary.statusLabelKey);
        const homeFacts = [
            row.isActive ? t('server.homes.currentPill') : null,
            row.isDeviceDefault ? t('homesHub.opensFirst') : null,
        ].filter((value): value is string => value != null);
        // The current Home's pill and section already say it is in use here, so its line carries only
        // its state; "default" is said on a Home that is the default without being the current one.
        const visibleFacts = row.isActive ? [] : homeFacts;
        const primaryTitle = primary ? primaryActionTitle(primary) : null;
        const runPrimary = () => {
            if (primary === 'switch') return void props.onSwitch(profile);
            if (primary === 'signIn') return props.onSignIn?.(profile);
            if (primary === 'retry') return void props.onRetry?.(profile);
        };
        const menuActions: ItemAction[] = menu.map((id) => buildMenuAction(id, accessibleName, () => {
            if (id === 'switch') return void props.onSwitch(profile);
            if (id === 'switch-tab') return void props.onSwitch(profile, 'tab');
            if (id === 'switch-device') return void props.onSwitch(profile, 'device');
            if (id === 'rename') return void props.onRename(profile);
            return void props.onRemove(profile);
        }, id === 'rename' && unnamed ? t('server.homes.nameThisHome') : undefined));
        const administrationTitle = t('homeGovernance.title');
        const openAdministration = () => props.onOpenAdministration?.(profile);
        // A phone keeps one trailing control, so the row's action and its Home Administration entry
        // lead its `⋯` menu there.
        const overflowActions: ItemAction[] = compact
            ? [
                ...(primary && primaryTitle ? [{
                    id: primary,
                    title: primaryTitle,
                    accessibilityLabel: `${primaryTitle}: ${accessibleName}`,
                    icon: primary === 'switch' ? 'arrows-left-right' : primary === 'signIn' ? 'sign-in' : 'arrow-clockwise',
                    onPress: runPrimary,
                } satisfies ItemAction] : []),
                ...(row.administrable ? [{
                    id: 'administration',
                    title: administrationTitle,
                    accessibilityLabel: `${administrationTitle}: ${accessibleName}`,
                    icon: 'shield',
                    onPress: openAdministration,
                } satisfies ItemAction] : []),
                ...menuActions,
            ]
            : menuActions;

        return (
            <Item
                key={profile.id}
                testID={`saved-server-row-${profile.id}`}
                title={row.label}
                titleLines={1}
                titleEllipsizeMode="tail"
                titleAccessory={row.isActive ? (
                    <StatusPill testID="current-home-pill" variant="neutral" hideDot label={t('server.homes.currentPill')} />
                ) : undefined}
                subtitle={[statusLabel, ...visibleFacts].join(' · ')}
                subtitleLines={0}
                icon={<HomeMark serverUrl={profile.canonicalServerUrl ?? profile.serverUrl} />}
                selected={row.isActive}
                showChevron={false}
                accessibilityLabel={[accessibleName, statusLabel, homeFacts.join(' · ')].filter(Boolean).join(', ')}
                onPress={undefined}
                rightElement={(
                    <View style={styles.controls}>
                        {row.administrable && !compact ? (
                            // Entry only: the console is Home Administration's own destination.
                            <RoundButton
                                testID={`saved-server-administration-${profile.id}`}
                                size="small"
                                display="inverted"
                                title={administrationTitle}
                                accessibilityLabel={`${administrationTitle}: ${accessibleName}`}
                                leading={<Icon name="shield" size={14} color={theme.colors.text.secondary} />}
                                onPress={openAdministration}
                            />
                        ) : null}
                        {primary && primaryTitle && !compact ? (
                            <RoundButton
                                testID={`${PRIMARY_ACTION_TEST_ID_PREFIX[primary]}-${profile.id}`}
                                size="small"
                                display="secondary"
                                title={primaryTitle}
                                accessibilityLabel={`${primaryTitle}: ${accessibleName}`}
                                onPress={runPrimary}
                            />
                        ) : null}
                        <ItemRowActions
                            title={accessibleName}
                            actions={overflowActions}
                            // Every rarer action lives in the `⋯` menu, at every width.
                            compactThreshold={Number.POSITIVE_INFINITY}
                            compactActionIds={[]}
                        />
                    </View>
                )}
            />
        );
    };

    return (
        <>
            {current && attention ? (
                <AttentionBanner
                    testID="current-home-attention"
                    title={attention === 'signIn'
                        ? t('server.homes.signInAgainTitle', { name: current.label })
                        : t('server.homes.unavailableTitle', { name: current.label })}
                    description={attention === 'signIn'
                        ? t('server.homes.signInAgainDescription')
                        : t('server.homes.unavailableDescription')}
                    action={attention === 'signIn'
                        ? { label: t('connectionStatus.summary.signInAgain'), onPress: () => props.onSignIn?.(current.profile) }
                        : attention === 'retry'
                            ? { label: t('common.retry'), onPress: () => void props.onRetry?.(current.profile) }
                            : null}
                />
            ) : null}
            {current ? (
                <ItemGroup title={t('server.homes.currentTitle')}>
                    {renderHomeRow(current)}
                </ItemGroup>
            ) : null}
            {groups.length > 0 || saved.length > 0 ? (
                <ItemGroup title={t('server.savedServersTitle')} description={t('server.pageSections.savedDescription')}>
                    {groups.map((group) => {
                        const isSelected = props.activeGroupId === group.id;
                        const actions: ItemAction[] = [
                            {
                                id: 'switch',
                                title: t('server.switchToServer'),
                                accessibilityLabel: `${t('server.switchToServer')}: ${group.name}`,
                                icon: 'arrows-left-right',
                                onPress: () => props.onSwitchGroup?.(group),
                            },
                            {
                                id: 'edit-members',
                                title: t('server.multiServerView.editMembersAction'),
                                accessibilityLabel: `${t('server.multiServerView.editMembersAction')}: ${group.name}`,
                                icon: 'list',
                                onPress: () => props.onEditGroupMembers?.(group),
                            },
                            {
                                id: 'rename',
                                title: t('common.rename'),
                                accessibilityLabel: `${t('common.rename')}: ${group.name}`,
                                icon: 'pencil',
                                onPress: () => props.onRenameGroup?.(group),
                            },
                            {
                                id: 'remove',
                                title: t('common.remove'),
                                accessibilityLabel: `${t('common.remove')}: ${group.name}`,
                                icon: 'trash',
                                destructive: true,
                                onPress: () => props.onRemoveGroup?.(group),
                            },
                        ];
                        return (
                            <Item
                                key={group.id}
                                title={group.name}
                                subtitle={[
                                    t('server.serverCount', { count: group.serverIds.length }),
                                    isSelected ? t('server.active') : null,
                                ].filter(Boolean).join(' · ')}
                                icon={<Icon name="stack" size={16} color={theme.colors.text.secondary} />}
                                selected={isSelected}
                                showChevron={false}
                                onPress={undefined}
                                rightElement={(
                                    <ItemRowActions
                                        title={group.name}
                                        actions={actions}
                                        compactActionIds={[]}
                                    />
                                )}
                            />
                        );
                    })}
                    {saved.map(renderHomeRow)}
                </ItemGroup>
            ) : null}
        </>
    );
}

function primaryActionTitle(action: HomeRowPrimaryAction): string {
    if (action === 'switch') return t('server.homes.switch');
    if (action === 'signIn') return t('server.homes.signIn');
    return t('common.retry');
}

function buildMenuAction(id: HomeRowMenuAction, accessibleName: string, onPress: () => void, titleOverride?: string): ItemAction {
    const presentation = MENU_ACTION_PRESENTATION[id];
    const title = titleOverride ?? t(presentation.titleKey);
    return {
        id,
        title,
        accessibilityLabel: `${title}: ${accessibleName}`,
        icon: presentation.icon,
        ...(id === 'remove' ? { destructive: true } : {}),
        onPress,
    };
}

const MENU_ACTION_PRESENTATION = {
    switch: { titleKey: 'server.switchToServer', icon: 'arrows-left-right' },
    'switch-tab': { titleKey: 'server.switchForThisTab', icon: 'arrows-left-right' },
    'switch-device': { titleKey: 'server.makeDefaultOnDevice', icon: 'device-mobile' },
    rename: { titleKey: 'common.rename', icon: 'pencil' },
    remove: { titleKey: 'common.remove', icon: 'trash' },
} as const satisfies Readonly<Record<HomeRowMenuAction, Readonly<{ titleKey: string; icon: string }>>>;

const styles = StyleSheet.create({
    controls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
});
