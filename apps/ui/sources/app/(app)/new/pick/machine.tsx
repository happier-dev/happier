import React from 'react';
import { Pressable, Text, View, Platform } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { CommonActions } from '@react-navigation/native';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { ServerScopedMachineSelector } from '@/components/sessions/new/components/ServerScopedMachineSelector';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { Ionicons } from '@expo/vector-icons';
import { sync } from '@/sync/sync';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { invalidateMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';
import { getActiveServerId, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

function useMachinePickerScreenOptions(params: {
    title: string;
    onBack: () => void;
    onRefresh: () => void;
    isRefreshing: boolean;
    theme: { colors: { header: { tint: string }; textSecondary: string } };
}) {
    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={params.onBack}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Ionicons name="chevron-back" size={22} color={params.theme.colors.header.tint} />
        </Pressable>
    ), [params.onBack, params.theme.colors.header.tint]);

    const headerTitle = React.useCallback(({ tintColor }: { children: string; tintColor?: string }) => (
        <HeaderTitleWithAction
            title={params.title}
            tintColor={tintColor ?? params.theme.colors.header.tint}
            actionLabel={t('common.refresh')}
            actionIconName="refresh-outline"
            actionColor={params.theme.colors.textSecondary}
            actionDisabled={params.isRefreshing}
            actionLoading={params.isRefreshing}
            onActionPress={params.onRefresh}
        />
    ), [params.isRefreshing, params.onRefresh, params.theme.colors.header.tint, params.theme.colors.textSecondary, params.title]);

    return React.useMemo(() => ({
        headerShown: true,
        title: params.title,
        headerTitle,
        headerBackTitle: t('common.back'),
        // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
        // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
        presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
        headerLeft,
    }), [headerLeft, headerTitle]);
}

