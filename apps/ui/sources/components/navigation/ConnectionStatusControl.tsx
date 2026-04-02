import * as React from 'react';
import { View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t, type TranslationKeyNoParams } from '@/text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useSocketStatus, useSyncError, useLastSyncAt, useSettingMutable } from '@/sync/domains/state/storage';
import { getServerUrl } from '@/sync/domains/server/serverConfig';
import { getActiveServerId, listServerProfiles, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { useAuth } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useRouter } from 'expo-router';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { Typography } from '@/constants/Typography';
import { listServerSelectionTargets } from '@/sync/domains/server/selection/serverSelectionResolver';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { normalizeStoredServerSelectionGroups } from '@/sync/domains/server/selection/serverSelectionMutations';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { useConnectionTargetActions } from '@/components/navigation/connection/useConnectionTargetActions';
import { ConnectionTargetList } from '@/components/navigation/connection/ConnectionTargetList';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { Text } from '@/components/ui/text/Text';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { resolveMachineConnectionSummary } from '@/components/navigation/connectionStatus/resolveMachineConnectionSummary';

type Variant = 'sidebar' | 'header';

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
    popoverContent: {
        paddingTop: 8,
        paddingBottom: 6,
    },
    popoverHeader: {
        paddingHorizontal: 16,
        paddingBottom: 8,
    },
    popoverTitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
        textTransform: 'uppercase',
    },
    popoverStatusList: {
        paddingHorizontal: 12,
        gap: 10,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 14,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderWidth: 1,
        backgroundColor: theme.colors.surfaceHigh,
        borderColor: theme.colors.divider,
    },
    statusRowLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flexShrink: 1,
        minWidth: 0,
    },
    statusRowIcon: {
        width: 28,
        height: 28,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    statusRowText: {
        flexShrink: 1,
        minWidth: 0,
    },
    statusRowTitle: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        lineHeight: 16,
    },
    statusRowSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        lineHeight: 16,
        marginTop: 2,
    },
    statusRowRight: {
        marginLeft: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    statusRowStatusText: {
        fontSize: 12,
        ...Typography.default('semiBold'),
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

function resolveStatusPresentation(
    theme: { colors: { status: Record<string, string> } },
    status: 'connected' | 'connecting' | 'disconnected' | 'error' | 'action_required' | 'unknown',
): { labelKey: TranslationKeyNoParams; color: string; dotColor: string } {
    switch (status) {
        case 'connected':
            return { labelKey: 'status.connected', color: theme.colors.status.connected, dotColor: theme.colors.status.connected };
        case 'connecting':
            return { labelKey: 'status.connecting', color: theme.colors.status.connecting, dotColor: theme.colors.status.connecting };
        case 'action_required':
            return { labelKey: 'status.actionRequired', color: theme.colors.status.actionRequired, dotColor: theme.colors.status.actionRequired };
        case 'error':
            return { labelKey: 'status.error', color: theme.colors.status.error, dotColor: theme.colors.status.error };
        case 'disconnected':
            return { labelKey: 'status.disconnected', color: theme.colors.status.disconnected, dotColor: theme.colors.status.disconnected };
        default:
            return { labelKey: 'status.unknown', color: theme.colors.status.default, dotColor: theme.colors.status.default };
    }
}

function resolveEndpointStatusKey(endpointStatus: unknown): 'connected' | 'connecting' | 'disconnected' | 'action_required' | 'unknown' {
    switch (endpointStatus) {
        case 'online':
            return 'connected';
        case 'connecting':
            return 'connecting';
        case 'auth_failed':
            return 'action_required';
        case 'offline':
        case 'shutting_down':
            return 'disconnected';
        default:
            return 'unknown';
    }
}

function resolveSocketStatusKey(socketStatus: unknown): 'connected' | 'connecting' | 'disconnected' | 'error' | 'unknown' {
    switch (socketStatus) {
        case 'connected':
            return 'connected';
        case 'connecting':
            return 'connecting';
        case 'error':
            return 'error';
        case 'disconnected':
            return 'disconnected';
        default:
            return 'unknown';
    }
}

const ConnectionPopoverStatusRow = React.memo(function ConnectionPopoverStatusRow(props: Readonly<{
    testID: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    title: string;
    subtitle: string;
    statusLabel: string;
    statusColor: string;
    dotColor: string;
}>) {
    const styles = stylesheet;
    return (
        <View style={styles.statusRow} testID={props.testID}>
            <View style={styles.statusRowLeft}>
                <View style={styles.statusRowIcon}>
                    <Ionicons name={props.icon} size={16} color={props.dotColor} />
                </View>
                <View style={styles.statusRowText}>
                    <Text style={styles.statusRowTitle} numberOfLines={1}>
                        {props.title}
                    </Text>
                    <Text style={styles.statusRowSubtitle} numberOfLines={1} ellipsizeMode="tail">
                        {props.subtitle}
                    </Text>
                </View>
            </View>
            <View style={{ flex: 1 }} />
            <View style={styles.statusRowRight}>
                <StatusDot color={props.dotColor} size={6} isPulsing={false} />
                <Text style={[styles.statusRowStatusText, { color: props.statusColor }]} numberOfLines={1}>
                    {props.statusLabel}
                </Text>
            </View>
        </View>
    );
});

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
                    const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
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
        setActiveServerId(serverId, { scope });
        setOpen(false);
        await switchConnectionToActiveServer();
        await auth.refreshFromActiveServer();
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
                        const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
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
            setServerSelectionActiveTargetKind('server');
            setServerSelectionActiveTargetId(target.id);
            await switchServer(target.serverId, 'device');
            if ((authStatusByServerId[target.serverId] ?? 'unknown') === 'signedOut') {
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
                    maxWidthCap={320}
                    maxHeightCap={520}
                    onRequestClose={() => setOpen(false)}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay
                            maxHeight={Math.max(220, Math.min(maxHeight, 520))}
                            keyboardShouldPersistTaps="always"
                            edgeFades={{ top: true, bottom: true, size: 18 }}
                                edgeIndicators={true}
                        >
                            <View style={styles.popoverContent}>
                                <View style={styles.popoverHeader}>
                                    <Text style={styles.popoverTitle}>{t('connectionStatus.title')}</Text>
                                </View>

                                {(() => {
                                    const endpointPresentation = resolveStatusPresentation(
                                        theme,
                                        resolveEndpointStatusKey((connectionHealth as any).endpointStatus),
                                    );
                                    const socketPresentation = resolveStatusPresentation(
                                        theme,
                                        resolveSocketStatusKey(socketStatus.status),
                                    );
                                    const machineCount = typeof (connectionHealth as any).machineCount === 'number'
                                        ? (connectionHealth as any).machineCount as number
                                        : 0;
                                    const onlineCount = typeof (connectionHealth as any).onlineCount === 'number'
                                        ? (connectionHealth as any).onlineCount as number
                                        : 0;
                                    const hasUnknownMachines = Boolean((connectionHealth as any).hasUnknownMachines);
                                    const primaryMachineLabel =
                                        typeof (connectionHealth as any).primaryMachineLabel === 'string'
                                            ? (connectionHealth as any).primaryMachineLabel as string
                                            : null;
                                    const machineSummary = resolveMachineConnectionSummary({
                                        machineCount,
                                        onlineCount,
                                        hasUnknownMachines,
                                        primaryMachineLabel,
                                    });

                                    const machineSubtitle = (() => {
                                        switch (machineSummary.kind) {
                                            case 'unknown':
                                                return t('status.unknown');
                                            case 'none':
                                                return t('systemStatus.machines.none');
                                            case 'single':
                                                return machineSummary.label;
                                            case 'multiple':
                                                if (machineSummary.offlineCount === 0) {
                                                    return `${machineSummary.onlineCount} ${t('status.online')}`;
                                                }
                                                return `${machineSummary.onlineCount} ${t('status.online')} · ${machineSummary.offlineCount} ${t('status.offline')}`;
                                        }
                                    })();

                                    const machinesPresentation = resolveStatusPresentation(
                                        theme,
                                        connectionHealth.kind === 'healthy'
                                            ? 'connected'
                                            : connectionHealth.kind === 'connecting'
                                              ? 'connecting'
                                              : connectionHealth.kind === 'server_error'
                                                ? 'error'
                                                : connectionHealth.kind === 'server_unreachable'
                                                  ? 'disconnected'
                                                  : connectionHealth.kind === 'auth_required'
                                                    ? 'action_required'
                                                    : connectionHealth.kind === 'no_machine'
                                                      ? 'action_required'
                                                      : connectionHealth.kind === 'machine_offline'
                                                        ? 'action_required'
                                                        : connectionHealth.kind === 'machine_not_ready'
                                                          ? 'action_required'
                                                          : 'unknown',
                                    );

                                    return (
                                        <View style={styles.popoverStatusList}>
                                            <ConnectionPopoverStatusRow
                                                testID="connection-popover-relay"
                                                icon="server-outline"
                                                title={t('systemStatus.server.activeServer')}
                                                subtitle={toServerUrlDisplay(getServerUrl())}
                                                statusLabel={t(endpointPresentation.labelKey)}
                                                statusColor={endpointPresentation.color}
                                                dotColor={endpointPresentation.dotColor}
                                            />
                                            <ConnectionPopoverStatusRow
                                                testID="connection-popover-realtime"
                                                icon="pulse-outline"
                                                title={t('systemStatus.ui.realtime')}
                                                subtitle={t('systemStatus.ui.socket')}
                                                statusLabel={t(socketPresentation.labelKey)}
                                                statusColor={socketPresentation.color}
                                                dotColor={socketPresentation.dotColor}
                                            />
                                            <ConnectionPopoverStatusRow
                                                testID="connection-popover-machines"
                                                icon="laptop-outline"
                                                title={t('settings.machines')}
                                                subtitle={machineSubtitle}
                                                statusLabel={t(connectionHealth.machineLabelKey)}
                                                statusColor={machinesPresentation.color}
                                                dotColor={machinesPresentation.dotColor}
                                            />
                                        </View>
                                    );
                                })()}

                                <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
                                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                                        <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                                            {t('connectionStatus.labels.lastSync')}
                                        </Text>
                                        <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default() }}>
                                            {formatTime(lastSyncAt)}
                                        </Text>
                                    </View>
                                    {syncError ? (
                                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
                                            <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() }}>
                                                {t('connectionStatus.labels.lastError')}
                                            </Text>
                                            <Text style={{ fontSize: 12, color: theme.colors.text, ...Typography.default(), flexShrink: 1, textAlign: 'right' }} numberOfLines={2}>
                                                {syncError.message}
                                            </Text>
                                        </View>
                                    ) : null}
                                </View>

                                {serverTargets.length > 0 ? (
                                    <ConnectionTargetList
                                        title={t('server.switchToServer')}
                                        actions={targetActions}
                                    />
                                ) : null}
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            </View>

        </>
    );
});
