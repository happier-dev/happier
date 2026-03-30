import React from 'react';
import { Platform, Pressable } from 'react-native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { useAllMachines, useSettingMutable } from '@/sync/domains/state/storage';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';

export default React.memo(function PreviewMachinePickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string }>();
    const machines = useAllMachines();
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');

    const selectedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;
    const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;
    const activeServerId = getActiveServerId();

    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={() => safeRouterBack({ router, navigation, fallbackHref: '/new' })}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
        </Pressable>
    ), [navigation, router, theme.colors.header.tint]);

    const screenOptions = React.useCallback(() => {
        return {
            headerShown: true,
            title: t('profiles.previewMachine.title'),
            headerBackTitle: t('common.back'),
            presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
            headerLeft,
        } as const;
    }, [headerLeft]);

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
        return setNewSessionPickerReturnParams({
            navigation: navigation as any,
            router,
            routeParams: { previewMachineId },
        });
    }, [navigation, router]);

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
