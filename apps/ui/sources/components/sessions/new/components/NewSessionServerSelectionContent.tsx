import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Platform, Pressable, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { promptSignedOutServerSwitchConfirmation } from '@/components/settings/server/modals/ServerSwitchAuthPrompt';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';

type ServerSelectionParams = Readonly<{
    dataId?: string;
    selectedId?: string;
}>;

export type NewSessionServerSelectionContentProps = Readonly<{
    maxHeight: number;
    onClose: () => void;
    dismissOnSelection?: boolean;
    selectedServerId?: string | null;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
        minHeight: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        paddingHorizontal: Platform.select({ ios: 20, default: 16 }),
        paddingTop: Platform.select({ ios: 18, default: 16 }),
        paddingBottom: 12,
    },
    headerTextBlock: {
        flex: 1,
        paddingRight: 12,
    },
    headerTitle: {
        color: theme.colors.text,
        fontSize: 18,
        lineHeight: 24,
        fontWeight: Platform.select({ ios: '600', default: '700' }),
    },
    closeButton: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        padding: 4,
    },
    list: {
        flex: 1,
        minHeight: 0,
    },
    listContent: {
        paddingBottom: Platform.select({ ios: 16, default: 12 }),
    },
    rowIcon: {
        width: 18,
        height: 18,
    },
}));

function normalizeServerIds(serverIds: readonly string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const serverId of serverIds) {
        const next = String(serverId ?? '').trim();
        if (!next || seen.has(next)) continue;
        seen.add(next);
        normalized.push(next);
    }
    return normalized;
}

export function NewSessionServerSelectionContent(props: NewSessionServerSelectionContentProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const {
        maxHeight,
        onClose,
        dismissOnSelection = false,
    } = props;
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<ServerSelectionParams>();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');

    const activeServer = getActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServer.generation]);

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
        serverProfiles,
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
    ]);

    const allowedServerIds = React.useMemo(() => normalizeServerIds(resolvedTarget.allowedServerIds), [resolvedTarget.allowedServerIds]);
    const filteredServers = React.useMemo(() => {
        if (allowedServerIds.length === 0) return [];
        const allowed = new Set(allowedServerIds);
        return serverProfiles.filter((profile) => allowed.has(profile.id));
    }, [allowedServerIds, serverProfiles]);

    const selectedServerId = React.useMemo(() => {
        const explicitSelectedServerId = String(props.selectedServerId ?? '').trim();
        if (explicitSelectedServerId && allowedServerIds.includes(explicitSelectedServerId)) {
            return explicitSelectedServerId;
        }
        const selectedId = typeof params.selectedId === 'string' ? params.selectedId.trim() : '';
        if (selectedId && allowedServerIds.includes(selectedId)) return selectedId;
        if (allowedServerIds.includes(activeServer.serverId)) return activeServer.serverId;
        return allowedServerIds[0] ?? activeServer.serverId;
    }, [activeServer.serverId, allowedServerIds, params.selectedId, props.selectedServerId]);

    const confirmSignedOutTarget = React.useCallback(async (serverId: string): Promise<{ allowed: boolean; signedOut: boolean }> => {
        const nextServerId = String(serverId ?? '').trim();
        if (!nextServerId) return { allowed: true, signedOut: false };

        const profile = serverProfiles.find((srv) => srv.id === nextServerId) ?? null;
        if (!profile) return { allowed: true, signedOut: false };

        try {
            const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
            if (creds) return { allowed: true, signedOut: false };
        } catch {
            return { allowed: true, signedOut: false };
        }

        const allowed = await promptSignedOutServerSwitchConfirmation();
        return { allowed, signedOut: true };
    }, [serverProfiles]);

    const commitSelectedServer = React.useCallback((serverId: string) => {
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
        if (dismissOnSelection) {
            onClose();
        }
    }, [dismissOnSelection, navigation, onClose, params.dataId, router]);

    const handleServerPress = React.useCallback((serverId: string) => {
        fireAndForget((async () => {
            const auth = await confirmSignedOutTarget(serverId);
            if (!auth.allowed) return;
            if (auth.signedOut) {
                router.replace('/');
                if (dismissOnSelection) {
                    onClose();
                }
                return;
            }
            commitSelectedServer(serverId);
        })(), { tag: 'NewSessionServerSelectionContent.selectServer' });
    }, [commitSelectedServer, confirmSignedOutTarget, dismissOnSelection, onClose, router]);

    const handleClose = React.useCallback(() => {
        onClose();
    }, [onClose]);

    return (
        <View style={[styles.container, { maxHeight, height: maxHeight }]}>
            <View style={styles.header}>
                <View style={styles.headerTextBlock}>
                    <Text style={styles.headerTitle}>{t('server.switchToServer')}</Text>
                </View>
                <Pressable
                    onPress={handleClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => [
                        styles.closeButton,
                        { opacity: pressed ? 0.7 : 1 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.back')}
                >
                    {React.createElement(Ionicons, {
                        name: 'close',
                        size: 20,
                        color: theme.colors.textSecondary,
                    })}
                </Pressable>
            </View>

            <ItemList
                style={styles.list}
                containerStyle={styles.listContent}
            >
                <ItemGroup selectableItemCountOverride={filteredServers.length}>
                    {filteredServers.map((target) => {
                        const isSelected = target.id === selectedServerId;
                        return (
                            <Item
                                key={target.id}
                                title={target.name}
                                subtitle={target.serverUrl}
                                icon={(
                                    <Ionicons
                                        name="server-outline"
                                        size={18}
                                        color={theme.colors.textSecondary}
                                    />
                                )}
                                selected={isSelected}
                                onPress={() => handleServerPress(target.id)}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            </ItemList>
        </View>
    );
}
