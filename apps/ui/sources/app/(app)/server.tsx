import React, { useState } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform, Text as RNText, Pressable } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Item } from '@/components/ui/lists/Item';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { type ItemAction } from '@/components/ui/lists/itemActions';
import { RoundButton } from '@/components/RoundButton';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { validateServerUrl } from '@/sync/serverConfig';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Updates from 'expo-updates';
import { parseServerConfigRouteParams } from './serverParams';
import { type ServerProfile, getActiveServerId, listServerProfiles, removeServerProfile, renameServerProfile, setActiveServerId, upsertServerProfile } from '@/sync/serverProfiles';
import { TokenStorage } from '@/auth/tokenStorage';
import { Ionicons } from '@expo/vector-icons';

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
    webScopeRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 12,
        justifyContent: 'center',
        flexWrap: 'wrap',
    },
    webScopePill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 9999,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    webScopePillActive: {
        borderColor: theme.colors.textSecondary,
    },
    webScopePillText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.text,
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

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const searchParams = useLocalSearchParams();
    const [revision, setRevision] = React.useState(0);
    const [inputUrl, setInputUrl] = useState('');
    const [inputName, setInputName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const [webSwitchScope, setWebSwitchScope] = React.useState<'tab' | 'device'>(() => (Platform.OS === 'web' ? 'tab' : 'device'));
    const [authStatusByServerId, setAuthStatusByServerId] = React.useState<Record<string, 'signedIn' | 'signedOut' | 'unknown'>>({});
    const route = React.useMemo(() => {
        return parseServerConfigRouteParams({ url: searchParams.url, auto: searchParams.auto });
    }, [searchParams.auto, searchParams.url]);

    const autoMode = route.auto;

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

    const activeServerId = React.useMemo(() => {
        try {
            return getActiveServerId();
        } catch {
            return 'official';
        }
    }, [revision]);

    const reloadNow = React.useCallback(async () => {
        if (Platform.OS === 'web') {
            try {
                window.location.reload();
            } catch {
                // ignore
            }
            return;
        }
        try {
            await Updates.reloadAsync();
        } catch {
            // ignore (dev mode)
        }
    }, []);

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
        const profile = upsertServerProfile({ serverUrl: normalized, name });

        const scope: 'tab' | 'device' = Platform.OS === 'web' ? webSwitchScope : 'device';
        setActiveServerId(profile.id, { scope });
        if (Platform.OS === 'web' && (autoMode || scope === 'device')) {
            try {
                setActiveServerId(profile.id, { scope: 'tab' });
            } catch {
                // ignore
            }
        }

        setRevision((r) => r + 1);
        await reloadNow();
    };

    const handleReset = async () => {
        const confirmed = await Modal.confirm(
            t('server.resetToDefault'),
            t('server.resetServerDefault'),
            { confirmText: t('common.reset'), destructive: true }
        );

        if (confirmed) {
            setActiveServerId('official', { scope: 'device' });
            if (Platform.OS === 'web') {
                try {
                    setActiveServerId('official', { scope: 'tab' });
                } catch {
                    // ignore
                }
            }
            setInputUrl('');
            setInputName('');
            setRevision((r) => r + 1);
            await reloadNow();
        }
    };

    const handleSwitch = React.useCallback(async (profile: ServerProfile) => {
        const scope: 'tab' | 'device' = Platform.OS === 'web' ? webSwitchScope : 'device';
        setActiveServerId(profile.id, { scope });
        if (Platform.OS === 'web' && scope === 'device') {
            try {
                setActiveServerId(profile.id, { scope: 'tab' });
            } catch {
                // ignore
            }
        }
        setRevision((r) => r + 1);
        await reloadNow();
    }, [reloadNow, webSwitchScope]);

    const handleRename = React.useCallback(async (profile: ServerProfile) => {
        if (profile.id === 'official') {
            Modal.alert(t('common.error'), t('server.cannotRenameOfficial'));
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
        if (profile.id === 'official') {
            Modal.alert(t('common.error'), t('server.cannotRemoveOfficial'));
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
        await reloadNow();
    }, [reloadNow]);

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
                            const actions: ItemAction[] = [
                                {
                                    id: 'switch',
                                    title: t('server.switchToServer'),
                                    icon: 'swap-horizontal-outline',
                                    onPress: () => handleSwitch(profile),
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
                                    onPress={() => handleSwitch(profile)}
                                    rightElement={(
                                        <ItemRowActions
                                            title={profile.name}
                                            actions={actions}
                                            compactActionIds={['switch']}
                                            pinnedActionIds={['switch']}
                                            overflowPosition="beforePinned"
                                        />
                                    )}
                                />
                            );
                        })}
                    </ItemGroup>

                    <ItemGroup title={t('server.addServerTitle')} footer={t('server.advancedFeatureFooter')}>
                        <View style={styles.contentContainer}>
                            {autoMode ? (
                                <Text style={[styles.statusText, { marginBottom: 12 }]}>
                                    {t('server.autoConfigHint')}
                                </Text>
                            ) : null}

                            {Platform.OS === 'web' ? (
                                <View style={styles.webScopeRow}>
                                    <Pressable
                                        style={[styles.webScopePill, webSwitchScope === 'tab' ? styles.webScopePillActive : null]}
                                        onPress={() => setWebSwitchScope('tab')}
                                    >
                                        <Ionicons name="browsers-outline" size={14} color={theme.colors.text} />
                                        <RNText style={styles.webScopePillText}>{t('server.switchForThisTab')}</RNText>
                                    </Pressable>
                                    <Pressable
                                        style={[styles.webScopePill, webSwitchScope === 'device' ? styles.webScopePillActive : null]}
                                        onPress={() => setWebSwitchScope('device')}
                                    >
                                        <Ionicons name="phone-portrait-outline" size={14} color={theme.colors.text} />
                                        <RNText style={styles.webScopePillText}>{t('server.makeDefaultOnDevice')}</RNText>
                                    </Pressable>
                                </View>
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
