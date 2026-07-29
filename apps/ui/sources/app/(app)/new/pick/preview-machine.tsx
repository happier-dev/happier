import React from 'react';
import { Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { useAllMachines, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { useNewSessionPickerRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';

export default React.memo(function PreviewMachinePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string;
        machineId?: string;
        selectedId?: string;
        spawnServerId?: string;
    }>();
    const machines = useAllMachines();
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const settings = useSettings() ?? settingsDefaults;

    const selectedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;
    const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;
    const activeServerId = getActiveServerId();
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const spawnServerId = resolveSpawnServerRouteParam(params.spawnServerId) ?? activeServerId;
    const machineIdParam = typeof params.machineId === 'string' ? params.machineId : null;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineIdParam,
        serverId: spawnServerId,
        enabled: Boolean(machineIdParam),
        staleMs: 60_000,
    });
    const preferredBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
            daemonMergedProjectionInputs: daemonMergedProjection.inputs,
        });
    }, [
        daemonMergedProjection.inputs,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
    ]);

    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/new' })}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Ionicons name="chevron-back" size={22} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    ), [navigation, router, theme.colors.chrome.header.foreground]);
    const presentation = useNewSessionPickerRoutePresentation();

    const screenOptions = React.useCallback(() => {
        return {
            headerShown: true,
            title: t('profiles.previewMachine.title'),
            headerBackTitle: t('common.back'),
            presentation,
            headerLeft,
        } as const;
    }, [headerLeft, presentation]);

    const favoriteMachineList = React.useMemo(() => {
        const byId = new Map(machines.map((m) => [m.id, m] as const));
        return favoriteMachines.map((id: string) => byId.get(id)).filter(Boolean) as typeof machines;
    }, [favoriteMachines, machines]);

    const toggleFavorite = React.useCallback((machineId: string) => {
        if (favoriteMachines.includes(machineId)) {
            setFavoriteMachines(favoriteMachines.filter((id: string) => id !== machineId));
            return;
        }
        setFavoriteMachines([...favoriteMachines, machineId]);
    }, [favoriteMachines, setFavoriteMachines]);

    const setPreviewMachineIdOnPreviousRoute = React.useCallback((previewMachineId: string) => {
        const roundTripFallbackTarget = resolveRouteCloseoutFallbackTarget({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            preferredBackendTarget,
        });
        const roundTripBackendParams = buildBackendTargetRouteParams({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            fallbackTarget: roundTripFallbackTarget,
        });
        return setNewSessionPickerReturnParams({
            navigation: navigation as any,
            router,
            routeParams: {
                ...roundTripBackendParams,
                previewMachineId,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                previewMachineId,
            },
        });
    }, [
        currentRouteParams,
        navigation,
        params.agentType,
        params.backendTarget,
        params.backendTargetKey,
        params.dataId,
        params.machineId,
        params.spawnServerId,
        router,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
        preferredBackendTarget,
        spawnServerId,
    ]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ItemList>
                <MachineSelector
                    machines={machines}
                    serverId={activeServerId}
                    selectedMachine={selectedMachine}
                    favoriteMachines={favoriteMachineList}
                    showRecent={false}
                    showFavorites={favoriteMachineList.length > 0}
                    showSearch
                    searchPlacement={favoriteMachineList.length > 0 ? 'favorites' : 'all'}
                    onSelect={(machine) => {
                        const returnMode = setPreviewMachineIdOnPreviousRoute(machine.id);
                        if (returnMode === 'dispatch') {
                            safeRouterBack({ router, navigation, fallbackHref: '/new' });
                        }
                    }}
                    onToggleFavorite={(machine) => toggleFavorite(machine.id)}
                />
            </ItemList>
        </>
    );
});
