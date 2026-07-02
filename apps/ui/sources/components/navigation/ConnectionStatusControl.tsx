import * as React from 'react';
import { Platform, View, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t, type TranslationKeyNoParams } from '@/text';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { StatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { useSocketStatus, useSyncError, useLastSyncAt, useSettingMutable } from '@/sync/domains/state/storage';
import { getServerUrl } from '@/sync/domains/server/serverConfig';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerId,
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
import { writeServerSelectionActiveTargetToServer } from '@/sync/domains/server/selection/serverSelectionActiveTarget';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { useConnectionTargetActions } from '@/components/navigation/connection/useConnectionTargetActions';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { Text } from '@/components/ui/text/Text';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { resolveMachineConnectionSummary } from '@/components/navigation/connectionStatus/resolveMachineConnectionSummary';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { sync } from '@/sync/sync';
import { resolveSocketErrorClassification } from '@/sync/runtime/connectivity/resolveSocketErrorClassification';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';

type Variant = 'sidebar' | 'header';
const RELAY_SETTINGS_ROUTE = '/settings/server';
const RELAY_DROPDOWN_TARGET_THRESHOLD = 2;
const POPOVER_MAX_WIDTH = 420;
const POPOVER_MIN_WIDTH = 220;

type ConnectionStatusKey = 'connected' | 'connecting' | 'disconnected' | 'error' | 'action_required' | 'unknown';

function resolveConnectionStatusPillVariant(status: ConnectionStatusKey): StatusPillVariant {
    switch (status) {
        case 'connected':
            return 'success';
        case 'connecting':
            return 'info';
        case 'action_required':
            return 'warning';
        case 'error':
            return 'danger';
        case 'disconnected':
        case 'unknown':
            return 'neutral';
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
        color: theme.colors.text.secondary,
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
        backgroundColor: theme.colors.surface.inset,
        borderColor: theme.colors.border.default,
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
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    statusRowText: {
        flexShrink: 1,
        minWidth: 0,
    },
    statusRowTitle: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        lineHeight: 16,
    },
    statusRowSubtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
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
    statusRowRetryButton: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    popoverStatusPill: {
        flexShrink: 0,
    },
    statusMeta: {
        paddingHorizontal: 16,
        paddingTop: 10,
        gap: 6,
    },
    statusMetaRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 12,
        alignItems: 'flex-start',
    },
    statusMetaLabel: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    statusMetaValue: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    popoverActionsRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    popoverActionButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 10,
        backgroundColor: theme.colors.background.canvas,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    popoverActionButtonText: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
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

function resolveStatusPresentation(
    theme: { colors: { status: Record<string, string> } },
    status: ConnectionStatusKey,
): { labelKey: TranslationKeyNoParams; color: string; dotColor: string; pillVariant: StatusPillVariant } {
    switch (status) {
        case 'connected':
            return { labelKey: 'status.connected', color: theme.colors.status.connected, dotColor: theme.colors.status.connected, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'connecting':
            return { labelKey: 'status.connecting', color: theme.colors.status.connecting, dotColor: theme.colors.status.connecting, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'action_required':
            return { labelKey: 'status.actionRequired', color: theme.colors.status.actionRequired, dotColor: theme.colors.status.actionRequired, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'error':
            return { labelKey: 'status.error', color: theme.colors.status.error, dotColor: theme.colors.status.error, pillVariant: resolveConnectionStatusPillVariant(status) };
        case 'disconnected':
            return { labelKey: 'status.disconnected', color: theme.colors.status.disconnected, dotColor: theme.colors.status.disconnected, pillVariant: resolveConnectionStatusPillVariant(status) };
        default:
            return { labelKey: 'status.unknown', color: theme.colors.status.default, dotColor: theme.colors.status.default, pillVariant: resolveConnectionStatusPillVariant(status) };
    }
}

function resolveRelayStatusKey(params: Readonly<{
    endpointStatus: unknown;
    connectionHealthKind: ReturnType<typeof useConnectionHealth>['kind'];
}>): 'connected' | 'connecting' | 'disconnected' | 'error' | 'action_required' | 'unknown' {
    switch (params.endpointStatus) {
        case 'online':
            return 'connected';
        case 'connecting':
            return 'connecting';
        case 'auth_failed':
            return 'action_required';
        case 'offline':
        case 'shutting_down':
            return 'disconnected';
        case 'idle':
            switch (params.connectionHealthKind) {
                case 'healthy':
                case 'no_machine':
                case 'machine_offline':
                case 'machine_not_ready':
                    return 'connected';
                case 'connecting':
                    return 'connecting';
                case 'auth_required':
                    return 'action_required';
                case 'server_error':
                    return 'error';
                case 'server_unreachable':
                    return 'disconnected';
                default:
                    return 'unknown';
            }
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
    statusVariant: StatusPillVariant;
    onRetry?: () => void;
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
                {props.onRetry ? (
                    <Pressable
                        testID={`${props.testID}-retry`}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.retry')}
                        hitSlop={8}
                        onPress={props.onRetry}
                        style={styles.statusRowRetryButton}
                    >
                        <Ionicons name="refresh-outline" size={17} color={props.statusColor} />
                    </Pressable>
                ) : null}
                <StatusPill
                    variant={props.statusVariant}
                    label={props.statusLabel}
                    style={styles.popoverStatusPill}
                />
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
        const active = servers.find((server) => server.id === activeServerId || resolveServerProfileScopeId(server) === activeServerId);
        const name = String(active?.name ?? '').trim();
        if (name) return name;
        return toServerUrlDisplay(getServerUrl()) || t('status.connected');
    }, [activeServerId, servers]);

    React.useEffect(() => {
        let cancelled = false;
        fireAndForget((async () => {
            const entries = await Promise.all(servers.map(async (profile) => {
                const scopeId = resolveServerProfileScopeId(profile);
                try {
                    const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
                    return [scopeId, creds ? 'signedIn' : 'signedOut'] as const;
                } catch {
                    return [scopeId, 'unknown'] as const;
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

    const serverSelectionScopeSettings = React.useMemo(() => normalizeServerSelectionSettingsForProfileScopeIds({
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    }, servers), [
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        servers,
    ]);

    const serverTargets = React.useMemo(() => {
        return listServerSelectionTargets({
            serverProfiles: servers.map((profile) => ({
                id: resolveServerProfileScopeId(profile),
                name: profile.name,
                serverUrl: profile.serverUrl,
            })),
            groupProfiles: normalizeStoredServerSelectionGroups(serverSelectionScopeSettings.serverSelectionGroups),
        });
    }, [serverSelectionScopeSettings.serverSelectionGroups, servers]);

    const resolvedTarget = React.useMemo(() => {
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId,
            availableServerIds: listServerProfileScopeIds(servers),
            settings: serverSelectionScopeSettings,
        });
    }, [
        activeServerId,
        serverSelectionScopeSettings,
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
            const shouldSwitch = await confirmSignedOutSwitch(target.serverId);
            if (!shouldSwitch) return;
            writeServerSelectionActiveTargetToServer({
                setServerSelectionActiveTargetKind,
                setServerSelectionActiveTargetId,
            }, target.serverId);
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

        if (nextServerId && !areServerProfileIdentifiersEquivalent(nextServerId, activeServerId)) {
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

    const targetActionById = React.useMemo(() => {
        return new Map(targetActions.map((action) => [action.id, action] as const));
    }, [targetActions]);

    const syncErrorPresentation = React.useMemo(() => {
        if (!activeSyncError) return null;
        const classified = resolveSocketErrorClassification(activeSyncError.message);
        return {
            ...classified,
            kind: activeSyncError.kind === 'auth' ? 'auth' : classified.kind,
            retryable: activeSyncError.retryable ?? classified.retryable,
            message: classified.message,
        };
    }, [activeSyncError]);

    const handleRestoreAccount = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push('/restore'));
        if (result !== true) {
            fireAndForget(result, { tag: 'ConnectionStatusControl.nav.restore' });
        }
        setRelayDropdownOpen(false);
        setOpen(false);
    }, [router]);

    const handleRetry = React.useCallback(() => {
        sync.retryNow();
        setRelayDropdownOpen(false);
        setOpen(false);
    }, []);

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
                {open ? (
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
                            <View style={styles.popoverContent}>
                                <View style={styles.popoverHeader}>
                                    <Text style={styles.popoverTitle}>{t('connectionStatus.title')}</Text>
                                </View>

                                {(() => {
                                    const relayStatusKey = resolveRelayStatusKey({
                                        endpointStatus: (connectionHealth as any).endpointStatus,
                                        connectionHealthKind: connectionHealth.kind,
                                    });
                                    const endpointPresentation = resolveStatusPresentation(theme, relayStatusKey);
                                    const canRetryRelayConnection =
                                        relayStatusKey === 'connecting'
                                        || relayStatusKey === 'disconnected'
                                        || relayStatusKey === 'error';
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
                                                statusVariant={endpointPresentation.pillVariant}
                                                onRetry={canRetryRelayConnection ? handleRetry : undefined}
                                            />
                                            <ConnectionPopoverStatusRow
                                                testID="connection-popover-realtime"
                                                icon="pulse-outline"
                                                title={t('systemStatus.ui.realtime')}
                                                subtitle={t('systemStatus.ui.socket')}
                                                statusLabel={t(socketPresentation.labelKey)}
                                                statusColor={socketPresentation.color}
                                                dotColor={socketPresentation.dotColor}
                                                statusVariant={socketPresentation.pillVariant}
                                            />
                                            <ConnectionPopoverStatusRow
                                                testID="connection-popover-machines"
                                                icon="laptop-outline"
                                                title={t('settings.machines')}
                                                subtitle={machineSubtitle}
                                                statusLabel={t(connectionHealth.machineLabelKey)}
                                                statusColor={machinesPresentation.color}
                                                dotColor={machinesPresentation.dotColor}
                                                statusVariant={machinesPresentation.pillVariant}
                                            />
                                        </View>
                                    );
                                })()}

                                <View style={styles.statusMeta}>
                                    <View style={styles.statusMetaRow}>
                                        <Text style={styles.statusMetaLabel}>
                                            {t('connectionStatus.labels.lastSync')}
                                        </Text>
                                        <Text style={styles.statusMetaValue}>
                                            {formatTime(lastSyncAt)}
                                        </Text>
                                    </View>
                                    {syncErrorPresentation ? (
                                        <View style={styles.statusMetaRow}>
                                            <Text style={styles.statusMetaLabel}>
                                                {t('connectionStatus.labels.lastError')}
                                            </Text>
                                            <Text style={[styles.statusMetaValue, { flexShrink: 1, textAlign: 'right' }]} numberOfLines={2}>
                                                {syncErrorPresentation.message}
                                            </Text>
                                        </View>
                                    ) : null}
                                </View>

                                {syncErrorPresentation ? (
                                    <View style={styles.popoverActionsRow}>
                                        {syncErrorPresentation.kind === 'auth' ? (
                                            <Pressable
                                                onPress={handleRestoreAccount}
                                                style={styles.popoverActionButton}
                                                accessibilityRole="button"
                                            >
                                                <Text style={styles.popoverActionButtonText}>{t('connect.restoreAccount')}</Text>
                                            </Pressable>
                                        ) : syncErrorPresentation.retryable !== false ? (
                                            <Pressable
                                                onPress={handleRetry}
                                                style={styles.popoverActionButton}
                                                accessibilityRole="button"
                                            >
                                                <Text style={styles.popoverActionButtonText}>{t('common.retry')}</Text>
                                            </Pressable>
                                        ) : null}
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
                                                    <Ionicons name="settings-outline" size={18} color={theme.colors.text.secondary} />
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
