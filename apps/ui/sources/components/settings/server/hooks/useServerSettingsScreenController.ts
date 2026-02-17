import * as React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Modal } from '@/modal';
import { t } from '@/text';
import { validateServerUrl } from '@/sync/domains/server/serverConfig';
import {
    getActiveServerId,
    getDeviceDefaultServerId,
    getResetToDefaultServerId,
    listServerProfiles,
    setActiveServerId,
    type ServerProfile,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    filterServerSelectionGroupsToAvailableServers,
    normalizeStoredServerSelectionGroups,
} from '@/sync/domains/server/selection/serverSelectionMutations';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { useAuth } from '@/auth/context/AuthContext';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { parseServerSettingsRouteParams } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { useServerAuthStatusByServerId } from '@/components/settings/server/hooks/useServerAuthStatusByServerId';
import { useServerAutoAddFromRoute } from '@/components/settings/server/hooks/useServerAutoAddFromRoute';
import { useServerSettingsServerProfileActions } from '@/components/settings/server/hooks/useServerSettingsServerProfileActions';
import { useServerSettingsGroupActions } from '@/components/settings/server/hooks/useServerSettingsGroupActions';
import { useServerSettingsConcurrentActions } from '@/components/settings/server/hooks/useServerSettingsConcurrentActions';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

type SearchParams = Readonly<{ url?: string | string[]; auto?: string | string[] }>;

function normalizeUrl(raw: string): string {
    return canonicalizeServerUrl(raw);
}

function defaultServerName(rawUrl: string): string {
    const url = normalizeUrl(rawUrl);
    try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        if (!host) return url;
        return parsed.port ? `${host}:${parsed.port}` : host;
    } catch {
        return url;
    }
}

export type ServerSettingsController = Readonly<{
    screenOptions: Readonly<{ headerShown: true; headerTitle: string; headerBackTitle: string }>;

    servers: ReadonlyArray<ServerProfile>;
    serverGroups: ReadonlyArray<ServerSelectionGroup>;
    activeServerId: string;
    deviceDefaultServerId: string;
    activeTargetKey: string | null;
    authStatusByServerId: Readonly<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>;

    autoMode: boolean;
    inputUrl: string;
    inputName: string;
    error: string | null;
    isValidating: boolean;
    onChangeUrl: (value: string) => void;
    onChangeName: (value: string) => void;
    onResetServer: () => Promise<void>;
    onAddServer: () => Promise<void>;

    onSwitchServer: (profile: ServerProfile) => Promise<void>;
    onSwitchGroup: (profile: ServerSelectionGroup) => Promise<void>;
    onRenameServer: (profile: ServerProfile) => Promise<void>;
    onRemoveServer: (profile: ServerProfile) => Promise<void>;
    onRenameGroup: (profile: ServerSelectionGroup) => Promise<void>;
    onRemoveGroup: (profile: ServerSelectionGroup) => Promise<void>;
    onCreateServerGroup: (params: { name: string; serverIds: string[] }) => Promise<boolean>;

    groupSelectionEnabled: boolean;
    setGroupSelectionEnabled: (value: boolean) => void;
    groupSelectionPresentation: 'grouped' | 'flat-with-badge';
    activeServerGroupId: string | null;
    selectedGroupServerIds: ReadonlySet<string>;
    onToggleGroupPresentation: () => void;
    onToggleGroupServer: (serverId: string) => void;
}>;

