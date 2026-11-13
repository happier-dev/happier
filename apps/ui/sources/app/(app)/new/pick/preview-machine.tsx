import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { useSettingMutable, useSettingsSelector, useActiveMachineFacts } from '@/sync/domains/state/storage';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { useNewSessionPickerReturnHost } from '@/components/sessions/new/navigation/newSessionEntry';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { NewSessionPickerRouteScreen } from '@/components/sessions/new/navigation/NewSessionPickerRouteScreen';
import { useMachinePickerRouteOptions } from '@/components/sessions/new/navigation/machinePickerRouteOptions';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

export default React.memo(function PreviewMachinePickerScreen() {
    const router = useRouter();
    const returnToHost = useNewSessionPickerReturnHost();
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
    const activeMachines = useActiveMachineFacts();
    const activeServerId = getActiveServerId();
    const allowedServerIds = React.useMemo(() => [activeServerId], [activeServerId]);
    const groups = useServerScopedMachineOptions({
        allowedServerIds,
        activeServerId,
        activeMachines,
        inventoryPurpose: 'launch',
    });
    const machines = React.useMemo(() => groups.flatMap(group => group.machines), [groups]);
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');
    const remembered = useLastUsedBackendSelection();
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }), ["backendEnabledByTargetKey"]);

    const selectedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;
    const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const spawnServerId = resolveSpawnServerRouteParam(params.spawnServerId) ?? activeServerId;
    const machineIdParam = typeof params.machineId === 'string' ? params.machineId : null;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        // The backend preference reads Agent declarations only.
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
        machineId: machineIdParam,
        serverId: spawnServerId,
        enabled: Boolean(machineIdParam),
    });
    const { snapshot: acpCatalog } = useAcpCatalogForServer(spawnServerId);
    const preferredBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTarget({
            lastUsedAgent: remembered.lastUsedAgent,
            lastUsedBackendTarget: remembered.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSnapshot: acpCatalog && !acpCatalog.stale ? acpCatalog.catalog : undefined,
            daemonMergedProjectionInputs: daemonMergedProjection.inputs,
        });
    }, [
        daemonMergedProjection.inputs,
        acpCatalog,
        settings.backendEnabledByTargetKey,
        remembered.lastUsedAgent,
        remembered.lastUsedBackendTarget,
    ]);

    // The Machine picker route chrome (title with Refresh, plus Cancel), as on the Machine route.
    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const handleRefresh = React.useCallback(() => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        fireAndForget(
            sync.refreshMachinesThrottled({ staleMs: 0, force: true }).finally(() => setIsRefreshing(false)),
            { tag: 'PreviewMachinePickerScreen.refreshMachines' },
        );
    }, [isRefreshing]);
    const handleBack = React.useCallback(
        () => safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref }),
        [navigation, pickerFallbackHref, router],
    );
    const screenOptions = useMachinePickerRouteOptions({
        title: t('profiles.previewMachine.title'),
        cancelTestID: 'new-session-preview-machine-picker-cancel',
        onBack: handleBack,
        onRefresh: handleRefresh,
        isRefreshing,
    });

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
            returnToHost,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                previewMachineId,
            },
        });
    }, [
        returnToHost,
        currentRouteParams,
        navigation,
        params.agentType,
        params.backendTarget,
        params.backendTargetKey,
        params.dataId,
        params.machineId,
        params.spawnServerId,
        router,
        settings.backendEnabledByTargetKey,
        remembered.lastUsedAgent,
        remembered.lastUsedBackendTarget,
        preferredBackendTarget,
        spawnServerId,
    ]);

    return (
        <NewSessionPickerRouteScreen options={screenOptions}>
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
                        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
                    }
                }}
                onToggleFavorite={(machine) => toggleFavorite(machine.id)}
            />
        </NewSessionPickerRouteScreen>
    );
});
