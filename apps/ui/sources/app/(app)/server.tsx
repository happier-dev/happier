import React, { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { type ItemAction } from '@/components/ui/lists/itemActions';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Modal } from '@/modal';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { validateServerUrl } from '@/sync/domains/server/serverConfig';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { parseServerConfigRouteParams } from './serverParams';
import { type ServerProfile, getActiveServerId, getResetToDefaultServerId, isCloudServerProfileId, listServerProfiles, removeServerProfile, renameServerProfile, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { filterMultiServerGroupProfilesToAvailable, normalizeStoredMultiServerGroupProfiles, toggleMultiServerGroupServerIdEnsuringNonEmpty, type MultiServerGroupProfile } from '@/sync/domains/server/multiServerGroups';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { Ionicons } from '@expo/vector-icons';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { useAuth } from '@/auth/context/AuthContext';
import { Switch } from '@/components/ui/forms/Switch';
import { useSettingMutable } from '@/sync/domains/state/storage';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: theme.colors.surface,
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: theme.colors.input.background,
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 14,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 12,
    },
    buttonWrapper: {
        flex: 1,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

function normalizeUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
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

function toGroupProfileId(rawName: string): string {
    const base = String(rawName ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-');
    return base || `group-${Date.now()}`;
}

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const auth = useAuth();
    const searchParams = useLocalSearchParams();
    const [revision, setRevision] = React.useState(0);
    const [inputUrl, setInputUrl] = useState('');
    const [inputName, setInputName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const [authStatusByServerId, setAuthStatusByServerId] = React.useState<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>({});
    const [multiServerEnabled, setMultiServerEnabled] = useSettingMutable('multiServerEnabled');
    const [multiServerSelectedServerIds, setMultiServerSelectedServerIds] = useSettingMutable('multiServerSelectedServerIds');
    const [multiServerPresentation, setMultiServerPresentation] = useSettingMutable('multiServerPresentation');
    const [multiServerProfiles, setMultiServerProfiles] = useSettingMutable('multiServerProfiles');
    const [multiServerActiveProfileId, setMultiServerActiveProfileId] = useSettingMutable('multiServerActiveProfileId');
    const autoHandledRef = React.useRef(false);
    const seedSelectedServerIdsRef = React.useRef<string[]>(
        Array.isArray(multiServerSelectedServerIds) ? multiServerSelectedServerIds : [],
    );
    const route = React.useMemo(() => {
        return parseServerConfigRouteParams({ url: searchParams.url, auto: searchParams.auto });
    }, [searchParams.auto, searchParams.url]);

    const autoMode = route.auto;

    const switchServer = React.useCallback(async (serverId: string, scope: 'tab' | 'device' = 'device') => {
        setActiveServerId(serverId, { scope });
        await switchConnectionToActiveServer();
        await auth.refreshFromActiveServer();
    }, [auth]);

    const validateServer = async (url: string): Promise<boolean> => {
        try {
            setIsValidating(true);
            setError(null);

            const normalized = url.trim().replace(/\/+$/, '');

            // Prefer a stable API endpoint when available.
            try {
                const versionRes = await fetch(`${normalized}/v1/version`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                });
                if (versionRes.ok) return true;
            } catch {
                // Fall through to legacy probe.
            }

            // Legacy probe: older servers might only expose a root text response.
            const response = await fetch(normalized, {
                method: 'GET',
                headers: { 'Accept': 'text/plain' },
            });

            if (!response.ok) {
                setError(t('server.serverReturnedError'));
                return false;
            }

            const text = await response.text();
            if (!text.includes('Welcome to Happier Server!')) {
                setError(t('server.notValidHappyServer'));
                return false;
            }

            return true;
        } catch (err) {
            setError(t('server.failedToConnectToServer'));
            return false;
        } finally {
            setIsValidating(false);
        }
    };

    React.useEffect(() => {
        if (!autoMode) return;
        if (!route.url) return;
        if (autoHandledRef.current) return;
        autoHandledRef.current = true;

        void (async () => {
            const url = typeof route.url === 'string' ? route.url : null;
            if (!url) return;
            const validation = validateServerUrl(url);
            if (!validation.valid) {
                setError(validation.error || t('errors.invalidFormat'));
                return;
            }

            const isValid = await validateServer(url);
            if (!isValid) return;

            const normalized = normalizeUrl(url);
            const name = defaultServerName(normalized);
            const profile = upsertServerProfile({
                serverUrl: normalized,
                name,
                source: autoMode ? 'url' : 'manual',
            });

            await switchServer(profile.id, 'device');

            setRevision((r) => r + 1);
            router.replace('/');
        })();
    }, [autoMode, route.url, router, switchServer]);

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
                .slice()
                .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
        } catch {
            return [] as ServerProfile[];
        }
    }, [revision]);

    const validServerIds = React.useMemo(() => {
        return new Set(servers.map((profile) => profile.id));
    }, [servers]);

    const storedMultiServerProfiles = React.useMemo(() => {
        return normalizeStoredMultiServerGroupProfiles(multiServerProfiles);
    }, [multiServerProfiles]);

    const normalizedMultiServerProfiles = React.useMemo(() => {
        return filterMultiServerGroupProfilesToAvailable(storedMultiServerProfiles, validServerIds);
    }, [storedMultiServerProfiles, validServerIds]);

    const activeMultiServerProfileId = React.useMemo(() => {
        const id = String(multiServerActiveProfileId ?? '').trim();
        return id || null;
    }, [multiServerActiveProfileId]);

    const activeMultiServerProfile = React.useMemo(() => {
        if (!activeMultiServerProfileId) return null;
        return normalizedMultiServerProfiles.find((profile) => profile.id === activeMultiServerProfileId) ?? null;
    }, [activeMultiServerProfileId, normalizedMultiServerProfiles]);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            const entries = await Promise.all(servers.map(async (profile) => {
                try {
                    const creds = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
                    return [profile.id, creds ? 'signedIn' : 'signedOut'] as const;
                } catch {
                    return [profile.id, 'unknown'] as const;
                }
            }));
            if (cancelled) return;
            const next: Record<string, 'signedIn' | 'signedOut' | 'unknown'> = {};
            for (const [id, status] of entries) next[id] = status;
            setAuthStatusByServerId(next);
        })();
        return () => {
            cancelled = true;
        };
    }, [servers]);

    React.useEffect(() => {
        const current = Array.isArray(multiServerSelectedServerIds) ? multiServerSelectedServerIds : [];
        seedSelectedServerIdsRef.current = current;
        if (validServerIds.size === 0) return;
        const next = current.filter((id) => validServerIds.has(id));
        if (next.length !== current.length || next.some((id, index) => id !== current[index])) {
            setMultiServerSelectedServerIds(next);
        }
    }, [multiServerSelectedServerIds, setMultiServerSelectedServerIds, validServerIds]);

    React.useEffect(() => {
        const normalizedStored = normalizeStoredMultiServerGroupProfiles(multiServerProfiles);
        const rawComparable = Array.isArray(multiServerProfiles) ? multiServerProfiles : [];
        if (JSON.stringify(normalizedStored) !== JSON.stringify(rawComparable)) {
            setMultiServerProfiles(normalizedStored as any);
            return;
        }
        const id = String(multiServerActiveProfileId ?? '').trim();
        if (id && !normalizedStored.some((profile) => profile.id === id)) {
            setMultiServerActiveProfileId(null);
        }
    }, [
        multiServerActiveProfileId,
        multiServerProfiles,
        setMultiServerActiveProfileId,
        setMultiServerProfiles,
    ]);

    const selectedConcurrentServerIds = React.useMemo(() => {
        if (activeMultiServerProfile) {
            return new Set(activeMultiServerProfile.serverIds);
        }
        return new Set(Array.isArray(multiServerSelectedServerIds) ? multiServerSelectedServerIds : []);
    }, [activeMultiServerProfile, multiServerSelectedServerIds]);

    const activeServerId = React.useMemo(() => {
        try {
            return getActiveServerId();
        } catch {
            return getResetToDefaultServerId();
        }
    }, [revision]);

    const handleAddServer = async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        // Validate the server
        const isValid = await validateServer(inputUrl);
        if (!isValid) {
            return;
        }

        const normalized = normalizeUrl(inputUrl);
        const name = inputName.trim() ? inputName.trim() : defaultServerName(normalized);
        const profile = upsertServerProfile({
            serverUrl: normalized,
            name,
            source: 'manual',
        });

        await switchServer(profile.id, 'device');

        setRevision((r) => r + 1);
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            await switchServer(getResetToDefaultServerId(), 'device');
            setInputUrl('');
            setInputName('');
            setRevision((r) => r + 1);
        }
    };

    const handleSwitch = React.useCallback(async (profile: ServerProfile, scope: 'tab' | 'device' = 'device') => {
        await switchServer(profile.id, scope);
        setRevision((r) => r + 1);
    }, [switchServer]);

    const handleToggleConcurrentServer = React.useCallback((serverId: string) => {
        if (activeMultiServerProfileId) {
            const currentProfiles = normalizeStoredMultiServerGroupProfiles(multiServerProfiles);
            const nextProfiles = currentProfiles.map((profile) => {
                if (profile.id !== activeMultiServerProfileId) return profile;
                const toggle = toggleMultiServerGroupServerIdEnsuringNonEmpty(profile.serverIds, serverId);
                if (toggle.preventedEmpty) {
                    Modal.alert(t('common.error'), 'A server group must include at least one server.');
                    return profile;
                }
                const serverIds = toggle.nextServerIds;
                return {
                    ...profile,
                    serverIds,
                };
            });
            setMultiServerProfiles(nextProfiles as any);
            return;
        }

        const current = Array.isArray(multiServerSelectedServerIds) ? multiServerSelectedServerIds : [];
        const toggle = toggleMultiServerGroupServerIdEnsuringNonEmpty(current, serverId);
        if (toggle.preventedEmpty) {
            Modal.alert(t('common.error'), 'At least one server must be selected.');
            return;
        }
        seedSelectedServerIdsRef.current = toggle.nextServerIds;
        setMultiServerSelectedServerIds(toggle.nextServerIds);
    }, [
        activeMultiServerProfileId,
        multiServerProfiles,
        multiServerSelectedServerIds,
        setMultiServerProfiles,
        setMultiServerSelectedServerIds,
    ]);

    const handleTogglePresentation = React.useCallback(() => {
        if (activeMultiServerProfileId) {
            const currentProfiles = normalizeStoredMultiServerGroupProfiles(multiServerProfiles);
            const nextProfiles = currentProfiles.map((profile) => {
                if (profile.id !== activeMultiServerProfileId) return profile;
                return {
                    ...profile,
                    presentation: profile.presentation === 'grouped' ? 'flat-with-badge' : 'grouped',
                };
            });
            setMultiServerProfiles(nextProfiles as any);
            return;
        }
        setMultiServerPresentation(multiServerPresentation === 'grouped' ? 'flat-with-badge' : 'grouped');
    }, [
        activeMultiServerProfileId,
        multiServerPresentation,
        multiServerProfiles,
        setMultiServerPresentation,
        setMultiServerProfiles,
    ]);

    const handleActivateConcurrentProfile = React.useCallback((profileId: string | null) => {
        setMultiServerActiveProfileId(profileId);
    }, [setMultiServerActiveProfileId]);

    const handleCreateConcurrentProfile = React.useCallback(async () => {
        const name = await Modal.prompt(
            'Save server group',
            'Name this server group profile',
            { placeholder: 'My server group' },
        );
        if (!name) return;
        const trimmedName = name.trim();
        if (!trimmedName) return;

        const baseId = toGroupProfileId(trimmedName);
        const existingIds = new Set(normalizedMultiServerProfiles.map((profile) => profile.id));
        let id = baseId;
        let suffix = 2;
        while (existingIds.has(id)) {
            id = `${baseId}-${suffix}`;
            suffix += 1;
        }

        const seedSourceIds = activeMultiServerProfile
            ? activeMultiServerProfile.serverIds
            : seedSelectedServerIdsRef.current;
        const seedServerIds = Array.from(new Set(seedSourceIds.map((value) => String(value ?? '').trim()).filter(Boolean)));
        if (seedServerIds.length === 0 && activeServerId) {
            seedServerIds.push(activeServerId);
        }
        const presentation = activeMultiServerProfile?.presentation
            ?? (multiServerPresentation === 'flat-with-badge' ? 'flat-with-badge' : 'grouped');
        const nextProfile: MultiServerGroupProfile = {
            id,
            name: trimmedName,
            serverIds: seedServerIds,
            presentation,
        };
        const nextProfiles = [...normalizedMultiServerProfiles, nextProfile];
        setMultiServerProfiles(nextProfiles as any);
        setMultiServerActiveProfileId(nextProfile.id);
    }, [
        activeServerId,
        activeMultiServerProfile,
        multiServerPresentation,
        normalizedMultiServerProfiles,
        selectedConcurrentServerIds,
        setMultiServerActiveProfileId,
        setMultiServerProfiles,
    ]);

    const handleRenameConcurrentProfile = React.useCallback(async (profile: MultiServerGroupProfile) => {
        const next = await Modal.prompt(
            'Rename server group',
            'Set a new name for this server group profile',
            { defaultValue: profile.name, placeholder: 'Server group name' },
        );
        if (!next) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        const nextProfiles = normalizedMultiServerProfiles.map((item) => {
            if (item.id !== profile.id) return item;
            return {
                ...item,
                name: trimmed,
            };
        });
        setMultiServerProfiles(nextProfiles as any);
    }, [normalizedMultiServerProfiles, setMultiServerProfiles]);

    const handleRemoveConcurrentProfile = React.useCallback(async (profile: MultiServerGroupProfile) => {
        const confirmed = await Modal.confirm(
            'Remove server group',
            `Remove "${profile.name}"?`,
            { confirmText: t('common.remove'), destructive: true },
        );
        if (!confirmed) return;
        const nextProfiles = normalizedMultiServerProfiles.filter((item) => item.id !== profile.id);
        setMultiServerProfiles(nextProfiles as any);
        if (activeMultiServerProfileId === profile.id) {
            setMultiServerActiveProfileId(null);
        }
    }, [activeMultiServerProfileId, normalizedMultiServerProfiles, setMultiServerActiveProfileId, setMultiServerProfiles]);

    const handleRename = React.useCallback(async (profile: ServerProfile) => {
        if (isCloudServerProfileId(profile.id)) {
            Modal.alert(t('common.error'), t('server.cannotRenameCloud'));
            return;
        }
        const next = await Modal.prompt(
            t('server.renameServer'),
            t('server.renameServerPrompt'),
            { defaultValue: profile.name, placeholder: t('server.serverNamePlaceholder') }
        );
        if (!next) return;
        try {
            renameServerProfile(profile.id, next);
            setRevision((r) => r + 1);
        } catch (err) {
            Modal.alert(t('common.error'), String((err as any)?.message ?? err));
        }
    }, []);

    const handleRemove = React.useCallback(async (profile: ServerProfile) => {
        if (isCloudServerProfileId(profile.id)) {
            Modal.alert(t('common.error'), t('server.cannotRemoveCloud'));
            return;
        }

        const confirmed = await Modal.confirm(
            t('server.removeServer'),
            t('server.removeServerConfirm', { name: profile.name }),
            { confirmText: t('common.remove'), destructive: true }
        );
        if (!confirmed) return;

        let hadCreds = false;
        try {
            hadCreds = Boolean(await TokenStorage.getCredentialsForServerUrl(profile.serverUrl));
        } catch {
            hadCreds = false;
        }
        try {
            removeServerProfile(profile.id);
        } catch (err) {
            Modal.alert(t('common.error'), String((err as any)?.message ?? err));
            return;
        }

        if (hadCreds) {
            const alsoSignOut = await Modal.confirm(
                t('server.signOutThisServer'),
                t('server.signOutThisServerPrompt'),
                { confirmText: t('common.signOut'), cancelText: t('common.keep'), destructive: true }
            );
            if (alsoSignOut) {
                try {
                    await TokenStorage.removeCredentialsForServerUrl(profile.serverUrl);
                } catch {
                    // ignore
                }
            }
        }

        setRevision((r) => r + 1);
    }, []);

    const headerTitle = t('server.serverConfiguration');
    const headerBackTitle = t('common.back');

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle,
            headerBackTitle,
        } as const;
    }, [headerBackTitle, headerTitle]);

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />

            <KeyboardAvoidingView 
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup title={t('server.savedServersTitle')}>
                        {servers.map((profile) => {
                            const isActive = profile.id === activeServerId;
                            const authStatus = authStatusByServerId[profile.id] ?? 'unknown';
                            const statusLabel =
                                authStatus === 'signedIn'
                                    ? t('server.signedIn')
                                    : authStatus === 'signedOut'
                                        ? t('server.signedOut')
                                        : t('server.authStatusUnknown');
                            const subtitle = `${profile.serverUrl}\n${statusLabel}`;
                            const actions: ItemAction[] = Platform.OS === 'web'
                                ? [
                                    {
                                        id: 'switch-device',
                                        title: t('server.makeDefaultOnDevice'),
                                        icon: 'phone-portrait-outline',
                                        onPress: () => handleSwitch(profile, 'device'),
                                    },
                                    {
                                        id: 'rename',
                                        title: t('common.rename'),
                                        icon: 'pencil-outline',
                                        onPress: () => handleRename(profile),
                                    },
                                    {
                                        id: 'remove',
                                        title: t('common.remove'),
                                        icon: 'trash-outline',
                                        destructive: true,
                                        onPress: () => handleRemove(profile),
                                    },
                                ]
                                : [
                                    {
                                        id: 'switch',
                                        title: t('server.switchToServer'),
                                        icon: 'swap-horizontal-outline',
                                        onPress: () => handleSwitch(profile, 'device'),
                                    },
                                    {
                                        id: 'rename',
                                        title: t('common.rename'),
                                        icon: 'pencil-outline',
                                        onPress: () => handleRename(profile),
                                    },
                                    {
                                        id: 'remove',
                                        title: t('common.remove'),
                                        icon: 'trash-outline',
                                        destructive: true,
                                        onPress: () => handleRemove(profile),
                                    },
                                ];

                            return (
                                <Item
                                    key={profile.id}
                                    title={profile.name}
                                    subtitle={subtitle}
                                    subtitleLines={0}
                                    selected={isActive}
                                    showChevron={false}
                                    detail={isActive ? t('server.active') : undefined}
                                    onPress={() => handleSwitch(profile, 'device')}
                                    rightElement={(
                                        <ItemRowActions
                                            title={profile.name}
                                            actions={actions}
                                            compactActionIds={Platform.OS === 'web' ? ['switch-device'] : ['switch']}
                                            pinnedActionIds={Platform.OS === 'web' ? ['switch-device'] : ['switch']}
                                            overflowPosition="beforePinned"
                                        />
                                    )}
                                />
                            );
                        })}
                    </ItemGroup>

                    <ItemGroup title="Concurrent multi-server view" footer="Select whether to combine multiple servers in one session list.">
                        <Item
                            title="Enable concurrent view"
                            subtitle="Show sessions from selected servers together"
                            icon={<Ionicons name="layers-outline" size={29} color="#5856D6" />}
                            rightElement={<Switch value={Boolean(multiServerEnabled)} onValueChange={setMultiServerEnabled} />}
                            showChevron={false}
                            onPress={() => setMultiServerEnabled(!multiServerEnabled)}
                        />
                        <Item
                            title="Presentation mode"
                            subtitle={
                                (activeMultiServerProfile?.presentation ?? multiServerPresentation) === 'flat-with-badge'
                                    ? 'Flat list with server badges'
                                    : 'Grouped by server'
                            }
                            icon={<Ionicons name="list-outline" size={29} color="#007AFF" />}
                            rightElement={<Ionicons name="swap-horizontal-outline" size={20} color={theme.colors.textSecondary} />}
                            showChevron={false}
                            onPress={handleTogglePresentation}
                        />
                        <Item
                            title="Active server group"
                            subtitle={activeMultiServerProfile ? activeMultiServerProfile.name : 'Default selection'}
                            icon={<Ionicons name="albums-outline" size={29} color="#8E44AD" />}
                            rightElement={<Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />}
                            showChevron={false}
                            onPress={() => {
                                if (activeMultiServerProfileId) {
                                    handleActivateConcurrentProfile(null);
                                }
                            }}
                        />
                        <Item
                            title="Save current selection as group"
                            subtitle="Create a reusable multi-server profile"
                            icon={<Ionicons name="bookmark-outline" size={29} color="#16A34A" />}
                            rightElement={<Ionicons name="add-circle-outline" size={20} color={theme.colors.textSecondary} />}
                            showChevron={false}
                            onPress={handleCreateConcurrentProfile}
                        />
                        {normalizedMultiServerProfiles.map((profile) => {
                            const isActiveProfile = profile.id === activeMultiServerProfileId;
                            const actions: ItemAction[] = [
                                {
                                    id: 'activate',
                                    title: isActiveProfile ? 'Use default selection' : 'Use this group',
                                    icon: 'checkmark-circle-outline',
                                    onPress: () => handleActivateConcurrentProfile(isActiveProfile ? null : profile.id),
                                },
                                {
                                    id: 'rename',
                                    title: t('common.rename'),
                                    icon: 'pencil-outline',
                                    onPress: () => handleRenameConcurrentProfile(profile),
                                },
                                {
                                    id: 'remove',
                                    title: t('common.remove'),
                                    icon: 'trash-outline',
                                    destructive: true,
                                    onPress: () => handleRemoveConcurrentProfile(profile),
                                },
                            ];
                            return (
                                <Item
                                    key={`multi-server-profile-${profile.id}`}
                                    title={profile.name}
                                    subtitle={`${profile.serverIds.length} server${profile.serverIds.length === 1 ? '' : 's'} · ${profile.presentation === 'flat-with-badge' ? 'flat list' : 'grouped list'}`}
                                    icon={<Ionicons name="folder-open-outline" size={29} color={theme.colors.textSecondary} />}
                                    selected={isActiveProfile}
                                    detail={isActiveProfile ? 'Active' : undefined}
                                    showChevron={false}
                                    onPress={() => handleActivateConcurrentProfile(isActiveProfile ? null : profile.id)}
                                    rightElement={(
                                        <ItemRowActions
                                            title={profile.name}
                                            actions={actions}
                                            compactActionIds={['activate']}
                                            pinnedActionIds={['activate']}
                                            overflowPosition="beforePinned"
                                        />
                                    )}
                                />
                            );
                        })}
                        {multiServerEnabled
                            ? servers.map((profile) => {
                                const selected = selectedConcurrentServerIds.has(profile.id);
                                return (
                                    <Item
                                        key={`multi-server-${profile.id}`}
                                        title={profile.name}
                                        subtitle={profile.serverUrl}
                                        icon={<Ionicons name="server-outline" size={29} color={theme.colors.textSecondary} />}
                                        rightElement={(
                                            <Ionicons
                                                name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                                                size={20}
                                                color={selected ? theme.colors.status.connected : theme.colors.textSecondary}
                                            />
                                        )}
                                        showChevron={false}
                                        onPress={() => handleToggleConcurrentServer(profile.id)}
                                    />
                                );
                            })
                            : null}
                    </ItemGroup>

                    <ItemGroup title={t('server.addServerTitle')} footer={t('server.advancedFeatureFooter')}>
                        <View style={styles.contentContainer}>
                            {autoMode ? (
                                <Text style={[styles.statusText, { marginBottom: 12 }]}>
                                    {t('server.autoConfigHint')}
                                </Text>
                            ) : null}

                            <Text style={styles.labelText}>{t('server.customServerUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />

                            {autoMode ? null : (
                                <>
                                    <Text style={styles.labelText}>{t('server.serverNameLabel').toUpperCase()}</Text>
                                    <TextInput
                                        style={[
                                            styles.textInput,
                                            isValidating && styles.textInputValidating
                                        ]}
                                        value={inputName}
                                        onChangeText={(text) => setInputName(text)}
                                        placeholder={t('server.serverNamePlaceholder')}
                                        placeholderTextColor={theme.colors.input.placeholder}
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                        editable={!isValidating}
                                    />
                                </>
                            )}

                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    {t('server.validatingServer')}
                                </Text>
                            )}
                            <View style={styles.buttonRow}>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                    />
                                </View>
                                <View style={styles.buttonWrapper}>
                                    <RoundButton
                                        title={isValidating ? t('server.validating') : autoMode ? t('server.useThisServer') : t('server.addAndUse')}
                                        size="normal"
                                        action={handleAddServer}
                                        disabled={isValidating}
                                    />
                                </View>
                            </View>
                        </View>
                    </ItemGroup>

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
