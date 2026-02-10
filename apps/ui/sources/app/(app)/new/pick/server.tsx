import React from 'react';
import { CommonActions } from '@react-navigation/native';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, listServerProfiles, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { getNewSessionServerTargeting } from '@/sync/domains/server/multiServer';
import { useUnistyles } from 'react-native-unistyles';

export default React.memo(function ServerPickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ selectedId?: string }>();

    const multiServerEnabled = useSetting('multiServerEnabled');
    const multiServerSelectedServerIds = useSetting('multiServerSelectedServerIds');
    const multiServerPresentation = useSetting('multiServerPresentation');
    const multiServerProfiles = useSetting('multiServerProfiles');
    const multiServerActiveProfileId = useSetting('multiServerActiveProfileId');

    const activeServer = getActiveServerSnapshot();
    const allProfiles = React.useMemo(() => {
        return listServerProfiles()
            .slice()
            .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    }, [
        activeServer.generation,
        multiServerActiveProfileId,
        multiServerEnabled,
        multiServerPresentation,
        multiServerProfiles,
        multiServerSelectedServerIds,
    ]);

    const availableServerIds = React.useMemo(() => allProfiles.map((profile) => profile.id), [allProfiles]);
    const targeting = React.useMemo(() => {
        return getNewSessionServerTargeting({
            activeServerId: activeServer.serverId,
            availableServerIds,
            settings: {
                multiServerEnabled: Boolean(multiServerEnabled),
                multiServerSelectedServerIds: Array.isArray(multiServerSelectedServerIds)
                    ? multiServerSelectedServerIds
                    : [],
                multiServerPresentation: multiServerPresentation === 'flat-with-badge' ? 'flat-with-badge' : 'grouped',
                multiServerProfiles: Array.isArray(multiServerProfiles) ? multiServerProfiles : [],
                multiServerActiveProfileId: typeof multiServerActiveProfileId === 'string'
                    ? multiServerActiveProfileId
                    : null,
            },
        });
    }, [
        activeServer.serverId,
        availableServerIds,
        multiServerActiveProfileId,
        multiServerEnabled,
        multiServerPresentation,
        multiServerProfiles,
        multiServerSelectedServerIds,
    ]);

    const profileById = React.useMemo(() => {
        return new Map(allProfiles.map((profile) => [profile.id, profile]));
    }, [allProfiles]);
    const eligibleProfiles = React.useMemo(() => {
        const fromPolicy = targeting.allowedServerIds
            .map((serverId) => profileById.get(serverId) ?? null)
            .filter((profile): profile is ServerProfile => profile !== null);
        if (fromPolicy.length > 0) return fromPolicy;
        const fallback = profileById.get(activeServer.serverId);
        return fallback ? [fallback] : [];
    }, [activeServer.serverId, profileById, targeting.allowedServerIds]);

    const selectedIdFromParams = typeof params.selectedId === 'string' ? params.selectedId : '';
    const selectedId = eligibleProfiles.find((profile) => profile.id === selectedIdFromParams)?.id
        ?? eligibleProfiles[0]?.id
        ?? '';

    const setParamsOnPreviousAndClose = React.useCallback((serverId: string) => {
        const state = navigation.getState();
        const previousRoute = state?.routes?.[state.index - 1];
        if (state && state.index > 0 && previousRoute) {
            navigation.dispatch({
                ...CommonActions.setParams({ serverId }),
                source: previousRoute.key,
            });
        }
        router.back();
    }, [navigation, router]);

    const headerLeft = React.useCallback(() => (
        <Pressable
            onPress={() => router.back()}
            hitSlop={10}
            style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
        >
            <Ionicons name="chevron-back" size={22} color={theme.colors.header.tint} />
        </Pressable>
    ), [router, theme.colors.header.tint]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        title: t('server.switchToServer'),
        headerBackTitle: t('common.back'),
        presentation: Platform.OS === 'ios' ? ('containedModal' as const) : undefined,
        headerLeft,
    }), [headerLeft]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ItemList>
                <ItemGroup title={t('server.switchToServer')}>
                    {eligibleProfiles.map((profile) => (
                        <Item
                            key={profile.id}
                            title={profile.name}
                            subtitle={profile.serverUrl}
                            icon={<Ionicons name="server-outline" size={18} color={theme.colors.textSecondary} />}
                            selected={profile.id === selectedId}
                            onPress={() => setParamsOnPreviousAndClose(profile.id)}
                        />
                    ))}
                </ItemGroup>
            </ItemList>
        </>
    );
});
