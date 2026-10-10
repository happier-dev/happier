import { useAuthoringMemoryField } from '@/sync/domains/state/storage';
import React, { useState, useMemo } from 'react';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { View, Pressable } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useAllSessionListRenderables, useSetting, useSettingMutable, useSettingsSelector } from '@/sync/domains/state/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useStableRecentPathsForMachine } from '@/utils/sessions/useStableRecentPathsForMachine';
import { Text } from '@/components/ui/text/Text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildBackendTargetRouteParams, resolveRouteCloseoutFallbackTarget } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { NewSessionScreenPortalScope, useNewSessionContainedModalScreenOptions } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import { resolveSpawnServerRouteParam } from '@/components/sessions/new/navigation/spawnServerRouteParam';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { useEventCallback } from '@/hooks/ui/useEventCallback';


export default React.memo(function PathPickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string;
        machineId?: string;
        selectedPath?: string;
        directory?: string;
        directoryKind?: string;
        path?: string;
        spawnServerId?: string;
    }>();
    const machines = useAllMachines();
    const sessions = useAllSessionListRenderables();
    const recentMachinePaths = useAuthoringMemoryField('recentMachinePaths');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [favoriteDirectoriesRaw, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const settings = useSettingsSelector((settings) => ({
        lastUsedAgent: settings.lastUsedAgent,
        lastUsedBackendTarget: settings.lastUsedBackendTarget,
        backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
    }));
    const favoriteDirectories = favoriteDirectoriesRaw ?? [];
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const spawnServerId = resolveSpawnServerRouteParam(params.spawnServerId);
    const machineIdParam = typeof params.machineId === 'string' ? params.machineId : null;
    const hasUsableRouteState = Boolean(
        machineIdParam?.trim()
        || (typeof params.dataId === 'string' && params.dataId.trim().length > 0)
        || (typeof params.selectedPath === 'string' && params.selectedPath.trim().length > 0)
        || (typeof params.directory === 'string' && params.directory.trim().length > 0)
        || (typeof params.path === 'string' && params.path.trim().length > 0),
    );
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineIdParam,
        serverId: spawnServerId,
        enabled: Boolean(machineIdParam),
        staleMs: 60_000,
    });
    const { snapshot: acpCatalog } = useAcpCatalogForServer(spawnServerId);
    const preferredBackendTarget = React.useMemo(() => {
        if (!acpCatalog || acpCatalog.stale || acpCatalog.catalog.status !== 'ready') return null;
        return resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSnapshot: acpCatalog.catalog,
            daemonMergedProjectionInputs: daemonMergedProjection.inputs,
        });
    }, [
        daemonMergedProjection.inputs,
        acpCatalog,
        settings.backendEnabledByTargetKey,
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
    ]);

    const initialPath = typeof params.selectedPath === 'string' && params.selectedPath.length > 0
        ? params.selectedPath
        : (typeof params.directory === 'string' && params.directory.length > 0
            ? params.directory
            : (typeof params.path === 'string' ? params.path : ''));
    const [customPath, setCustomPathState] = useState(initialPath);
    const customPathRef = React.useRef(customPath);
    const setCustomPath = React.useCallback((next: string) => {
        customPathRef.current = next;
        setCustomPathState(next);
    }, []);
    React.useEffect(() => {
        customPathRef.current = initialPath;
        setCustomPathState(initialPath);
    }, [initialPath]);
    const [pathSearchQuery, setPathSearchQuery] = useState('');

    // Get the selected machine
    const machine = useMemo(() => {
        return machines.find(m => m.id === params.machineId);
    }, [machines, params.machineId]);

    const machineHomeDir = machine?.metadata?.homeDir || '/home';

    // Get recent paths for this machine - prioritize from settings, then fall back to sessions
    const recentPaths = useStableRecentPathsForMachine({
        machineId: params.machineId,
        recentMachinePaths,
        sessions,
        cacheScopeKey: spawnServerId,
    });


    const handleSelectDirectory = useEventCallback((intent: SessionDirectoryIntentV1) => {
        const directoryParams = {
            directoryKind: intent.kind,
            directory: intent.kind === 'path' ? intent.path : undefined,
            path: undefined,
        };
        const dataId = typeof params.dataId === 'string' ? params.dataId : undefined;
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
            navigation,
            router,
            routeParams: {
                ...roundTripBackendParams,
                ...directoryParams,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...roundTripBackendParams,
                ...(dataId ? { dataId } : {}),
                machineId: params.machineId,
                ...directoryParams,
                ...(spawnServerId ? { spawnServerId } : {}),
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
        announceAccessibilityMessage(intent.kind === 'managed'
            ? t('newSession.folder.a11y.removed')
            : t('newSession.folder.a11y.set', { path: intent.path }));
    });
    const handleSelectPath = React.useCallback((pathOverride?: string) => {
        const rawPath = typeof pathOverride === 'string' ? pathOverride : customPathRef.current;
        handleSelectDirectory({ kind: 'path', path: rawPath.trim() || machineHomeDir });
    }, [handleSelectDirectory, machineHomeDir]);

    const handleBackPress = useEventCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    });

    React.useEffect(() => {
        if (hasUsableRouteState) return;
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [hasUsableRouteState, navigation, pickerFallbackHref, router]);

    const headerTitle = t('newSession.selectPathTitle');
    const headerBackTitle = t('common.back');

    // K2 picker route chrome: the native title plus Cancel (and Done), nothing else above the list.
    const headerLeft = React.useCallback(() => (
        <AppHeaderCloseButton
            testID="new-session-path-picker-cancel"
            appearance="text"
            onPress={handleBackPress}
        />
    ), [handleBackPress]);

    // NOTE: Keep the header actions stable across keystrokes.
    // On iOS containedModal, frequently re-creating `headerRight` as the user types can cause
    // the picker to dismiss/re-present (losing the in-progress TextInput value).
    // The confirm action is safe even when the input is empty because we fall back to homeDir.
    const headerRight = React.useCallback(() => {
        return (
            <Pressable
                testID="new-session-path-picker-confirm"
                onPress={() => handleSelectPath()}
                accessibilityRole="button"
                accessibilityLabel={t('common.done')}
                style={({ pressed }) => ({
                    opacity: pressed ? motionTokens.press.opacity : 1,
                    padding: 4,
                })}
            >
                <Icon
                    name="check"
                    size={24}
                    color={theme.colors.chrome.header.foreground}
                />
            </Pressable>
        );
    }, [handleSelectPath, theme.colors.chrome.header.foreground]);

    const baseScreenOptions = useNewSessionContainedModalScreenOptions({
        title: headerTitle,
        headerBackTitle,
    });
    const screenOptions = React.useMemo(() => {
        return {
            ...baseScreenOptions,
            headerLeft,
            headerRight,
        } as const;
    }, [baseScreenOptions, headerLeft, headerRight]);

    if (!machine) {
        return (
            <NewSessionScreenPortalScope>
                <Stack.Screen
                    options={screenOptions}
                />
                <ItemList presentation="grouped">
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>{t('newSession.noMachineSelected')}</Text>
                    </View>
                </ItemList>
            </NewSessionScreenPortalScope>
        );
    }

    return (
        <NewSessionScreenPortalScope>
            <Stack.Screen
                options={screenOptions}
            />
            <NewSessionPathSelectionContent
                noFolderOption={{ selected: params.directoryKind === 'managed', onSelect: () => handleSelectDirectory({ kind: 'managed' }) }}
                machineHomeDir={machineHomeDir}
                selectedPath={customPath}
                onChangeSelectedPath={setCustomPath}
                submitBehavior="confirm"
                onSubmitSelectedPath={handleSelectPath}
                recentPaths={recentPaths}
                usePickerSearch={usePathPickerSearch}
                searchQuery={pathSearchQuery}
                onChangeSearchQuery={setPathSearchQuery}
                favoriteDirectories={favoriteDirectories}
                onChangeFavoriteDirectories={setFavoriteDirectories}
                machineBrowse={{
                    enabled: true,
                    machineId: machine.id,
                }}
            />
        </NewSessionScreenPortalScope>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
