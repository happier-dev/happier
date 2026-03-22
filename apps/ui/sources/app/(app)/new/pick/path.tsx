import React, { useState, useMemo } from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Stack, useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { useAllMachines, useSessions, useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { ItemList } from '@/components/ui/lists/ItemList';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';
import { Text } from '@/components/ui/text/Text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';


export default React.memo(function PathPickerScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        dataId?: string;
        machineId?: string;
        selectedPath?: string;
        directory?: string;
        path?: string;
        spawnServerId?: string;
    }>();
    const machines = useAllMachines();
    const sessions = useSessions();
    const recentMachinePaths = useSetting('recentMachinePaths');
    const usePathPickerSearch = useSetting('usePathPickerSearch');
    const [favoriteDirectoriesRaw, setFavoriteDirectories] = useSettingMutable('favoriteDirectories');
    const favoriteDirectories = favoriteDirectoriesRaw ?? [];

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
    const recentPaths = useMemo(() => {
        if (!params.machineId) return [];
        return getRecentPathsForMachine({
            machineId: params.machineId,
            recentMachinePaths,
            sessions,
        });
    }, [params.machineId, recentMachinePaths, sessions]);


    const handleSelectPath = React.useCallback((pathOverride?: string) => {
        const rawPath = typeof pathOverride === 'string' ? pathOverride : customPathRef.current;
        const pathToUse = rawPath.trim() || machineHomeDir;
        const dataId = typeof params.dataId === 'string' ? params.dataId : undefined;
        const spawnServerId = typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0
            ? params.spawnServerId
            : undefined;
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: { directory: pathToUse },
            replaceParams: {
                ...(dataId ? { dataId } : {}),
                machineId: params.machineId,
                directory: pathToUse,
                ...(spawnServerId ? { spawnServerId } : {}),
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [machineHomeDir, navigation, params.dataId, params.machineId, params.spawnServerId, router]);

    const handleBackPress = React.useCallback(() => {
        safeRouterBack({ router, navigation, fallbackHref: '/new' });
    }, [navigation, router]);

    const headerTitle = t('newSession.selectPathTitle');
    const headerBackTitle = t('common.back');

    const headerLeft = React.useCallback(() => {
        return (
            <Pressable
                onPress={handleBackPress}
                hitSlop={10}
                style={({ pressed }) => ({
                    marginLeft: 10,
                    opacity: pressed ? 0.7 : 1,
                    padding: 4,
                })}
            >
                <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
            </Pressable>
        );
    }, [handleBackPress, theme.colors.header.tint]);

    // NOTE: Keep the header actions stable across keystrokes.
    // On iOS containedModal, frequently re-creating `headerRight` as the user types can cause
    // the picker to dismiss/re-present (losing the in-progress TextInput value).
    // The confirm action is safe even when the input is empty because we fall back to homeDir.
    const headerRight = React.useCallback(() => {
        return (
            <Pressable
                onPress={() => handleSelectPath()}
                style={({ pressed }) => ({
                    opacity: pressed ? 0.7 : 1,
                    padding: 4,
                })}
            >
                <Ionicons
                    name="checkmark"
                    size={24}
                    color={theme.colors.header.tint}
                />
            </Pressable>
        );
    }, [handleSelectPath, theme.colors.header.tint]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            title: headerTitle,
            headerTitle,
            headerBackTitle,
            presentation: Platform.OS === 'ios' ? 'containedModal' : undefined,
            headerLeft,
            headerRight,
        } as const;
    }, [headerBackTitle, headerLeft, headerRight, headerTitle]);

    if (!machine) {
        return (
            <>
                <Stack.Screen
                    options={screenOptions}
                />
                <ItemList>
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyText}>{t('newSession.noMachineSelected')}</Text>
                    </View>
                </ItemList>
            </>
        );
    }

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />
            <NewSessionPathSelectionContent
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
        </>
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
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
