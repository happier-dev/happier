import React from 'react';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable } from 'react-native';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { useUnistyles } from 'react-native-unistyles';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';

type ServerPickerParams = {
    dataId?: string;
    selectedId?: string;
};

export default React.memo(function ServerPickerScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<ServerPickerParams>();

    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');

    const activeServer = getActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        return listServerProfiles()
            .slice();
    }, [
        activeServer.generation,
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    ]);

    const resolvedTarget = React.useMemo(() => {
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId: activeServer.serverId,
            availableServerIds: serverProfiles.map((profile) => profile.id),
            settings: {
                serverSelectionGroups,
                serverSelectionActiveTargetKind,
                serverSelectionActiveTargetId,
            },
        });
    }, [
        activeServer.serverId,
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        serverProfiles,
    ]);

    const allowedServerIds = React.useMemo(() => {
        const seen = new Set<string>();
        const ids: string[] = [];
        for (const id of resolvedTarget.allowedServerIds) {
            const normalized = String(id ?? '').trim();
            if (!normalized || seen.has(normalized)) continue;
            seen.add(normalized);
            ids.push(normalized);
        }
        return ids;
    }, [resolvedTarget.allowedServerIds]);

    const filteredServers = React.useMemo(() => {
        const allowed = new Set(allowedServerIds);
        return serverProfiles.filter((profile) => allowed.has(profile.id));
    }, [allowedServerIds, serverProfiles]);

    const selectedServerId = React.useMemo(() => {
        const selectedServerId = typeof params.selectedId === 'string' ? params.selectedId : '';
        if (selectedServerId && allowedServerIds.includes(selectedServerId)) return selectedServerId;
        if (allowedServerIds.includes(activeServer.serverId)) return activeServer.serverId;
        return allowedServerIds[0] ?? activeServer.serverId;
    }, [activeServer.serverId, allowedServerIds, params.selectedId]);

    const setParamsOnPreviousAndClose = React.useCallback((serverId: string) => {
        const dataId = typeof params.dataId === 'string' ? params.dataId : undefined;
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                spawnServerId: serverId,
            },
            replaceParams: {
                ...(dataId ? { dataId } : {}),
                spawnServerId: serverId,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [navigation, params.dataId, router]);

    const confirmSignedOutTarget = React.useCallback(async (serverId: string): Promise<{ allowed: boolean; signedOut: boolean }> => {
        const nextServerId = String(serverId ?? '').trim();
        if (!nextServerId) return { allowed: true, signedOut: false };
        const profile = serverProfiles.find((srv) => srv.id === nextServerId) ?? null;
        if (!profile) return { allowed: true, signedOut: false };
        try {
            const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
            if (creds) return { allowed: true, signedOut: false };
        } catch {
            // If auth status cannot be determined, allow selection without blocking.
            return { allowed: true, signedOut: false };
        }
        const allowed = await promptSignedOutServerSwitchConfirmation();
        return { allowed, signedOut: true };
    }, [serverProfiles]);

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
                    {filteredServers.map((target) => {
                        const isSelected = target.id === selectedServerId;
                        return (
                            <Item
                                key={target.id}
                                title={target.name}
                                subtitle={target.serverUrl}
                                icon={<Ionicons name="server-outline" size={18} color={theme.colors.textSecondary} />}
                                selected={isSelected}
                                onPress={() => {
                                    fireAndForget((async () => {
                                        const auth = await confirmSignedOutTarget(target.id);
                                        if (!auth.allowed) return;

                                        if (auth.signedOut) {
                                            router.replace('/');
                                            return;
                                        }

                                        setParamsOnPreviousAndClose(target.id);
                                    })(), { tag: 'ServerPickerScreen.selectServer' });
                                }}
                            />
                        );
                    })}
                </ItemGroup>
            </ItemList>
        </>
    );
});