export default React.memo(function MachinePickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        selectedId?: string;
        spawnServerId?: string;
    }>();
    const machines = useAllMachines();
    const sessions = useSessions();
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');

    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const [refreshToken, setRefreshToken] = React.useState(0);
    const autoSelectedSingleMachineRef = React.useRef(false);
    const selectedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;
    const requestedServerId = typeof params.spawnServerId === 'string' ? params.spawnServerId.trim() : '';
    const activeServerId = getActiveServerId();
    const serverProfiles = React.useMemo(() => {
        return listServerProfiles();
    }, [activeServerId, refreshToken]);
    const resolvedTarget = React.useMemo(() => {
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId,
            availableServerIds: serverProfiles.map((profile) => profile.id),
            settings: {
                serverSelectionGroups,
                serverSelectionActiveTargetKind,
                serverSelectionActiveTargetId,
            },
        });
    }, [
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        serverProfiles,
        activeServerId,
    ]);
    const allowedServerIds = React.useMemo(() => {
        const fromTarget = Array.isArray(resolvedTarget.allowedServerIds)
            ? resolvedTarget.allowedServerIds.map((id) => String(id ?? '').trim()).filter(Boolean)
            : [];
        if (fromTarget.length > 0) return fromTarget;
        return activeServerId ? [activeServerId] : [];
    }, [resolvedTarget.allowedServerIds, activeServerId]);
    const selectedServerId = React.useMemo(() => {
        if (requestedServerId && allowedServerIds.includes(requestedServerId)) {
            return requestedServerId;
        }
        if (activeServerId && allowedServerIds.includes(activeServerId)) {
            return activeServerId;
        }
        return allowedServerIds[0] ?? activeServerId;
    }, [activeServerId, allowedServerIds, requestedServerId]);
    const serverScopedMachineGroups = useServerScopedMachineOptions({
        allowedServerIds,
        activeServerId,
        activeMachines: machines,
        refreshToken,
    });
    const machinesForSelectedServer = React.useMemo(() => {
        return serverScopedMachineGroups.find((group) => group.serverId === selectedServerId)?.machines ?? [];
    }, [selectedServerId, serverScopedMachineGroups]);
    const hasAnyMachines = React.useMemo(() => {
        return serverScopedMachineGroups.some((group) => group.machines.length > 0);
    }, [serverScopedMachineGroups]);
    const hasAnyLoadingMachines = React.useMemo(() => {
        return serverScopedMachineGroups.some((group) => group.loading);
    }, [serverScopedMachineGroups]);
    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        const fromSelectedServer = machinesForSelectedServer.find((machine) => machine.id === selectedMachineId);
        if (fromSelectedServer) return fromSelectedServer;
        return machines.find((machine) => machine.id === selectedMachineId) || null;
    }, [machines, machinesForSelectedServer, selectedMachineId]);

    const handleRefresh = React.useCallback(async () => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        try {
            // Always refresh the machine list (new machines / metadata updates).
            await sync.refreshMachinesThrottled({ staleMs: 0, force: true });

            // Refresh machine-scoped caches only for the currently-selected machine (if any).
            if (selectedMachineId) {
                invalidateMachineEnvPresence({ machineId: selectedMachineId, serverId: selectedServerId || activeServerId });
                await Promise.all([
                    prefetchMachineCapabilities({
                        machineId: selectedMachineId,
                        serverId: selectedServerId || activeServerId,
                        request: CAPABILITIES_REQUEST_NEW_SESSION,
                    }),
                ]);
            }
            setRefreshToken((value) => value + 1);
        } finally {
            setIsRefreshing(false);
        }
    }, [activeServerId, isRefreshing, selectedMachineId, selectedServerId]);

    const screenOptions = useMachinePickerScreenOptions({
        title: t('newSession.selectMachineTitle'),
        onBack: () => router.back(),
        onRefresh: () => { void handleRefresh(); },
        isRefreshing,
        theme,
    });

    const handleSelectMachine = React.useCallback(async (machine: typeof machines[0] & { serverId?: string }) => {
        // Support both callback pattern (feature branch wizard) and navigation params (main)
        const machineId = machine.id;
        const machineServerId = typeof machine.serverId === 'string' ? machine.serverId.trim() : '';
        const resolvedServerId = machineServerId || selectedServerId || activeServerId;

        // Navigation params approach from main for backward compatibility
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({
                    machineId,
                    spawnServerId: resolvedServerId,
                }),
                source: previousRoute.key,
            });
        }

        router.back();
    }, [activeServerId, navigation, router, selectedServerId]);

    React.useEffect(() => {
        if (autoSelectedSingleMachineRef.current) return;
        if (selectedMachineId) return;
        if (!selectedServerId) return;
        const serverGroup = serverScopedMachineGroups.find((group) => group.serverId === selectedServerId);
        if (!serverGroup || serverGroup.loading || serverGroup.signedOut) return;
        if (serverGroup.machines.length !== 1) return;
        autoSelectedSingleMachineRef.current = true;
        void handleSelectMachine(serverGroup.machines[0]!);
    }, [handleSelectMachine, selectedMachineId, selectedServerId, serverScopedMachineGroups]);

    // Compute recent machines from sessions
    const recentMachines = React.useMemo(() => {
        return getRecentMachinesFromSessions({ machines: machinesForSelectedServer, sessions });
    }, [sessions, machinesForSelectedServer]);

    if (!hasAnyLoadingMachines && !hasAnyMachines) {
        return (
            <>
                <Stack.Screen options={screenOptions} />
                <View style={styles.container}>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>
                            {t('newSession.noMachinesFound')}
                        </Text>
                    </View>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ItemList>
                {allowedServerIds.length > 1 ? (
                    <ServerScopedMachineSelector
                        groups={serverScopedMachineGroups}
                        selectedMachineId={selectedMachineId}
                        selectedServerId={selectedServerId}
                        onSelect={handleSelectMachine}
                    />
                ) : (
                    <MachineSelector
                        machines={machinesForSelectedServer}
                        serverId={selectedServerId}
                        selectedMachine={selectedMachine}
                        recentMachines={recentMachines}
                        favoriteMachines={machinesForSelectedServer.filter(m => favoriteMachines.includes(m.id))}
                        onSelect={handleSelectMachine}
                        showFavorites={true}
                        showSearch={useMachinePickerSearch}
                        onToggleFavorite={(machine) => {
                            const isInFavorites = favoriteMachines.includes(machine.id);
                            setFavoriteMachines(isInFavorites
                                ? favoriteMachines.filter((id: string) => id !== machine.id)
                                : [...favoriteMachines, machine.id]
                            );
                        }}
                    />
                )}
            </ItemList>
        </>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
