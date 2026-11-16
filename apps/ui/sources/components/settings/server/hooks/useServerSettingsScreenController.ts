import * as React from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import {
    getActiveServerId,
    getActiveServerSnapshot,
    getDeviceDefaultServerId,
    getResetToDefaultServerId,
    getServerProfileById,
    listServerProfiles,
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import {
    filterServerSelectionGroupsToAvailableServers,
    normalizeStoredServerSelectionGroups,
} from '@/sync/domains/server/selection/serverSelectionMutations';
import { normalizeServerSelectionGroupsForSettings } from '@/sync/domains/server/selection/serverSelectionSettingsAdapter';
import {
    listServerProfileScopeIds,
    normalizeServerSelectionSettingsForProfileScopeIds,
} from '@/sync/domains/server/selection/serverSelectionProfileScopeIds';
import { buildServerSelectionActiveTargetForServer } from '@/sync/domains/server/selection/serverSelectionActiveTarget';
import { isAllHomesSelectionTargetId } from '@/sync/domains/server/selection/allHomesSelectionTarget';
import { resolveActiveServerSelectionFromRawSettings } from '@/sync/domains/server/selection/serverSelectionResolution';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { useAuth } from '@/auth/context/AuthContext';
import { useMachineListStatusByServerId } from '@/sync/domains/state/storage';
import { useHomeViewSelectionSettingsMutable } from '@/hooks/server/useHomeViewSelectionSettings';
import { parseServerSettingsRouteParams } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { useServerAuthStatusByServerId } from '@/components/settings/server/hooks/useServerAuthStatusByServerId';
import { useServerSettingsServerProfileActions } from '@/components/settings/server/hooks/useServerSettingsServerProfileActions';
import { useServerSettingsGroupActions } from '@/components/settings/server/hooks/useServerSettingsGroupActions';
import { useServerSettingsConcurrentActions } from '@/components/settings/server/hooks/useServerSettingsConcurrentActions';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import type { RelayDriftBanner } from '@/components/settings/server/relayDriftTypes';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import {
    resolveHomeConnectionSummary,
    resolveHomeTargetSummary,
    type HomeConnectionSummary,
} from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import { useActiveHomeConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';

type SearchParams = Readonly<{
    url?: string | string[];
    auto?: string | string[];
    source?: string | string[];
    groupEditor?: string | string[];
    groupServerIds?: string | string[];
    recoveryProfile?: string | string[];
    recoveryReturnTo?: string | string[];
}>;
type SwitchServerByIdOptions = Readonly<{
    normalizeRoute?: boolean;
    preserveSelectionTarget?: boolean;
    scope?: 'device' | 'tab';
}>;

export type ServerSettingsController = Readonly<{
    servers: ReadonlyArray<ServerProfile>;
    serverGroups: ReadonlyArray<ServerSelectionGroup>;
    activeServerId: string;
    activeServerUrl: string;
    activeLocalRelayUrl: string | null;
    deviceDefaultServerId: string;
    activeGroupId: string | null;
    authStatusByServerId: Readonly<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>;
    homeConnectionSummaryByServerId: Readonly<Record<string, HomeConnectionSummary>>;
    relayDriftBanner: RelayDriftBanner | null;
    /** Route-owned exact Home recovery entry, if this screen was opened from a status action. */
    homeRecovery: Readonly<{ profileRef: string; returnTo: string }> | null;

    onSwitchServer: (profile: ServerProfile, scope?: 'device' | 'tab') => Promise<void>;
    onSwitchGroup: (profile: ServerSelectionGroup) => Promise<void>;
    onRenameServer: (profile: ServerProfile) => Promise<void>;
    onRemoveServer: (profile: ServerProfile) => Promise<void>;
    onRenameGroup: (profile: ServerSelectionGroup, name: string) => Promise<void>;
    onRemoveGroup: (profile: ServerSelectionGroup) => Promise<void>;
    onCreateServerGroup: (params: { name: string; serverIds: string[] }) => Promise<boolean>;

    groupSelectionPresentation: 'grouped' | 'flat-with-badge';
    /**
     * The group whose membership the screen is editing. It defaults to the active
     * group so focus alone still opens it, and a Saved Homes row can select any
     * saved group without switching the client to it.
     */
    editedServerGroupId: string | null;
    editedServerGroupName: string | null;
    selectedGroupServerIds: ReadonlySet<string>;
    onEditGroupMembers: (profile: ServerSelectionGroup) => void;
    onToggleGroupPresentation: () => void;
    onToggleGroupServer: (serverId: string) => void;
}>;

export function useServerSettingsScreenController(): ServerSettingsController {
    const router = useRouter();
    const auth = useAuth();
    const relayDriftBanner = useRelayDriftBanner();
    const searchParams = useLocalSearchParams<SearchParams>();

    const [revision, setRevision] = React.useState(0);

    const {
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
        setHomeViewSelectionSettings,
    } = useHomeViewSelectionSettingsMutable();
    const routineSelectionScope = resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost());
    const serverProfilesGeneration = useServerProfilesGeneration();
    const subscribedActiveServer = useActiveServerSnapshot();

    const route = React.useMemo(() => {
        return parseServerSettingsRouteParams({
            url: searchParams.url,
            auto: searchParams.auto,
            source: searchParams.source,
            groupEditor: searchParams.groupEditor,
            groupServerIds: searchParams.groupServerIds,
            recoveryProfile: searchParams.recoveryProfile,
            recoveryReturnTo: searchParams.recoveryReturnTo,
        });
    }, [
        searchParams.auto,
        searchParams.groupEditor,
        searchParams.groupServerIds,
        searchParams.recoveryProfile,
        searchParams.recoveryReturnTo,
        searchParams.source,
        searchParams.url,
    ]);
    const switchServerById = React.useCallback(async (serverId: string, opts?: SwitchServerByIdOptions) => {
        const targetProfile = getServerProfileById(serverId);
        const targetServerId = targetProfile ? resolveServerProfileScopeId(targetProfile) : serverId;
        const selectionScope = opts?.scope ?? routineSelectionScope;
        const switched = await setActiveServerAndSwitch({
            serverId: targetServerId,
            scope: selectionScope,
            refreshAuth: auth.refreshFromActiveServer,
        });
        if (switched === 'blocked') return switched;
        if (opts?.preserveSelectionTarget !== true) {
            const target = buildServerSelectionActiveTargetForServer(targetServerId);
            await setHomeViewSelectionSettings(
                (current) => ({ ...current, ...target }),
                { targetScope: selectionScope },
            );
        }
        // Switching from a Home's page keeps that page open; only an explicit request returns to the Homes collection.
        if (opts?.normalizeRoute ?? false) {
            router.replace(SETTINGS_ROUTES.servers);
        }
        return switched;
    }, [auth, router, routineSelectionScope, setHomeViewSelectionSettings]);

    const servers = React.useMemo(() => {
        try {
            return listServerProfiles()
                .slice();
        } catch {
            return [] as ServerProfile[];
        }
    }, [revision, serverProfilesGeneration]);

    const validServerIds = React.useMemo(() => new Set(listServerProfileScopeIds(servers)), [servers]);

    const serverSelectionScopeSettings = React.useMemo(() => normalizeServerSelectionSettingsForProfileScopeIds({
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    }, servers), [
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        servers,
    ]);

    const storedGroupProfiles = React.useMemo(
        () => normalizeStoredServerSelectionGroups(serverSelectionScopeSettings.serverSelectionGroups),
        [serverSelectionScopeSettings.serverSelectionGroups],
    );
    const normalizedGroupProfiles = React.useMemo(() => filterServerSelectionGroupsToAvailableServers(storedGroupProfiles, validServerIds), [storedGroupProfiles, validServerIds]);

    const activeServerIdValue = React.useMemo(() => {
        try {
            return getActiveServerId();
        } catch {
            return getResetToDefaultServerId() ?? '';
        }
    }, [revision, serverProfilesGeneration]);

    const deviceDefaultServerId = React.useMemo(() => {
        try {
            return getDeviceDefaultServerId();
        } catch {
            return getResetToDefaultServerId() ?? '';
        }
    }, [revision, subscribedActiveServer]);

    const resolvedActiveSelection = React.useMemo(() => resolveActiveServerSelectionFromRawSettings({
        activeServerId: activeServerIdValue,
        availableServerIds: listServerProfileScopeIds(servers),
        settings: serverSelectionScopeSettings,
    }), [
        activeServerIdValue,
        serverSelectionScopeSettings,
        servers,
    ]);

    const activeGroupId = React.useMemo(() => {
        const target = resolvedActiveSelection.activeTarget;
        return target.kind === 'group' ? target.id : null;
    }, [resolvedActiveSelection.activeTarget]);

    const authStatusByServerId = useServerAuthStatusByServerId(servers);
    const activeHomeConnectionHealth = useActiveHomeConnectionHealth();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const homeConnectionSummaryByServerId = React.useMemo(() => {
        const result: Record<string, HomeConnectionSummary> = {};
        for (const profile of servers) {
            const id = resolveServerProfileScopeId(profile);
            const authStatus = authStatusByServerId[id] ?? authStatusByServerId[profile.id] ?? 'unknown';
            const projectionStatus = machineListStatusByServerId[id] ?? machineListStatusByServerId[profile.id];
            const isActive = id === activeServerIdValue || profile.id === activeServerIdValue;
            result[id] = isActive
                ? resolveHomeConnectionSummary({ healthKind: activeHomeConnectionHealth.kind })
                : resolveHomeTargetSummary({ authStatus, projectionStatus });
        }
        return result;
    }, [activeHomeConnectionHealth.kind, activeServerIdValue, authStatusByServerId, machineListStatusByServerId, servers]);
    const activeServerUrl = React.useMemo(() => {
        return servers.find((profile) => profile.id === activeServerIdValue || resolveServerProfileScopeId(profile) === activeServerIdValue)?.serverUrl ?? '';
    }, [activeServerIdValue, servers]);
    const activeServerSnapshot = React.useMemo(() => {
        try {
            return getActiveServerSnapshot();
        } catch {
            return {
                serverId: activeServerIdValue,
                serverUrl: activeServerUrl,
                activeLocalRelayUrl: null,
                generation: 0,
            };
        }
    }, [activeServerIdValue, activeServerUrl]);
    const activeLocalRelayUrl = React.useMemo(() => {
        const value = typeof activeServerSnapshot.activeLocalRelayUrl === 'string'
            ? activeServerSnapshot.activeLocalRelayUrl.trim()
            : '';
        return value.length > 0 ? value : null;
    }, [activeServerSnapshot.activeLocalRelayUrl]);

    React.useEffect(() => {
        const normalizedStored = normalizeStoredServerSelectionGroups(serverSelectionScopeSettings.serverSelectionGroups);
        const rawComparable = Array.isArray(serverSelectionGroups) ? serverSelectionGroups : [];
        if (JSON.stringify(normalizedStored) !== JSON.stringify(rawComparable)) {
            void setHomeViewSelectionSettings((current) => ({
                ...current,
                serverSelectionGroups: normalizeServerSelectionGroupsForSettings(normalizedStored),
            }), { targetScope: routineSelectionScope });
            return;
        }
        const kind = serverSelectionActiveTargetKind === 'server' || serverSelectionActiveTargetKind === 'group'
            ? serverSelectionActiveTargetKind
            : null;
        const id = String(serverSelectionActiveTargetId ?? '').trim();
        // "All Homes" is a virtual selection, never a stored group: it is not a stale target.
        if (kind === 'group' && id && !isAllHomesSelectionTargetId(id) && !normalizedStored.some((profile) => profile.id === id)) {
            void setHomeViewSelectionSettings((current) => ({
                ...current,
                serverSelectionActiveTargetKind: activeServerIdValue ? 'server' : null,
                serverSelectionActiveTargetId: activeServerIdValue || null,
            }), { targetScope: routineSelectionScope });
        }
    }, [
        activeServerIdValue,
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        serverSelectionScopeSettings.serverSelectionGroups,
        setHomeViewSelectionSettings,
        routineSelectionScope,
    ]);

    const activeMultiServerProfileId = React.useMemo(() => {
        const target = resolvedActiveSelection.activeTarget;
        return target.kind === 'group' && target.id ? target.id : null;
    }, [resolvedActiveSelection.activeTarget]);

    const activeGroupProfile = React.useMemo(() => (
        activeMultiServerProfileId
            ? normalizedGroupProfiles.find((profile) => profile.id === activeMultiServerProfileId) ?? null
            : null
    ), [activeMultiServerProfileId, normalizedGroupProfiles]);

    // Membership editing follows an explicitly selected group and falls back to the
    // active one, so a saved group can be edited without switching the whole client.
    const [selectedGroupEditorId, setSelectedGroupEditorId] = React.useState<string | null>(null);
    const onEditGroupMembers = React.useCallback((profile: ServerSelectionGroup) => {
        setSelectedGroupEditorId(profile.id);
    }, []);
    const editedGroupProfile = React.useMemo(() => (
        selectedGroupEditorId
            ? normalizedGroupProfiles.find((profile) => profile.id === selectedGroupEditorId) ?? null
            : activeGroupProfile
    ), [activeGroupProfile, normalizedGroupProfiles, selectedGroupEditorId]);
    const editedGroupId = editedGroupProfile?.id ?? null;

    const selectedConcurrentServerIds = React.useMemo(() => {
        if (editedGroupProfile) return new Set(editedGroupProfile.serverIds);
        return new Set(resolvedActiveSelection.allowedServerIds);
    }, [editedGroupProfile, resolvedActiveSelection.allowedServerIds]);

    const concurrentActions = useServerSettingsConcurrentActions({
        activeGroupId: editedGroupId,
        serverSelectionGroupsRaw: serverSelectionGroups,
        setServerSelectionGroups: (value) => setHomeViewSelectionSettings(
            (current) => ({
                ...current,
                serverSelectionGroups: normalizeServerSelectionGroupsForSettings(value),
            }),
            { targetScope: routineSelectionScope },
        ),
    });

    const profileActions = useServerSettingsServerProfileActions({
        authStatusByServerId,
        selectionScope: routineSelectionScope,
        onSwitchServerById: async (serverId, scope) => {
            return await switchServerById(serverId, { scope });
        },
        onAfterSignedOutSwitch: () => router.replace('/'),
        setRevision,
    });

    const groupActions = useServerSettingsGroupActions({
        servers,
        activeServerId: activeServerIdValue,
        validServerIds,
        authStatusByServerId,
        normalizedGroupProfiles,
        activeGroupId: activeMultiServerProfileId,
        groupPresentation: (activeGroupProfile?.presentation ?? 'grouped') === 'flat-with-badge' ? 'flat-with-badge' : 'grouped',
        selectionScope: routineSelectionScope,
        setRevision,
        onSwitchServerById: async (serverId) => {
            return await switchServerById(serverId, {
                preserveSelectionTarget: true,
                scope: routineSelectionScope,
            });
        },
        onAfterSignedOutSwitch: () => router.replace('/'),
        setHomeViewSelectionSettings,
    });

    return {
        servers,
        serverGroups: normalizedGroupProfiles,
        activeServerId: activeServerIdValue,
        activeServerUrl,
        activeLocalRelayUrl,
        deviceDefaultServerId,
        activeGroupId,
        authStatusByServerId,
        homeConnectionSummaryByServerId,
        relayDriftBanner,
        homeRecovery: route.recovery,

        onSwitchServer: profileActions.onSwitchServer,
        onSwitchGroup: groupActions.onSwitchGroup,
        onRenameServer: profileActions.onRenameServer,
        onRemoveServer: profileActions.onRemoveServer,
        onRenameGroup: groupActions.onRenameGroup,
        onRemoveGroup: groupActions.onRemoveGroup,
        onCreateServerGroup: groupActions.onCreateServerGroup,

        groupSelectionPresentation: (editedGroupProfile?.presentation ?? 'grouped') === 'flat-with-badge' ? 'flat-with-badge' : 'grouped',
        editedServerGroupId: editedGroupId,
        editedServerGroupName: editedGroupId && editedGroupId !== activeMultiServerProfileId ? editedGroupProfile?.name ?? null : null,
        selectedGroupServerIds: selectedConcurrentServerIds,
        onEditGroupMembers,
        onToggleGroupPresentation: concurrentActions.onTogglePresentation,
        onToggleGroupServer: concurrentActions.onToggleConcurrentServer,
    };
}
