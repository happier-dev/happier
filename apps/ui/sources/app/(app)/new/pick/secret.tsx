import React from 'react';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Pressable } from 'react-native';

import { useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretsMutable } from '@/components/secrets/useSavedSecretsMutable';
import { useUnistyles } from 'react-native-unistyles';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useNewSessionPickerRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { Icon } from '@/components/ui/icons/Icon';

export default React.memo(function SecretPickerScreen() {
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
    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const hasUsableRouteState = Boolean(
        selectedId.trim()
        || (typeof params.dataId === 'string' && params.dataId.trim().length > 0)
        || (typeof params.machineId === 'string' && params.machineId.trim().length > 0),
    );
    const settings = useSettings() ?? settingsDefaults;
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const spawnServerId = resolveSpawnServerRouteParam(params.spawnServerId);
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

    const [secrets, setSecrets] = useSavedSecretsMutable();

    const setSecretParamAndClose = React.useCallback((secretId: string) => {
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
        const returnMode = setNewSessionPickerReturnParams({
            navigation: navigation as any,
            router,
            routeParams: {
                ...roundTripBackendParams,
                secretId,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                secretId,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
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

    const handleBackPress = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [navigation, pickerFallbackHref, router]);

    React.useEffect(() => {
        if (hasUsableRouteState) return;
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [hasUsableRouteState, navigation, pickerFallbackHref, router]);

    const headerTitle = t('settings.secrets');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleBackPress}
                hitSlop={10}
                style={({ pressed }) => ({ marginLeft: 10, padding: 4, opacity: pressed ? 0.7 : 1 })}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
            >
                <Icon name="caret-left" size={20} color={theme.colors.chrome.header.foreground} />
            </Pressable>
        );
    }, [handleBackPress, theme.colors.chrome.header.foreground]);
    const presentation = useNewSessionPickerRoutePresentation();

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
            presentation,
            headerLeft,
        } as const;
    }, [headerBackTitle, headerLeft, headerTitle, presentation]);

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />

            <SecretsList
                secrets={secrets}
                onChangeSecrets={setSecrets}
                selectedId={selectedId}
                onSelectId={setSecretParamAndClose}
                includeNoneRow
                allowAdd
                allowEdit
                onAfterAddSelectId={setSecretParamAndClose}
            />
        </>
    );
});
