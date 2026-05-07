import * as React from 'react';
import { Platform, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useSocketStatus, useSyncError, useLastSyncAt, useSettingMutable } from '@/sync/domains/state/storage';
import { getServerUrl } from '@/sync/domains/server/serverConfig';
import { getActiveServerId, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useRouter } from 'expo-router';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { Typography } from '@/constants/Typography';
import { listServerSelectionTargets } from '@/sync/domains/server/selection/serverSelectionResolver';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { normalizeStoredServerSelectionGroups } from '@/sync/domains/server/selection/serverSelectionMutations';
import { writeServerSelectionActiveTargetToServer } from '@/sync/domains/server/selection/serverSelectionActiveTarget';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { useConnectionTargetActions } from '@/components/navigation/connection/useConnectionTargetActions';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { Text } from '@/components/ui/text/Text';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { setPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';

type Variant = 'sidebar' | 'header';
const RELAY_SETTINGS_ROUTE = '/settings/server';
const RELAY_DROPDOWN_TARGET_THRESHOLD = 2;
const POPOVER_MAX_WIDTH = 420;
const POPOVER_MIN_WIDTH = 220;

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
        color: theme.colors.textSecondary,
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
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    popoverValue: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default(),
        flexShrink: 1,
        textAlign: 'right',
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
        color: theme.colors.textSecondary,
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

    const activeServerLabel = React.useMemo(() => {
        const active = servers.find((server) => server.id === activeServerId);
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
            for (const [id, status] of entries) next[id] = status;
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
        return listServerSelectionTargets({
            serverProfiles: servers,
            groupProfiles: normalizeStoredServerSelectionGroups(serverSelectionGroups),
        });
    }, [serverSelectionGroups, servers]);

    const resolvedTarget = React.useMemo(() => {
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId,
            availableServerIds: servers.map((server) => server.id),
            settings: {
                serverSelectionGroups,
                serverSelectionActiveTargetKind,
                serverSelectionActiveTargetId,
            },
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
            writeServerSelectionActiveTargetToServer({
                setServerSelectionActiveTargetKind,
                setServerSelectionActiveTargetId,
            }, target.serverId);
            await switchServer(target.serverId, 'device');
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

        if (nextServerId && nextServerId !== activeServerId) {
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
        iconColor: theme.colors.text,
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
                    <Ionicons
                        name={open ? "chevron-up" : "chevron-down"}
                        size={chevronSize}
                        color={connectionHealth.color}
                        style={styles.statusChevron}
                    />
                </Pressable>
                <Popover
                    open={open}
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
                                    <Text style={styles.popoverValue}>{t(connectionHealth.statusLabelKey)}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>{t('settings.machines')}</Text>
                                    <Text style={styles.popoverValue}>{t(connectionHealth.machineLabelKey)}</Text>
                                </View>

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

                                {activeSyncError?.nextRetryAt ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>{t('connectionStatus.labels.nextRetry')}</Text>
                                        <Text style={styles.popoverValue}>{formatTime(activeSyncError.nextRetryAt)}</Text>
                                    </View>
                                ) : null}

                                {activeSyncError ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>{t('connectionStatus.labels.lastError')}</Text>
                                        <Text style={styles.popoverValue} numberOfLines={3}>{activeSyncError.message}</Text>
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
                                                    <Ionicons name="settings-outline" size={18} color={theme.colors.textSecondary} />
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
            </View>

        </>
    );
});
