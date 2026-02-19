import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
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
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { useConnectionTargetActions } from '@/components/navigation/connection/useConnectionTargetActions';
import { ConnectionTargetList } from '@/components/navigation/connection/ConnectionTargetList';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';

type Variant = 'sidebar' | 'header';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
        zIndex: 2000,
        overflow: 'visible',
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
        flexWrap: 'nowrap' as const,
        maxWidth: '100%',
        overflow: 'visible',
    },
    statusText: {
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
        flexShrink: 1,
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
}));

function formatTime(ts: number | null): string {
    if (!ts) return '—';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '—';
    }
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
    const [serverSelectionGroups] = useSettingMutable('serverSelectionGroups');
    const [serverSelectionActiveTargetKind, setServerSelectionActiveTargetKind] = useSettingMutable('serverSelectionActiveTargetKind');
    const [serverSelectionActiveTargetId, setServerSelectionActiveTargetId] = useSettingMutable('serverSelectionActiveTargetId');

    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<any>(null);
    const [authStatusByServerId, setAuthStatusByServerId] = React.useState<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>({});

    const connectionStatus = React.useMemo(() => {
        switch (socketStatus.status) {
            case 'connected':
                return { color: theme.colors.status.connected, isPulsing: false, text: t('status.connected') };
            case 'connecting':
                return { color: theme.colors.status.connecting, isPulsing: true, text: t('status.connecting') };
            case 'disconnected':
                return { color: theme.colors.status.disconnected, isPulsing: false, text: t('status.disconnected') };
            case 'error':
                return { color: theme.colors.status.error, isPulsing: false, text: t('status.error') };
            default:
                return { color: theme.colors.status.default, isPulsing: false, text: '' };
        }
    }, [socketStatus.status, theme.colors.status]);

    if (!connectionStatus.text) return null;

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
            groupProfiles: serverSelectionGroups as any,
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
                    onPress={() => setOpen(true)}
                    accessibilityRole="button"
                >
                    <StatusDot
                        color={connectionStatus.color}
                        isPulsing={connectionStatus.isPulsing}
                        size={dotSize}
                        style={{ marginRight: 4 }}
                    />
                    <Text
                        style={[styles.statusText, { color: connectionStatus.color, fontSize: textSize }]}
                        numberOfLines={1}
                    >
                        {connectionStatus.text}
                    </Text>
                    <Ionicons
                        name={open ? "chevron-up" : "chevron-down"}
                        size={chevronSize}
                        color={connectionStatus.color}
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
                            <View style={{ paddingTop: 8 }}>
                                <Text style={styles.popoverTitle}>Connection</Text>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Server</Text>
                                    <Text style={styles.popoverValue} numberOfLines={2}>{toServerUrlDisplay(getServerUrl())}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Socket</Text>
                                    <Text style={styles.popoverValue}>{socketStatus.status}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Authenticated</Text>
                                    <Text style={styles.popoverValue}>{auth.isAuthenticated ? 'Yes' : 'No'}</Text>
                                </View>

                                <View style={styles.popoverRow}>
                                    <Text style={styles.popoverLabel}>Last sync</Text>
                                    <Text style={styles.popoverValue}>{formatTime(lastSyncAt)}</Text>
                                </View>

                                {syncError?.nextRetryAt ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>Next retry</Text>
                                        <Text style={styles.popoverValue}>{formatTime(syncError.nextRetryAt)}</Text>
                                    </View>
                                ) : null}

                                {syncError ? (
                                    <View style={styles.popoverRow}>
                                        <Text style={styles.popoverLabel}>Last error</Text>
                                        <Text style={styles.popoverValue} numberOfLines={3}>{syncError.message}</Text>
                                    </View>
                                ) : null}

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
