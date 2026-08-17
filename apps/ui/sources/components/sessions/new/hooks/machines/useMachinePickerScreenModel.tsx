import * as React from 'react';
import { Pressable } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAllMachines, useAllSessionListRenderables, useSetting, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { invalidateMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { useNewSessionActiveServerSource } from '@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource';
import { useNewSessionPickerRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { Icon } from '@/components/ui/icons/Icon';

function useMachinePickerScreenOptions(params: Readonly<{
    title: string;
    onBack: () => void;
    onRefresh: () => void;
    isRefreshing: boolean;
    theme: { colors: { chrome: { header: { foreground: string } }; text: { secondary: string } } };
}>) {
    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={params.onBack}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Icon name="caret-left" size={20} color={params.theme.colors.chrome.header.foreground} />
        </Pressable>
    ), [params.onBack, params.theme.colors.chrome.header.foreground]);

    const headerTitle = React.useCallback(({ tintColor }: { children: string; tintColor?: string }) => (
        <HeaderTitleWithAction
            title={params.title}
            tintColor={tintColor ?? params.theme.colors.chrome.header.foreground}
            actionLabel={t('common.refresh')}
            actionIconName="arrow-clockwise"
            actionColor={params.theme.colors.text.secondary}
            actionDisabled={params.isRefreshing}
            actionLoading={params.isRefreshing}
            onActionPress={params.onRefresh}
        />
    ), [params.isRefreshing, params.onRefresh, params.theme.colors.chrome.header.foreground, params.theme.colors.text.secondary, params.title]);
    const presentation = useNewSessionPickerRoutePresentation();

    return React.useMemo(() => ({
        headerShown: true,
        title: params.title,
        headerTitle,
        headerBackTitle: t('common.back'),
        presentation,
        headerLeft,
    }), [headerLeft, headerTitle, params.title, presentation]);
}

export function useMachinePickerScreenModel() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string;
        selectedId?: string;
        spawnServerId?: string;
    }>();
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const settings = useSettings();
    const activeServerSource = useNewSessionActiveServerSource();
    const machines = useAllMachines();
    const sessions = useAllSessionListRenderables();
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');

    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const [refreshToken, setRefreshToken] = React.useState(0);
    const autoSelectedSingleMachineRef = React.useRef(false);
    const selectedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;
    const requestedServerId = typeof params.spawnServerId === 'string' ? params.spawnServerId.trim() : null;
    const activeServerId = activeServerSource.activeServerId;
    const {
        allowedTargetServerIds,
        targetServerId,
    } = useNewSessionServerTargetState({
        settings,
        activeServerId: activeServerSource.activeServerId,
        serverProfiles: activeServerSource.serverProfiles,
        request: {
            spawnServerIdParam: requestedServerId,
        },
    });
    const allowedServerIds = React.useMemo(() => {
        const fromTarget = Array.isArray(allowedTargetServerIds)
            ? allowedTargetServerIds.map((id) => String(id ?? '').trim()).filter(Boolean)
            : [];
        if (fromTarget.length > 0) return fromTarget;
        return activeServerId ? [activeServerId] : [];
    }, [activeServerId, allowedTargetServerIds]);
    const selectedServerId = React.useMemo(() => {
        const normalizedTargetServerId = typeof targetServerId === 'string' ? targetServerId.trim() : '';
        if (normalizedTargetServerId && allowedServerIds.includes(normalizedTargetServerId)) {
            return normalizedTargetServerId;
        }
        if (activeServerId && allowedServerIds.includes(activeServerId)) {
            return activeServerId;
        }
        if (normalizedTargetServerId) {
            return normalizedTargetServerId;
        }
        return allowedServerIds[0] ?? activeServerId;
    }, [activeServerId, allowedServerIds, targetServerId]);
    const serverScopeRefreshToken = React.useMemo(() => {
        return `${activeServerSource.serverProfilesSignature}\u0000${refreshToken}`;
    }, [activeServerSource.serverProfilesSignature, refreshToken]);
    const serverScopedMachineGroups = useServerScopedMachineOptions({
        allowedServerIds,
        activeServerId,
        activeMachines: machines,
        refreshToken: serverScopeRefreshToken,
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
    const handleBack = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: '/new' });
    }, [navigation, router]);
    const handleRefreshPress = React.useCallback(() => {
        fireAndForget(handleRefresh(), { tag: 'MachinePickerScreen.refreshMachinesAndCapabilities' });
    }, [handleRefresh]);

    const screenOptions = useMachinePickerScreenOptions({
        title: t('newSession.selectMachineTitle'),
        onBack: handleBack,
        onRefresh: handleRefreshPress,
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
            currentParams: currentRouteParams,
            replaceParams: {
                ...(dataId ? { dataId } : {}),
                machineId,
                ...(resolvedServerId ? { spawnServerId: resolvedServerId } : {}),
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [activeServerId, currentRouteParams, navigation, params.dataId, router, selectedServerId]);

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
