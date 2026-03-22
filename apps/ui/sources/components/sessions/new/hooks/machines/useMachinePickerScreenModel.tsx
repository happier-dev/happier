import * as React from 'react';
import { Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { invalidateMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';
import { getActiveServerId, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import type { Machine } from '@/sync/domains/state/storageTypes';

function useMachinePickerScreenOptions(params: Readonly<{
    title: string;
    onBack: () => void;
    onRefresh: () => void;
    isRefreshing: boolean;
    theme: { colors: { header: { tint: string }; textSecondary: string } };
}>) {
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
        presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
        headerLeft,
    }), [headerLeft, headerTitle, params.title]);
}

export function useMachinePickerScreenModel() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        dataId?: string;
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
        activeServerId,
        serverProfiles,
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
    ]);
    const allowedServerIds = React.useMemo(() => {
        const fromTarget = Array.isArray(resolvedTarget.allowedServerIds)
            ? resolvedTarget.allowedServerIds.map((id) => String(id ?? '').trim()).filter(Boolean)
            : [];
        if (fromTarget.length > 0) return fromTarget;
        return activeServerId ? [activeServerId] : [];
    }, [activeServerId, resolvedTarget.allowedServerIds]);
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
            await sync.refreshMachinesThrottled({ staleMs: 0, force: true });

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
        onBack: () => safeRouterBack({ router, navigation, fallbackHref: '/new' }),
        onRefresh: () => { fireAndForget(handleRefresh(), { tag: 'MachinePickerScreen.refreshMachinesAndCapabilities' }); },
        isRefreshing,
        theme,
    });

    React.useEffect(() => {
        fireAndForget(sync.refreshMachinesThrottled({ staleMs: 0, force: true }), {
            tag: 'MachinePickerScreen.refreshMachinesOnMount',
        });
    }, []);

    const handleSelectMachine = React.useCallback(async (machine: typeof machines[0] & { serverId?: string }) => {
        const machineId = machine.id;
        const machineServerId = typeof machine.serverId === 'string' ? machine.serverId.trim() : '';
        const resolvedServerId = machineServerId || selectedServerId || activeServerId;
        const dataId = typeof params.dataId === 'string' ? params.dataId : undefined;

        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                machineId,
                spawnServerId: resolvedServerId,
            },
            replaceParams: {
                ...(dataId ? { dataId } : {}),
                machineId,
                ...(resolvedServerId ? { spawnServerId: resolvedServerId } : {}),
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [activeServerId, navigation, params.dataId, router, selectedServerId]);

    React.useEffect(() => {
        if (autoSelectedSingleMachineRef.current) return;
        if (selectedMachineId) return;
        if (!selectedServerId) return;
        const serverGroup = serverScopedMachineGroups.find((group) => group.serverId === selectedServerId);
        if (!serverGroup || serverGroup.loading || serverGroup.signedOut) return;
        if (serverGroup.machines.length !== 1) return;
        if (!isMachineOnline(serverGroup.machines[0]! as any)) return;
        autoSelectedSingleMachineRef.current = true;
        void handleSelectMachine(serverGroup.machines[0]!);
    }, [handleSelectMachine, selectedMachineId, selectedServerId, serverScopedMachineGroups]);

    const recentMachines = React.useMemo(() => {
        return getRecentMachinesFromSessions({ machines: machinesForSelectedServer, sessions });
    }, [sessions, machinesForSelectedServer]);

    const favoriteMachineItems = React.useMemo(() => {
        return machinesForSelectedServer.filter((machine) => favoriteMachines.includes(machine.id));
    }, [favoriteMachines, machinesForSelectedServer]);

    const onToggleFavorite = React.useCallback((machine: Machine) => {
        const isInFavorites = favoriteMachines.includes(machine.id);
        setFavoriteMachines(isInFavorites
            ? favoriteMachines.filter((id: string) => id !== machine.id)
            : [...favoriteMachines, machine.id],
        );
    }, [favoriteMachines, setFavoriteMachines]);

    const content = React.useMemo(() => (
        <NewSessionMachineSelectionContent
            groups={serverScopedMachineGroups}
            selectedMachine={selectedMachine}
            selectedServerId={selectedServerId}
            recentMachines={recentMachines}
            favoriteMachines={favoriteMachineItems}
            onSelectMachine={handleSelectMachine}
            onSelectScopedMachine={handleSelectMachine}
            serverId={selectedServerId}
            onToggleFavorite={onToggleFavorite}
            showSearch={useMachinePickerSearch}
            testIdPrefix="new-session-machine"
        />
    ), [
        favoriteMachineItems,
        handleSelectMachine,
        onToggleFavorite,
        recentMachines,
        selectedMachine,
        selectedServerId,
        serverScopedMachineGroups,
        useMachinePickerSearch,
    ]);

    return {
        screenOptions,
        content,
    } as const;
}