export function useServerSettingsScreenController(): ServerSettingsController {
    const router = useRouter();
    const auth = useAuth();
    const searchParams = useLocalSearchParams<SearchParams>();

    const [revision, setRevision] = React.useState(0);
    const [inputUrl, setInputUrl] = React.useState('');
    const [inputName, setInputName] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [isValidating, setIsValidating] = React.useState(false);

    const [serverSelectionGroups, setServerSelectionGroups] = useSettingMutable('serverSelectionGroups');
    const [serverSelectionActiveTargetKind, setServerSelectionActiveTargetKind] = useSettingMutable('serverSelectionActiveTargetKind');
    const [serverSelectionActiveTargetId, setServerSelectionActiveTargetId] = useSettingMutable('serverSelectionActiveTargetId');

    const route = React.useMemo(() => {
        return parseServerSettingsRouteParams({ url: searchParams.url, auto: searchParams.auto });
    }, [searchParams.auto, searchParams.url]);
    const autoMode = route.auto;

    const switchServerById = React.useCallback(async (serverId: string, opts?: { normalizeRoute?: boolean }) => {
        setActiveServerId(serverId, { scope: 'device' });
        await switchConnectionToActiveServer();
        await auth.refreshFromActiveServer();
        if (opts?.normalizeRoute ?? true) {
            router.replace('/server');
        }
    }, [auth, router]);

    const validateServerReachable = React.useCallback(async (url: string): Promise<boolean> => {
        try {
            setIsValidating(true);
            setError(null);

            const normalized = normalizeUrl(url);
            if (!normalized) {
                setError(t('errors.invalidFormat'));
                return false;
            }

            const versionRes = await runtimeFetch(`${normalized}/v1/version`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            });
            if (!versionRes.ok) {
                setError(t('server.serverReturnedError'));
                return false;
            }
            return true;
        } catch {
            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            setIsValidating(false);
        }
    }, []);

    useServerAutoAddFromRoute({
        enabled: autoMode,
        url: route.url,
        validateServerReachable,
        setError,
        onSwitchServerById: async (serverId, opts) => switchServerById(serverId, opts),
        onAfterSuccess: () => {
            setRevision((r) => r + 1);
            router.replace('/');
        },
        source: 'url',
    });

    React.useEffect(() => {
        if (!route.url) return;
        if (autoMode || !inputUrl.trim()) {
            if (inputUrl.trim() !== route.url) setInputUrl(route.url);
            if (error) setError(null);
        }
    }, [autoMode, error, inputUrl, route.url]);

    const servers = React.useMemo(() => {
        try {
            return listServerProfiles()
                .slice();
        } catch {
            return [] as ServerProfile[];
        }
    }, [revision]);

    const validServerIds = React.useMemo(() => new Set(servers.map((profile) => profile.id)), [servers]);

    const storedGroupProfiles = React.useMemo(() => normalizeStoredServerSelectionGroups(serverSelectionGroups), [serverSelectionGroups]);
    const normalizedGroupProfiles = React.useMemo(() => filterServerSelectionGroupsToAvailableServers(storedGroupProfiles, validServerIds), [storedGroupProfiles, validServerIds]);

    const activeServerIdValue = React.useMemo(() => {
        try {
            return getActiveServerId();
        } catch {
            return getResetToDefaultServerId();
        }
    }, [revision]);

    const deviceDefaultServerId = React.useMemo(() => {
        try {
            return getDeviceDefaultServerId();
        } catch {
            return getResetToDefaultServerId();
        }
    }, [revision]);

    const activeTargetKey = React.useMemo(() => {
        const kind = serverSelectionActiveTargetKind === 'server' || serverSelectionActiveTargetKind === 'group'
            ? serverSelectionActiveTargetKind
            : null;
        const id = typeof serverSelectionActiveTargetId === 'string' ? serverSelectionActiveTargetId.trim() : '';
        if (kind && id) return `${kind}:${id}`;
        return activeServerIdValue ? `server:${activeServerIdValue}` : null;
    }, [activeServerIdValue, serverSelectionActiveTargetId, serverSelectionActiveTargetKind]);

    const authStatusByServerId = useServerAuthStatusByServerId(servers);

    React.useEffect(() => {
        const normalizedStored = normalizeStoredServerSelectionGroups(serverSelectionGroups);
        const rawComparable = Array.isArray(serverSelectionGroups) ? serverSelectionGroups : [];
        if (JSON.stringify(normalizedStored) !== JSON.stringify(rawComparable)) {
            setServerSelectionGroups(normalizedStored as any);
            return;
        }
        const kind = serverSelectionActiveTargetKind === 'server' || serverSelectionActiveTargetKind === 'group'
            ? serverSelectionActiveTargetKind
            : null;
        const id = String(serverSelectionActiveTargetId ?? '').trim();
        if (kind === 'group' && id && !normalizedStored.some((profile) => profile.id === id)) {
            setServerSelectionActiveTargetKind('server');
            setServerSelectionActiveTargetId(activeServerIdValue || null);
        }
    }, [
        activeServerIdValue,
        serverSelectionActiveTargetId,
        serverSelectionActiveTargetKind,
        serverSelectionGroups,
        setServerSelectionActiveTargetId,
        setServerSelectionActiveTargetKind,
        setServerSelectionGroups,
    ]);

    const activeMultiServerProfileId = React.useMemo(() => {
        if (serverSelectionActiveTargetKind !== 'group') return null;
        const id = String(serverSelectionActiveTargetId ?? '').trim();
        return id || null;
    }, [serverSelectionActiveTargetId, serverSelectionActiveTargetKind]);

    const selectedConcurrentServerIds = React.useMemo(() => {
        const activeGroup = activeMultiServerProfileId
            ? normalizedGroupProfiles.find((profile) => profile.id === activeMultiServerProfileId) ?? null
            : null;
        if (activeGroup) return new Set(activeGroup.serverIds);
        return activeServerIdValue ? new Set([activeServerIdValue]) : new Set<string>();
    }, [activeMultiServerProfileId, activeServerIdValue, normalizedGroupProfiles]);

    const concurrentActions = useServerSettingsConcurrentActions({
        activeGroupId: activeMultiServerProfileId,
        serverSelectionGroupsRaw: serverSelectionGroups,
        setServerSelectionGroups: (value) => setServerSelectionGroups(value as any),
    });

    const profileActions = useServerSettingsServerProfileActions({
        authStatusByServerId,
        onSwitchServerById: async (serverId) => switchServerById(serverId),
        onAfterSignedOutSwitch: () => router.replace('/'),
        setRevision,
        setServerSelectionActiveTargetKind,
        setServerSelectionActiveTargetId,
    });

    const groupActions = useServerSettingsGroupActions({
        servers,
        activeServerId: activeServerIdValue,
        validServerIds,
        authStatusByServerId,
        normalizedGroupProfiles,
        activeGroupId: activeMultiServerProfileId,
        groupPresentation: (
            normalizedGroupProfiles.find((profile) => profile.id === activeMultiServerProfileId)?.presentation
            ?? 'grouped'
        ) === 'flat-with-badge' ? 'flat-with-badge' : 'grouped',
        setRevision,
        onSwitchServerById: async (serverId) => switchServerById(serverId),
        onAfterSignedOutSwitch: () => router.replace('/'),
        setServerSelectionActiveTargetKind,
        setServerSelectionActiveTargetId,
        setServerSelectionGroups: (value) => setServerSelectionGroups(value as any),
    });

    const onAddServer = React.useCallback(async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        const isValid = await validateServerReachable(inputUrl);
        if (!isValid) return;

        const normalized = normalizeUrl(inputUrl);
        const name = inputName.trim() ? inputName.trim() : defaultServerName(normalized);
        const profile = upsertServerProfile({
            serverUrl: normalized,
            name,
            source: 'manual',
        });

        await switchServerById(profile.id);
        setRevision((r) => r + 1);
    }, [inputName, inputUrl, switchServerById, validateServerReachable]);

    const onResetServer = React.useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            await switchServerById(getResetToDefaultServerId());
            setInputUrl('');
            setInputName('');
            setRevision((r) => r + 1);
        }
    }, [switchServerById]);

    const screenOptions = React.useMemo(() => ({
        headerShown: true as const,
        headerTitle: t('server.serverConfiguration'),
        headerBackTitle: t('common.back'),
    }), []);

    return {
        screenOptions,

        servers,
        serverGroups: normalizedGroupProfiles,
        activeServerId: activeServerIdValue,
        deviceDefaultServerId,
        activeTargetKey,
        authStatusByServerId,

        autoMode,
        inputUrl,
        inputName,
        error,
        isValidating,
        onChangeUrl: (value) => {
            setInputUrl(value);
            setError(null);
        },
        onChangeName: setInputName,
        onResetServer,
        onAddServer,

        onSwitchServer: profileActions.onSwitchServer,
        onSwitchGroup: groupActions.onSwitchGroup,
        onRenameServer: profileActions.onRenameServer,
        onRemoveServer: profileActions.onRemoveServer,
        onRenameGroup: groupActions.onRenameGroup,
        onRemoveGroup: groupActions.onRemoveGroup,
        onCreateServerGroup: groupActions.onCreateServerGroup,

        groupSelectionEnabled: serverSelectionActiveTargetKind === 'group',
        setGroupSelectionEnabled: (value) => {
            if (!value) {
                setServerSelectionActiveTargetKind('server');
                setServerSelectionActiveTargetId(activeServerIdValue || null);
                return;
            }
            const nextGroupId = activeMultiServerProfileId ?? normalizedGroupProfiles[0]?.id ?? null;
            if (!nextGroupId) return;
            setServerSelectionActiveTargetKind('group');
            setServerSelectionActiveTargetId(nextGroupId);
        },
        groupSelectionPresentation: (
            normalizedGroupProfiles.find((profile) => profile.id === activeMultiServerProfileId)?.presentation
            ?? 'grouped'
        ) === 'flat-with-badge' ? 'flat-with-badge' : 'grouped',
        activeServerGroupId: activeMultiServerProfileId,
        selectedGroupServerIds: selectedConcurrentServerIds,
        onToggleGroupPresentation: concurrentActions.onTogglePresentation,
        onToggleGroupServer: concurrentActions.onToggleConcurrentServer,
    };
}
