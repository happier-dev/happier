import React from 'react';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useUnistyles } from 'react-native-unistyles';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromSettings } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromSettings';
import { pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { settingsDefaults } from '@/sync/domains/settings/settings';

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
    const settings = useSettings() ?? settingsDefaults;
    const preferredBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTargetFromSettings({
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
        });
    }, [
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
        settings.backendEnabledByTargetKey,
        settings.acpCatalogSettingsV1,
    ]);
    const roundTripFallbackTarget = React.useMemo(() => {
        return resolveRouteCloseoutFallbackTarget({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            preferredBackendTarget,
        });
    }, [params.agentType, params.backendTarget, params.backendTargetKey, preferredBackendTarget]);
    const roundTripBackendParams = React.useMemo(() => {
        return buildBackendTargetRouteParams({
            agentType: params.agentType,
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            fallbackTarget: roundTripFallbackTarget,
        });
    }, [params.agentType, params.backendTarget, params.backendTargetKey, roundTripFallbackTarget]);
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);

    const [secrets, setSecrets] = useSettingMutable('secrets');

    const setSecretParamAndClose = React.useCallback((secretId: string) => {
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
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [currentRouteParams, navigation, params.dataId, params.machineId, params.spawnServerId, roundTripBackendParams, router]);

    const handleBackPress = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: '/new' });
    }, [navigation, router]);

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
                <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
            </Pressable>
        );
    }, [handleBackPress, theme.colors.header.tint]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
            // /new is presented as `containedModal` on iOS. Ensure picker screens are too,
            // otherwise they can be pushed "behind" the modal (invisible but on the back stack).
            presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
            headerLeft,
        } as const;
    }, [headerBackTitle, headerLeft, headerTitle]);

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
