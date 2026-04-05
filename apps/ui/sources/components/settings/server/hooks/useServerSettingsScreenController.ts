import * as React from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { Modal } from '@/modal';
import { t } from '@/text';
import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { validateServerUrl } from '@/sync/domains/server/serverConfig';
import {
    getActiveServerId,
    getActiveServerSnapshot,
    getDeviceDefaultServerId,
    getResetToDefaultServerId,
    listServerProfiles,
    setActiveServerId,
    type ServerProfile,
    removeServerProfile,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import {
    filterServerSelectionGroupsToAvailableServers,
    normalizeStoredServerSelectionGroups,
} from '@/sync/domains/server/selection/serverSelectionMutations';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { isInsecureRemoteHttpServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { useAuth } from '@/auth/context/AuthContext';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { parseServerSettingsRouteParams } from '@/components/settings/server/navigation/serverSettingsRouteParams';
import { useServerAuthStatusByServerId } from '@/components/settings/server/hooks/useServerAuthStatusByServerId';
import { useServerAutoAddFromRoute } from '@/components/settings/server/hooks/useServerAutoAddFromRoute';
import { useServerSettingsServerProfileActions } from '@/components/settings/server/hooks/useServerSettingsServerProfileActions';
import { useServerSettingsGroupActions } from '@/components/settings/server/hooks/useServerSettingsGroupActions';
import { useServerSettingsConcurrentActions } from '@/components/settings/server/hooks/useServerSettingsConcurrentActions';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import type { RelayDriftBanner } from '@/components/settings/server/relayDriftTypes';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { clearPendingNotificationNav, getPendingNotificationNav } from '@/sync/domains/pending/pendingNotificationNav';
import { readServerReachabilityProbeTimeoutMs } from '@/sync/runtime/connectivity/serverReachabilityTuning';
import { createEndpointReadinessProbe } from '@/sync/runtime/connectivity/createEndpointReadinessProbe';
import {
    resolveEndpointReachabilityRemediation,
    type EndpointReachabilityRemediation,
    type EndpointReachabilityRemediationAction,
} from '@/sync/runtime/connectivity/resolveEndpointReachabilityRemediation';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { createTailscaleEnsureReadyTaskSpec } from '@happier-dev/protocol';

type SearchParams = Readonly<{ url?: string | string[]; auto?: string | string[]; source?: string | string[] }>;

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

function shouldWarnAboutInsecureHttpServerUrl(rawUrl: string): boolean {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) return false;
    return isInsecureRemoteHttpServerUrl(normalized);
}

export type ServerSettingsController = Readonly<{
    screenOptions: Readonly<{ headerShown: true; headerTitle: string; headerBackTitle: string }>;

    servers: ReadonlyArray<ServerProfile>;
    serverGroups: ReadonlyArray<ServerSelectionGroup>;
    activeServerId: string;
    activeServerUrl: string;
    activeLocalRelayUrl: string | null;
    deviceDefaultServerId: string;
    activeTargetKey: string | null;
    authStatusByServerId: Readonly<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>;
    relayDriftBanner: RelayDriftBanner | null;

    autoMode: boolean;
    inputUrl: string;
    inputName: string;
    error: string | null;
    isValidating: boolean;
    reachabilityRemediation: EndpointReachabilityRemediation | null;
    reachabilityRemediationTaskSnapshot: SystemTaskRunState | null;
    addServerPrefillHint: string | null;
    addServerDefaultExpanded: 'server' | 'group' | null;
    onChangeUrl: (value: string) => void;
    onChangeName: (value: string) => void;
    onResetServer: () => Promise<void>;
    onAddServer: () => Promise<void>;
    onReachabilityRemediationAction: (actionId: EndpointReachabilityRemediationAction['id']) => Promise<void>;

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
    const relayDriftBanner = useRelayDriftBanner();
    const searchParams = useLocalSearchParams<SearchParams>();

    const [revision, setRevision] = React.useState(0);
    const [inputUrl, setInputUrl] = React.useState('');
    const [inputName, setInputName] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [isValidating, setIsValidating] = React.useState(false);
    const [reachabilityRemediation, setReachabilityRemediation] = React.useState<EndpointReachabilityRemediation | null>(null);
    const [tailscaleEnsureReadyTaskId, setTailscaleEnsureReadyTaskId] = React.useState<string | null>(null);
    const validationAttemptIdRef = React.useRef(0);
    const validationAbortControllerRef = React.useRef<AbortController | null>(null);
    const handledTailscaleEnsureReadyTaskIdRef = React.useRef<string | null>(null);
    const systemTaskRunner = React.useMemo(() => getDefaultSystemTaskRunner(), []);

    const [serverSelectionGroups, setServerSelectionGroups] = useSettingMutable('serverSelectionGroups');
    const [serverSelectionActiveTargetKind, setServerSelectionActiveTargetKind] = useSettingMutable('serverSelectionActiveTargetKind');
    const [serverSelectionActiveTargetId, setServerSelectionActiveTargetId] = useSettingMutable('serverSelectionActiveTargetId');
    const tailscaleEnsureReadySnapshot = useSystemTaskSnapshot(systemTaskRunner, tailscaleEnsureReadyTaskId);
    const isPreparingTailscale = tailscaleEnsureReadyTaskId != null && tailscaleEnsureReadySnapshot?.result == null;

    const route = React.useMemo(() => {
        return parseServerSettingsRouteParams({ url: searchParams.url, auto: searchParams.auto, source: searchParams.source });
    }, [searchParams.auto, searchParams.source, searchParams.url]);
    const autoMode = route.auto;
    const addServerPrefillHint = route.source === 'notification' && route.url ? t('server.notificationAddServerHint') : null;
    const addServerDefaultExpanded = route.source === 'notification' && route.url ? ('server' as const) : null;

    const switchServerById = React.useCallback(async (serverId: string, opts?: { normalizeRoute?: boolean }) => {
        setActiveServerId(serverId, { scope: 'device' });
        await switchConnectionToActiveServer();
        await auth.refreshFromActiveServer();
        if (opts?.normalizeRoute ?? true) {
            router.replace('/server');
        }
    }, [auth, router]);

    const validateServerReachable = React.useCallback(async (url: string): Promise<boolean> => {
        const attemptId = (validationAttemptIdRef.current += 1);
        validationAbortControllerRef.current?.abort();
        const controller = new AbortController();
        validationAbortControllerRef.current = controller;
        try {
            setIsValidating(true);
            setError(null);
            setReachabilityRemediation(null);

            const normalized = normalizeUrl(url);
            if (!normalized) {
                setError(t('errors.invalidFormat'));
                return false;
            }

            const timeoutMs = readServerReachabilityProbeTimeoutMs();
            const probe = createEndpointReadinessProbe({
                endpoint: normalized,
                token: null,
                timeoutMs,
                signal: controller.signal,
            });
            const result = await probe();

            if (attemptId !== validationAttemptIdRef.current) {
                return false;
            }

            if (result.status === 'ready') return true;

            setReachabilityRemediation(resolveEndpointReachabilityRemediation({
                endpointUrl: normalized,
                readiness: result,
                platformOs: Platform.OS,
                isDesktopShell: isTauriDesktop(),
            }));

            const message = typeof result.errorMessage === 'string' ? result.errorMessage : '';
            if (message.includes('returned')) {
                setError(t('server.serverReturnedError'));
            } else {
                setError(t('server.failedToConnectToServer'));
            }
            return false;
        } catch {
            if (attemptId === validationAttemptIdRef.current) {
                const normalized = normalizeUrl(url);
                if (normalized) {
                    setReachabilityRemediation(resolveEndpointReachabilityRemediation({
                        endpointUrl: normalized,
                        readiness: {
                            status: 'server_unreachable',
                            errorMessage: 'Network request failed',
                        },
                        platformOs: Platform.OS,
                        isDesktopShell: isTauriDesktop(),
                    }));
                }
                setError(t('server.failedToConnectToServer'));
            }
            return false;
        } finally {
            if (attemptId === validationAttemptIdRef.current) {
                setIsValidating(false);
            }
        }
    }, []);

    const onReachabilityRemediationAction = React.useCallback(async (
        actionId: EndpointReachabilityRemediationAction['id'],
    ) => {
        const remediation = reachabilityRemediation;
        if (!remediation) return;
        const action = remediation.actions.find((candidate) => candidate.id === actionId);
        if (!action) return;

        if (action.kind === 'retry') {
            await validateServerReachable(inputUrl);
            return;
        }

        if (action.kind === 'external-url') {
            const opened = await openExternalUrl(action.url, { platformOS: Platform.OS });
            if (!opened) {
                await Modal.alert(t('common.error'), t('server.reachabilityRemediation.failedToOpenInstallLink'));
            }
            return;
        }

        if (action.kind === 'callback' && action.callbackSlot === 'tailscale.ensureReady') {
            try {
                const taskId = await systemTaskRunner.start(createTailscaleEnsureReadyTaskSpec({
                    installPolicy: 'installIfMissing',
                    loginPolicy: 'interactive',
                    mode: 'normalUser',
                }));
                handledTailscaleEnsureReadyTaskIdRef.current = null;
                setTailscaleEnsureReadyTaskId(taskId);
            } catch {
                const message = t('settings.systemTaskStartFailed');
                setError(message);
                await Modal.alert(t('common.error'), message);
            }
        }
    }, [inputUrl, reachabilityRemediation, systemTaskRunner, validateServerReachable]);

    React.useEffect(() => {
        const result = tailscaleEnsureReadySnapshot?.result;
        if (!result) return;
        if (handledTailscaleEnsureReadyTaskIdRef.current === tailscaleEnsureReadySnapshot.taskId) {
            return;
        }
        handledTailscaleEnsureReadyTaskIdRef.current = tailscaleEnsureReadySnapshot.taskId;
        if (!result.ok) {
            const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
            setError(message || t('settings.systemTaskStartFailed'));
            setTailscaleEnsureReadyTaskId(null);
            return;
        }
        void (async () => {
            try {
                setReachabilityRemediation(null);
                await validateServerReachable(inputUrl);
            } finally {
                setTailscaleEnsureReadyTaskId((current) => (current === tailscaleEnsureReadySnapshot.taskId ? null : current));
            }
        })();
    }, [inputUrl, tailscaleEnsureReadySnapshot, validateServerReachable]);

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
    const activeServerUrl = React.useMemo(() => {
        return servers.find((profile) => profile.id === activeServerIdValue)?.serverUrl ?? '';
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

        if (shouldWarnAboutInsecureHttpServerUrl(inputUrl)) {
            const shouldContinue = await Modal.confirm(
                t('server.insecureHttpUrlTitle'),
                t('server.insecureHttpUrlBody'),
                { confirmText: t('common.ok'), cancelText: t('common.cancel') },
            );
            if (!shouldContinue) return;
        }

        const isValid = await validateServerReachable(inputUrl);
        if (!isValid) return;

        const normalized = normalizeUrl(inputUrl);
        const name = inputName.trim() ? inputName.trim() : defaultServerName(normalized);
        const created = upsertServerProfile({
            serverUrl: normalized,
            name,
            source: 'manual',
        });

        let profile = created;
        try {
            const featuresSnapshot = await getServerFeaturesSnapshot({ serverId: created.id, force: true, timeoutMs: 1000 });
            if (featuresSnapshot.status === 'ready') {
                const advertisedRaw = featuresSnapshot.features.capabilities?.server?.canonicalServerUrl;
                const advertised = typeof advertisedRaw === 'string' ? normalizeUrl(advertisedRaw) : '';
                if (advertised && advertised !== created.serverUrl) {
                    const confirm = await Modal.confirm(
                        t('server.useCanonicalServerUrlTitle'),
                        t('server.useCanonicalServerUrlBody'),
                        { confirmText: t('common.use'), cancelText: t('common.keep') },
                    );
                    if (confirm) {
                        const canonical = upsertServerProfile({
                            serverUrl: advertised,
                            name: created.name,
                            source: 'manual',
                        });
                        if (canonical.id !== created.id) {
                            try {
                                removeServerProfile(created.id);
                            } catch {
                                // ignore; best-effort cleanup
                            }
                        }
                        profile = canonical;
                    }
                }
            }
        } catch {
            // best-effort
        }

        await switchServerById(profile.id, { normalizeRoute: route.source !== 'notification' });
        setRevision((r) => r + 1);

        if (route.source === 'notification' && route.url) {
            const pending = getPendingNotificationNav();
            const intended = normalizeUrl(route.url);
            if (pending && intended && normalizeUrl(pending.serverUrl) === intended && pending.route) {
                clearPendingNotificationNav();
                router.replace(pending.route);
            }
        }
    }, [inputName, inputUrl, route.source, route.url, router, switchServerById, validateServerReachable]);

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
        activeServerUrl,
        activeLocalRelayUrl,
        deviceDefaultServerId,
        activeTargetKey,
        authStatusByServerId,
        relayDriftBanner,

        autoMode,
        inputUrl,
        inputName,
        error,
        isValidating: isValidating || isPreparingTailscale,
        reachabilityRemediation,
        reachabilityRemediationTaskSnapshot: tailscaleEnsureReadySnapshot ?? null,
        addServerPrefillHint,
        addServerDefaultExpanded,
        onChangeUrl: (value) => {
            setInputUrl(value);
            setError(null);
            setReachabilityRemediation(null);
        },
        onChangeName: setInputName,
        onResetServer,
        onAddServer,
        onReachabilityRemediationAction,

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
            const nextGroupId = (() => {
                if (activeMultiServerProfileId) return activeMultiServerProfileId;
                if (activeServerIdValue) {
                    const candidates = normalizedGroupProfiles.filter((profile) => profile.serverIds.includes(activeServerIdValue));
                    if (candidates.length > 0) {
                        const multiServerCandidates = candidates.filter((profile) => profile.serverIds.length > 1);
                        const pool = multiServerCandidates.length > 0 ? multiServerCandidates : candidates;
                        let best = pool[0]!;
                        for (const candidate of pool.slice(1)) {
                            if (candidate.serverIds.length > best.serverIds.length) {
                                best = candidate;
                            }
                        }
                        return best.id;
                    }
                }
                return normalizedGroupProfiles[0]?.id ?? null;
            })();
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
