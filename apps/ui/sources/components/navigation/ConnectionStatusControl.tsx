import * as React from 'react';
import { Platform, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useAccountSettingsSyncStatus, useSocketStatus, useSyncError, useLastSyncAt, useSettingMutable } from '@/sync/domains/state/storage';
import { getServerUrl } from '@/sync/domains/server/serverConfig';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerId,
    getServerProfileById,
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useRouter } from 'expo-router';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { Typography } from '@/constants/Typography';
import { listServerSelectionTargets } from '@/sync/domains/server/selection/serverSelectionResolver';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { normalizeStoredServerSelectionGroups } from '@/sync/domains/server/selection/serverSelectionMutations';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { useConnectionTargetActions } from '@/components/navigation/connection/useConnectionTargetActions';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { Text } from '@/components/ui/text/Text';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { selectRelayDirectly } from '@/setup/directRelaySelectionIntent';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { sync } from '@/sync/sync';
import type { ConnectionHealthPresentation } from './connectionStatus/connectionHealthTypes';
import { ThisComputerStatusRow } from './connectionStatus/ThisComputerStatusRow';
import { isAccountSettingsSyncAttentionStatus } from '@/sync/domains/settings/accountSettingsSyncStatus';
import { Icon } from '@/components/ui/icons/Icon';
import { IconAction } from '@/components/ui/buttons/IconAction';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

type Variant = 'sidebar' | 'header';
const RELAY_SETTINGS_ROUTE = '/settings/server';
const RELAY_DROPDOWN_TARGET_THRESHOLD = 2;
const POPOVER_MAX_WIDTH = 420;
const POPOVER_MIN_WIDTH = 220;

function resolveConnectionHealthStatusPillVariant(tone: ConnectionHealthPresentation['tone']): StatusPillVariant {
    switch (tone) {
        case 'positive':
            return 'success';
        case 'attention':
            return 'warning';
        case 'danger':
            return 'danger';
        case 'neutral':
            return 'info';
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
        zIndex: 2000,
        overflow: 'visible',
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
        flexWrap: 'nowrap' as const,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'visible',
    },
    statusText: {
        lineHeight: 16,
        ...Typography.default(),
        flexGrow: 0,
        flexShrink: 1,
        minWidth: 0,
    },
    statusChevron: {
        marginLeft: 2,
        marginTop: 1,
        opacity: 0.9,
    },
    popoverTitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
        marginBottom: 8,
        paddingHorizontal: 16,
        paddingTop: 6,
        textTransform: 'uppercase',
    },
    popoverRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 6,
        paddingHorizontal: 16,
    },
    popoverLabel: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    popoverValue: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default(),
        flexShrink: 1,
        textAlign: 'right',
    },
    popoverStatusPill: {
        flexShrink: 0,
    },
    popoverStatusActions: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 6,
        flexShrink: 0,
    },
    popoverRetryBusy: {
        // An active operation still needs full-contrast feedback while its action is disabled.
        opacity: 1,
    },
    popoverSection: {
        paddingHorizontal: 16,
        paddingTop: 8,
        gap: 0,
    },
    popoverSectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    popoverSectionTitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
        textTransform: 'uppercase',
    },
    popoverSectionIconButton: {
        width: 24,
        height: 24,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    popoverRelayBlock: {
        marginBottom: 12,
    },
    popoverRelayActionList: {
        paddingTop: 0,
        paddingBottom: 0,
    },
}));

function formatTime(ts: number | null): string {
    if (!ts) return '—';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '—';
    }
}

function markTauriSignedOutServerSwitchForAuth(serverUrl: string): void {
    if (!isTauriDesktop()) return;
    setPendingSetupIntent({
        branch: 'thisComputer',
        phase: 'awaiting_auth',
        relayUrl: serverUrl,
    });
}

