import * as React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList, ItemListStatic } from '@/components/ui/lists/ItemList';
import { t } from '@/text';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { listServerProfiles, resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { useAuth } from '@/auth/context/AuthContext';
import {
    readServerAuthStatus,
    useServerAuthStatusByServerId,
} from '@/components/settings/server/hooks/useServerAuthStatusByServerId';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { buildNewSessionAuthContinuationRootHref } from '@/components/sessions/new/navigation/newSessionAuthContinuation';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';

type ServerSelectionParams = Readonly<{
    agentType?: string;
    backendTarget?: string;
    backendTargetKey?: string;
    dataId?: string;
    selectedId?: string;
}>;

export type NewSessionServerSelectionContentProps = Readonly<{
    maxHeight: number;
    onClose: () => void;
    dismissOnSelection?: boolean;
    selectedServerId?: string | null;
    /** True only when this component is the route-level scroll owner. */
    ownsScrollViewport?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.background.canvas,
    },
    standaloneContainer: {
        flex: 1,
        minHeight: 0,
    },
    list: {
        width: '100%',
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
        ownsScrollViewport = false,
    } = props;
    const router = useRouter();
    const navigation = useNavigation();
    const authContext = useAuth();
    const params = useLocalSearchParams<ServerSelectionParams>();
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    const {
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    } = useHomeViewSelectionSettings();

    const activeServer = getActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServer.generation]);
    const authStatusByServerId = useServerAuthStatusByServerId(serverProfiles);

    const resolvedTarget = React.useMemo(() => {
        const settings = normalizeServerSelectionSettingsForProfileScopeIds({
            serverSelectionGroups,
            serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId,
        }, serverProfiles);
        return resolveActiveServerSelectionFromRawSettings({
            activeServerId: activeServer.serverId,
            availableServerIds: listServerProfileScopeIds(serverProfiles),
            settings,
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
        return serverProfiles.flatMap((profile) => {
            const serverId = resolveServerProfileScopeId(profile);
            return allowed.has(serverId) ? [{ profile, serverId }] : [];
        });
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

    const commitSelectedServer = React.useCallback((serverId: string) => {
        const dataId = typeof params.dataId === 'string' ? params.dataId : undefined;
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                spawnServerId: serverId,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...(dataId ? { dataId } : {}),
                spawnServerId: serverId,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
        if (dismissOnSelection) {
            onClose();
        }
    }, [currentRouteParams, dismissOnSelection, navigation, onClose, params.dataId, pickerFallbackHref, router]);

    const handleServerPress = React.useCallback((serverId: string) => {
        fireAndForget((async () => {
            // An unreadable credential store or an unknown Home is neither
            // signed in nor signed out: stay put rather than route to sign-in.
            const authState = await readServerAuthStatus(serverId);
            if (authState === 'unknown') return;
            if (authState === 'signedOut') {
                const switchResult = await setActiveServerAndSwitch({
                    serverId,
                    scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                    refreshAuth: authContext.refreshFromActiveServer,
                });
                if (switchResult === 'blocked') return;
                router.replace(buildNewSessionAuthContinuationRootHref({
                    currentRouteParams,
                    targetServerId: serverId,
                }));
                if (dismissOnSelection) {
                    onClose();
                }
                return;
            }
            commitSelectedServer(serverId);
        })(), { tag: 'NewSessionServerSelectionContent.selectServer' });
    }, [authContext.refreshFromActiveServer, commitSelectedServer, currentRouteParams, dismissOnSelection, onClose, router]);

    const SelectionList = ownsScrollViewport ? ItemList : ItemListStatic;

    return (
        <View style={[styles.container, ownsScrollViewport ? styles.standaloneContainer : null, { maxHeight }]}>
            {/*
              * K1/K2 picker anatomy: no title band inside the content. The chip names the choice in
              * the popover; the route shows the native title with Cancel.
              */}
            <SelectionList
                presentation="grouped"
                style={styles.list}
                containerStyle={styles.listContent}
            >
                <ItemGroup
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('server.switchToServer')}
                    selectableItemCountOverride={filteredServers.length}
                >
                    {filteredServers.map(({ profile, serverId }) => {
                        const isSelected = serverId === selectedServerId;
                        const authStatus = authStatusByServerId[serverId] ?? 'unknown';
                        const statusLabel = authStatus === 'signedIn'
                            ? t('server.signedIn')
                            : authStatus === 'signedOut'
                                ? t('server.signedOut')
                                : t('server.authStatusUnknown');
                        return (
                            <Item
                                key={serverId}
                                title={profile.name}
                                subtitle={statusLabel}
                                icon={(
                                    <Icon
                                        name="hard-drives"
                                        size={16}
                                        color={theme.colors.text.secondary}
                                    />
                                )}
                                selected={isSelected}
                                accessibilityRole="radio"
                                onPress={() => handleServerPress(serverId)}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
            </SelectionList>
        </View>
    );
}
