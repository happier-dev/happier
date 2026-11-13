import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import React from 'react';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useSettingsSelector } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useUnistyles } from 'react-native-unistyles';
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
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

export default React.memo(function SecretPickerScreen() {
    const { theme } = useUnistyles();
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
    const selectedId = typeof params.selectedId === 'string' ? params.selectedId : '';
    const hasUsableRouteState = Boolean(
        selectedId.trim()
        || (typeof params.dataId === 'string' && params.dataId.trim().length > 0)
        || (typeof params.machineId === 'string' && params.machineId.trim().length > 0),
    );
    const remembered = useLastUsedBackendSelection();
    const settings = useSettingsSelector((settings) => ({
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }), ["backendEnabledByTargetKey"]);
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const spawnServerId = resolveSpawnServerRouteParam(params.spawnServerId);
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

    const savedSecretCatalog = useSavedSecretCatalog();

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
            returnToHost,
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

    const handleBackPress = useEventCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    });

    React.useEffect(() => {
        if (hasUsableRouteState) return;
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [hasUsableRouteState, navigation, pickerFallbackHref, router]);

    const headerTitle = t('settings.secrets');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <HappierPressable
                onPress={handleBackPress}
                style={({ pressed }) => ({ marginLeft: theme.space.s10, padding: theme.space.s4, opacity: pressed ? motionTokens.press.opacity : 1 })}
                accessibilityRole="button"
                accessibilityLabel={t('common.back')}
            >
                <Icon name="caret-left" size={20} color={theme.colors.chrome.header.foreground} />
            </HappierPressable>
        );
    }, [handleBackPress, theme.colors.chrome.header.foreground]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
            headerLeft,
        } as const;
    }, [headerBackTitle, headerLeft, headerTitle]);

    return (
        <NewSessionPickerRouteScreen options={screenOptions}>

            <SecretsList
                secrets={savedSecretCatalog.personalSecrets}
                sharedEntries={savedSecretCatalog.sharedEntries}
                resolveSharedReference={savedSecretCatalog.resolveReference}
                sharedCatalogError={savedSecretCatalog.errorCause}
                sharedCatalogStale={savedSecretCatalog.status === 'error'
                    || (savedSecretCatalog.status === 'ready' && savedSecretCatalog.stale)}
                onRetrySharedCatalog={() => { void savedSecretCatalog.reload().catch(() => {}); }}
                onCreatePersonal={savedSecretCatalog.personalMutations.create}
                onRenamePersonal={savedSecretCatalog.personalMutations.rename}
                onRotatePersonal={savedSecretCatalog.personalMutations.rotate}
                onDeletePersonal={savedSecretCatalog.personalMutations.delete}
                selectedId={selectedId}
                onSelectId={setSecretParamAndClose}
                includeNoneRow
                allowAdd
                allowEdit
                onAfterAddSelectId={setSecretParamAndClose}
            />
        </NewSessionPickerRouteScreen>
    );
});