export const ConnectionStatusControl = React.memo(function ConnectionStatusControl(props: {
    variant: Variant;
    textSize?: number;
    dotSize?: number;
    chevronSize?: number;
    alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline';
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const auth = useAuth();
    const socketStatus = useSocketStatus();
    const syncError = useSyncError();
    const accountSettingsSyncStatus = useAccountSettingsSyncStatus();
    const lastSyncAt = useLastSyncAt();
    const connectionHealth = useConnectionHealth();
    const [serverSelectionGroups] = useSettingMutable('serverSelectionGroups');
    const [serverSelectionActiveTargetKind, setServerSelectionActiveTargetKind] = useSettingMutable('serverSelectionActiveTargetKind');
    const [serverSelectionActiveTargetId, setServerSelectionActiveTargetId] = useSettingMutable('serverSelectionActiveTargetId');

    const [open, setOpen] = React.useState(false);
    const [relayDropdownOpen, setRelayDropdownOpen] = React.useState(false);
    const anchorRef = React.useRef<React.ElementRef<typeof View> | null>(null);
    const [authStatusByServerId, setAuthStatusByServerId] = React.useState<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>({});

    const textSize = props.textSize ?? (props.variant === 'sidebar' ? 11 : 12);
    const dotSize = props.dotSize ?? 6;
    const chevronSize = props.chevronSize ?? 8;

    const servers = React.useMemo(() => {
        try {
            return listServerProfiles()
                .slice();
        } catch {
            return [];
        }
    }, [open]);

    const activeServerId = React.useMemo(() => {
        try {
            return getActiveServerId();
        } catch {
            return '';
        }
    }, [open]);
    const activeSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, activeServerId);
    }, [activeServerId, syncError]);
    const activeAccountSettingsSyncIssue = isAccountSettingsSyncAttentionStatus(accountSettingsSyncStatus)
        ? accountSettingsSyncStatus
        : null;
    const primarySyncIssue = activeAccountSettingsSyncIssue?.kind === 'auth'
        ? activeAccountSettingsSyncIssue
        : activeSyncError ?? activeAccountSettingsSyncIssue;

    const activeServerLabel = React.useMemo(() => {
        const active = getServerProfileById(activeServerId) ?? servers.find((server) => server.id === activeServerId);
        const name = String(active?.name ?? '').trim();
        if (name) return name;
        return toServerUrlDisplay(getServerUrl()) || t('status.connected');
    }, [activeServerId, servers]);

    React.useEffect(() => {
        let cancelled = false;
        fireAndForget((async () => {
            const entries = await Promise.all(servers.map(async (profile) => {
                try {
                    const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                    return [profile.id, creds ? 'signedIn' : 'signedOut'] as const;
                } catch {
                    return [profile.id, 'unknown'] as const;
                }
            }));
            if (cancelled) return;
            const next: Record<string, 'signedIn' | 'signedOut' | 'unknown'> = {};
            for (const [id, status] of entries) {
                next[id] = status;
                const server = servers.find((profile) => profile.id === id);
                if (server) next[resolveServerProfileScopeId(server)] = status;
            }
            setAuthStatusByServerId(next);
        })(), { tag: 'ConnectionStatusControl.loadAuthStatusByServerId' });
        return () => {
            cancelled = true;
        };
    }, [servers]);

    const switchServer = React.useCallback(async (serverId: string, scope: 'tab' | 'device' = 'device') => {
        await setActiveServerAndSwitch({
            serverId,
            scope,
            refreshAuth: auth.refreshFromActiveServer,
        });
        setOpen(false);
    }, [auth]);

    const serverTargets = React.useMemo(() => {
        const normalizedGroups = normalizeStoredServerSelectionGroups(
            normalizeServerSelectionSettingsForProfileScopeIds({
                serverSelectionGroups,
                serverSelectionActiveTargetKind,
                serverSelectionActiveTargetId,
            }, servers).serverSelectionGroups,
        );
        return listServerSelectionTargets({
            serverProfiles: servers.map((server) => ({
                ...server,
                id: resolveServerProfileScopeId(server),
            })),
            groupProfiles: normalizedGroups,
        });
    }, [serverSelectionActiveTargetId, serverSelectionActiveTargetKind, serverSelectionGroups, servers]);

    const resolvedTarget = React.useMemo(() => {
        const settings = normalizeServerSelectionSettingsForProfileScopeIds({
            serverSelectionGroups,
            serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId,
        }, servers);
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId,
            availableServerIds: listServerProfileScopeIds(servers),
            settings,
        });
    }, [
        activeServerId,
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        servers,
    ]);

    const activeTargetKey = React.useMemo(() => {
        return `${resolvedTarget.activeTarget.kind}:${resolvedTarget.activeTarget.id}`;
    }, [resolvedTarget.activeTarget.id, resolvedTarget.activeTarget.kind]);

    const serverById = React.useMemo(() => {
        const map = new Map<string, (typeof servers)[number]>();
        for (const server of servers) {
            map.set(server.id, server);
            map.set(resolveServerProfileScopeId(server), server);
        }
        return map;
    }, [servers]);

    const switchTarget = React.useCallback(async (target: (typeof serverTargets)[number]) => {
        const confirmSignedOutSwitch = async (serverId: string): Promise<boolean> => {
            let status = authStatusByServerId[serverId] ?? 'unknown';
            if (status === 'unknown') {
                const profile = serverById.get(serverId);
                if (profile) {
                    try {
                        const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                        status = creds ? 'signedIn' : 'signedOut';
                    } catch {
                        status = 'unknown';
                    }
                }
            }
            if (status !== 'signedOut') return true;
            const shouldContinue = await promptSignedOutServerSwitchConfirmation();
            return shouldContinue;
        };

        if (target.kind === 'server') {
            const server = serverById.get(target.serverId);
            if (!server) return;
            const shouldSwitch = await confirmSignedOutSwitch(server.id);
            if (!shouldSwitch) return;
            // R8/INV7 — the direct Relay/Home pick: the one direct-selection operation arms the
            // intent the setup gate spends to offer moving this computer's background service,
            // then switches. The group branch below records nothing: a group names several relays
            // and cannot name one daemon target (B2).
            await selectRelayDirectly({
                serverId: target.serverId,
                selectionTarget: { setServerSelectionActiveTargetKind, setServerSelectionActiveTargetId },
                refreshAuth: auth.refreshFromActiveServer,
            });
            setOpen(false);
            if ((authStatusByServerId[target.serverId] ?? 'unknown') === 'signedOut') {
                markTauriSignedOutServerSwitchForAuth(server.serverUrl);
                router.replace('/');
            }
            return;
        }

        const nextServerId = target.serverIds.includes(activeServerId) ? activeServerId : (target.serverIds[0] ?? '');
        if (nextServerId) {
            const shouldSwitch = await confirmSignedOutSwitch(nextServerId);
            if (!shouldSwitch) return;
        }

        setServerSelectionActiveTargetKind('group');
        setServerSelectionActiveTargetId(target.groupId);

        if (nextServerId && !areServerProfileIdentifiersEquivalent(nextServerId, activeServerId)) {
            await switchServer(nextServerId, 'device');
        }
        if (nextServerId && (authStatusByServerId[nextServerId] ?? 'unknown') === 'signedOut') {
            const nextServer = serverById.get(nextServerId);
            if (nextServer) markTauriSignedOutServerSwitchForAuth(nextServer.serverUrl);
            router.replace('/');
            return;
        }
        setOpen(false);
    }, [
        activeServerId,
        auth,
        authStatusByServerId,
        router,
        setServerSelectionActiveTargetId,
        setServerSelectionActiveTargetKind,
        serverById,
        switchServer,
    ]);
    const targetActions = useConnectionTargetActions({
        targets: serverTargets,
        activeTargetKey,
        onSelectTarget: (target) => {
            void switchTarget(target);
        },
        selectedColor: theme.colors.status.connected,
        iconColor: theme.colors.text.primary,
    });

    const relayDropdownItems = React.useMemo<ReadonlyArray<DropdownMenuItem>>(() => {
        return targetActions.map((action) => ({
            id: action.id,
            title: action.label,
            subtitle: action.subtitle,
            icon: action.icon,
            rightElement: action.right,
            disabled: action.disabled,
        }));
    }, [targetActions]);

    const selectedRelayDropdownId = React.useMemo(() => {
        return targetActions.find((action) => action.selected)?.id ?? null;
    }, [targetActions]);
    const canRetryServerConnection =
        connectionHealth.kind === 'connecting'
        || connectionHealth.kind === 'server_unreachable'
        || connectionHealth.kind === 'server_error'
        || connectionHealth.kind === 'server_restarting';
    const isRetrying = connectionHealth.endpointStatus === 'connecting' || socketStatus.status === 'connecting';
    const nextRetryAt = connectionHealth.nextRetryAt ?? primarySyncIssue?.nextRetryAt;
    const handleRetryConnection = React.useCallback(() => {
        sync.retryNow();
    }, []);

    const targetActionById = React.useMemo(() => {
        return new Map(targetActions.map((action) => [action.id, action] as const));
    }, [targetActions]);

    const handleManageRelay = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push(RELAY_SETTINGS_ROUTE));
        if (result !== true) {
            fireAndForget(result, { tag: 'ConnectionStatusControl.nav.manageRelay' });
        }
        setRelayDropdownOpen(false);
        setOpen(false);
    }, [router]);

    const shouldUseRelayDropdown = targetActions.length > RELAY_DROPDOWN_TARGET_THRESHOLD;
    const popoverMinWidth = props.variant === 'sidebar' && Platform.OS === 'web' ? POPOVER_MIN_WIDTH : undefined;

    return (
        <>
            {/* Use a View wrapper for the anchor ref (stable, measurable). */}
            <View
                style={[styles.container, props.alignSelf ? { alignSelf: props.alignSelf } : null]}
                ref={anchorRef}
                collapsable={false}
            >
                <Pressable
                    style={styles.statusContainer}
                    onPress={() => setOpen((currentOpen) => !currentOpen)}
                    accessibilityRole="button"
                >
                    <StatusDot
                        color={connectionHealth.color}
                        isPulsing={connectionHealth.isPulsing}
                        size={dotSize}
                        style={{ marginRight: 4 }}
                    />
                    <Text
                        style={[styles.statusText, { color: connectionHealth.color, fontSize: textSize }]}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                    >
                        {activeServerLabel}
                    </Text>
                    <Icon
                        name={open ? "caret-up" : "caret-down"}
                        size={chevronSize}
                        color={connectionHealth.color}
                        style={styles.statusChevron}
                    />
                </Pressable>
                {open ? (
                    <Popover
                        open={true}
                        anchorRef={anchorRef}
                        placement="bottom"
                        edgePadding={{ horizontal: 12, vertical: 12 }}
                        portal={{
                            web: true,
                            native: true,
                            matchAnchorWidth: false,
                            anchorAlign: 'center',
                        }}
                        maxWidthCap={POPOVER_MAX_WIDTH}
                        maxHeightCap={520}
                        onRequestClose={() => {
                            setRelayDropdownOpen(false);
                            setOpen(false);
                        }}
                    >
                        {({ maxHeight }) => (
                            <FloatingOverlay
                                maxHeight={Math.max(220, Math.min(maxHeight, 520))}
                                keyboardShouldPersistTaps="always"
                                edgeFades={{ top: true, bottom: true, size: 18 }}
                                edgeIndicators={true}
                                containerStyle={popoverMinWidth ? { minWidth: popoverMinWidth } : null}
                            >
                            <View style={{ paddingTop: 8 }}>
                                <Text style={styles.popoverTitle}>{t('connectionStatus.title')}</Text>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>{t('profile.status')}</Text>
                                    <View style={styles.popoverStatusActions}>
                                        {canRetryServerConnection ? (
                                            <IconAction
                                                testID="connection-popover-retry"
                                                accessibilityRole="button"
                                                accessibilityLabel={t(isRetrying ? 'status.connecting' : 'common.retry')}
                                                accessibilityState={{ busy: isRetrying, disabled: isRetrying }}
                                                disabled={isRetrying}
                                                style={isRetrying ? styles.popoverRetryBusy : undefined}
                                                size="sm"
                                                hitSlop={10}
                                                onPress={handleRetryConnection}
                                            >
                                                {isRetrying ? (
                                                    <ActivitySpinner
                                                        testID="connection-popover-retry-progress"
                                                        size={16}
                                                        color={theme.colors.text.secondary}
                                                    />
                                                ) : (
                                                    <Icon
                                                        name="arrow-clockwise"
                                                        size={16}
                                                        color={theme.colors.text.secondary}
                                                    />
                                                )}
                                            </IconAction>
                                        ) : null}
                                        <StatusPill
                                            testID="connection-popover-health-status"
                                            variant={resolveConnectionHealthStatusPillVariant(connectionHealth.tone)}
                                            label={t(connectionHealth.statusLabelKey)}
                                            style={styles.popoverStatusPill}
                                        />
                                    </View>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>{t('settings.machines')}</Text>
                                    <Text style={styles.popoverValue}>{t(connectionHealth.machineLabelKey)}</Text>
                                </View>

                                {isTauriDesktop() ? (
                                    <ThisComputerStatusRow
                                        rowStyle={styles.popoverRow}
                                        labelStyle={styles.popoverLabel}
                                        valueStyle={styles.popoverValue}
                                        actionListStyle={styles.popoverRelayActionList}
                                    />
                                ) : null}

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>{t('connectionStatus.labels.server')}</Text>
                                    <Text style={styles.popoverValue} numberOfLines={2}>{toServerUrlDisplay(getServerUrl())}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>{t('connectionStatus.labels.socket')}</Text>
                                    <Text style={styles.popoverValue}>{socketStatus.status}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>{t('connectionStatus.labels.authenticated')}</Text>
                                    <Text style={styles.popoverValue}>{auth.isAuthenticated ? t('common.yes') : t('common.no')}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>{t('connectionStatus.labels.lastSync')}</Text>
                                    <Text style={styles.popoverValue}>{formatTime(lastSyncAt)}</Text>
                                </View>

                                {nextRetryAt ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>{t('connectionStatus.labels.nextRetry')}</Text>
                                        <Text testID="connection-popover-next-retry" style={styles.popoverValue}>
                                            {formatTime(nextRetryAt)}
                                        </Text>
                                    </View>
                                ) : null}

                                {primarySyncIssue ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>{t('connectionStatus.labels.lastError')}</Text>
                                        <Text style={styles.popoverValue} numberOfLines={3}>
                                            {primarySyncIssue.message}
                                        </Text>
                                    </View>
                                ) : null}

                                {targetActions.length > 0 ? (
                                    <View style={styles.popoverRelayBlock}>
                                        <View style={styles.popoverSection}>
                                            <View style={styles.popoverSectionHeader}>
                                                <Text style={styles.popoverSectionTitle}>{t('server.changeServer')}</Text>
                                                <Pressable
                                                    testID="connection-popover-relay-settings"
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('server.changeServer')}
                                                    onPress={handleManageRelay}
                                                    style={styles.popoverSectionIconButton}
                                                >
                                                    <Icon name="sliders-horizontal" size={16} color={theme.colors.text.secondary} />
                                                </Pressable>
                                            </View>
                                        </View>

                                        {shouldUseRelayDropdown ? (
                                            <DropdownMenu
                                                open={relayDropdownOpen}
                                                onOpenChange={setRelayDropdownOpen}
                                                items={relayDropdownItems}
                                                selectedId={selectedRelayDropdownId}
                                                onSelect={(itemId) => {
                                                    targetActionById.get(itemId)?.onPress();
                                                }}
                                                variant="default"
                                                rowKind="item"
                                                matchTriggerWidth={true}
                                                connectToTrigger={true}
                                                itemTrigger={{
                                                    title: activeServerLabel,
                                                    subtitle: toServerUrlDisplay(getServerUrl()),
                                                    showSelectedDetail: false,
                                                    showSelectedSubtitle: false,
                                                }}
                                                maxWidthCap={480}
                                            />
                                        ) : (
                                            <ActionListSection
                                                actions={targetActions}
                                                style={styles.popoverRelayActionList}
                                            />
                                        )}
                                    </View>
                                ) : null}

                            </View>
                            </FloatingOverlay>
                        )}
                    </Popover>
                ) : null}
            </View>

        </>
    );
});
