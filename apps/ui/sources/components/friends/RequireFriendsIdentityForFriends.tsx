import React from 'react';
import { View, Text, Pressable, ActivityIndicator, TextInput, Linking } from 'react-native';
import { useOAuthProviderConfigured } from '@/hooks/useOAuthProviderConfigured';
import { type FriendsUsernameHint } from './resolveFriendsIdentityGate';
import { t } from '@/text';
import { FriendsGateCentered, FriendsProviderConnectControls, FriendsProviderGate } from './FriendsGate';
import { useAuth } from '@/auth/AuthContext';
import { getAuthProvider } from '@/auth/providers/registry';
import { TokenStorage } from '@/auth/tokenStorage';
import { setAccountUsername } from '@/sync/apiUsername';
import { storage } from '@/sync/storageStore';
import { HappyError } from '@/utils/errors';
import { Modal } from '@/modal';
import { useUnistyles } from 'react-native-unistyles';
import { useFriendsIdentityReadiness } from '@/hooks/useFriendsIdentityReadiness';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';

function translateUsernameHint(hint: FriendsUsernameHint): string {
    switch (hint.key) {
        case 'friends.username.preferredNotAvailable':
            return t(hint.key);
        case 'friends.username.preferredNotAvailableWithLogin':
            return t(hint.key, hint.params);
    }
}

export function RequireFriendsIdentityForFriendsBase(props: {
    variant: 'provider' | 'username';
    isReady: boolean;
    providerDisplayName?: string;
    connectButtonColor?: string;
    initialUsername?: string;
    usernameHint?: string;
    onConnectProvider?: () => void;
    connectingProvider?: boolean;
    connectProviderDisabled?: boolean;
    unavailableReason?: string;
    onSaveUsername?: (username: string) => void;
    savingUsername?: boolean;
    children: React.ReactNode;
}) {
    const { theme } = useUnistyles();
    const [username, setUsername] = React.useState(props.initialUsername ?? '');

    React.useEffect(() => {
        if (!props.initialUsername) return;
        setUsername((current) => (current ? current : props.initialUsername!));
    }, [props.initialUsername]);

    if (props.isReady) {
        return <>{props.children}</>;
    }

    if (props.variant === 'provider') {
        const provider = props.providerDisplayName ?? 'OAuth';
        return (
            <FriendsProviderGate
                isConnected={props.isReady}
                onConnect={props.onConnectProvider ?? (() => {})}
                connecting={props.connectingProvider}
                connectDisabled={props.connectProviderDisabled}
                unavailableReason={props.unavailableReason}
                title={t('friends.providerGate.title', { provider })}
                body={t('friends.providerGate.body', { provider })}
                connectLabel={t('friends.providerGate.connect', { provider })}
                notAvailableLabel={t('friends.providerGate.notAvailable')}
                connectButtonColor={props.connectButtonColor}
                connectButtonMarginBottom={0}
                notAvailableMarginTop={8}
            >
                {props.children}
            </FriendsProviderGate>
        );
    }

    const provider = props.providerDisplayName ?? 'OAuth';
    const inputColors =
        (theme.colors as any).input ??
        ({
            background: theme.colors.surface,
            text: theme.colors.text,
            placeholder: theme.colors.text,
        } as const);
    return (
        <FriendsGateCentered title={t('friends.username.required')}>
            {props.usernameHint ? (
                <Text style={{ textAlign: 'center', opacity: 0.7, marginBottom: 12 }}>
                    {props.usernameHint}
                </Text>
            ) : null}

            <TextInput
                accessibilityLabel={t('profile.username')}
                value={username}
                onChangeText={setUsername}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                    width: '100%',
                    maxWidth: 360,
                    borderWidth: 1,
                    borderColor: theme.colors.divider,
                    borderRadius: 10,
                    backgroundColor: inputColors.background,
                    color: inputColors.text,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    marginBottom: 12,
                }}
                placeholder={t('profile.username')}
                placeholderTextColor={inputColors.placeholder}
            />

            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('common.save')}
                onPress={() => props.onSaveUsername?.(username)}
                disabled={props.savingUsername === true}
                style={{
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderRadius: 10,
                    backgroundColor: theme.colors.button.primary.background,
                    minWidth: 180,
                    alignItems: 'center',
                    marginBottom: 12,
                    opacity: props.savingUsername === true ? 0.6 : 1,
                }}
            >
                {props.savingUsername ? (
                    <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                ) : (
                    <Text style={{ color: theme.colors.button.primary.tint, fontWeight: '600' }}>
                        {t('common.save')}
                    </Text>
                )}
            </Pressable>

            <FriendsProviderConnectControls
                onConnect={props.onConnectProvider}
                connecting={props.connectingProvider}
                connectDisabled={props.connectProviderDisabled}
                unavailableReason={props.unavailableReason}
                connectLabel={t('friends.providerGate.connect', { provider })}
                notAvailableLabel={t('friends.providerGate.notAvailable')}
                connectButtonColor={props.connectButtonColor}
                connectButtonMarginBottom={0}
                notAvailableMarginTop={8}
            />
        </FriendsGateCentered>
    );
}

export function RequireFriendsIdentityForFriends(props: { children: React.ReactNode }) {
    const auth = useAuth();
    const applyProfile = storage((state) => state.applyProfile);
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const requiredProviderId = friendsIdentityReadiness.requiredProviderId;
    const oauthSupported = useOAuthProviderConfigured(requiredProviderId ?? "__none__");
    const gate = friendsIdentityReadiness.gate;

    const [connectingProvider, setConnectingProvider] = React.useState(false);
    const [savingUsername, setSavingUsername] = React.useState(false);
    const isMountedRef = React.useRef(true);

    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const onConnectProvider = React.useCallback(async () => {
        if (!requiredProviderId) return;
        if (oauthSupported === false) return;
        if (!auth.credentials) return;
        const provider = getAuthProvider(requiredProviderId);
        if (!provider) return;
        if (isMountedRef.current) setConnectingProvider(true);
        try {
            await TokenStorage.setPendingExternalConnect({ provider: provider.id, returnTo: '/friends' });
            const url = await provider.getConnectUrl(auth.credentials);
            if (!isSafeExternalAuthUrl(url)) {
                await TokenStorage.clearPendingExternalConnect();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }
            const supported = await Linking.canOpenURL(url);
            if (!supported) {
                await TokenStorage.clearPendingExternalConnect();
                await Modal.alert(t('common.error'), t('errors.operationFailed'));
                return;
            }
            await Linking.openURL(url);
        } catch (e) {
            await TokenStorage.clearPendingExternalConnect();
            if (e instanceof HappyError) {
                await Modal.alert(t('common.error'), e.message);
            } else {
                await Modal.alert(t('common.error'), e instanceof Error ? e.message : String(e));
            }
        } finally {
            if (isMountedRef.current) setConnectingProvider(false);
        }
    }, [auth.credentials, oauthSupported, requiredProviderId]);

    const onSaveUsername = React.useCallback(async (username: string) => {
        if (!auth.credentials) return;
        const trimmed = username.trim();
        if (!trimmed) return;
        if (isMountedRef.current) setSavingUsername(true);
        try {
            const res = await setAccountUsername(auth.credentials, trimmed);
            const currentProfile = storage.getState().profile;
            applyProfile({ ...currentProfile, username: res.username });
        } catch (e) {
            if (e instanceof HappyError) {
                const msg =
                    e.message === 'username-taken' ? t('friends.username.taken')
                        : e.message === 'invalid-username' ? t('friends.username.invalid')
                            : e.message === 'username-disabled' ? t('friends.username.disabled')
                                : e.message === 'friends-disabled' ? t('friends.disabled')
                                    : e.message;
                await Modal.alert(t('common.error'), msg);
            } else {
                await Modal.alert(t('common.error'), e instanceof Error ? e.message : String(e));
            }
        } finally {
            if (isMountedRef.current) setSavingUsername(false);
        }
    }, [applyProfile, auth.credentials]);

    return (
        <RequireFriendsIdentityForFriendsBase
            variant={gate.gateVariant}
            isReady={gate.isReady}
            providerDisplayName={
                requiredProviderId ? (getAuthProvider(requiredProviderId)?.displayName ?? requiredProviderId) : undefined
            }
            connectButtonColor={requiredProviderId ? getAuthProvider(requiredProviderId)?.connectButtonColor : undefined}
            initialUsername={gate.initialUsername}
            usernameHint={gate.usernameHint ? translateUsernameHint(gate.usernameHint) : undefined}
            onConnectProvider={() => void onConnectProvider()}
            connectingProvider={connectingProvider}
            connectProviderDisabled={oauthSupported === false || !auth.credentials || !requiredProviderId}
            unavailableReason={
                oauthSupported === false && requiredProviderId
                    ? t('friends.providerGate.notConfigured', {
                          provider: getAuthProvider(requiredProviderId)?.displayName ?? requiredProviderId,
                      })
                    : undefined
            }
            onSaveUsername={(u) => void onSaveUsername(u)}
            savingUsername={savingUsername}
        >
            {props.children}
        </RequireFriendsIdentityForFriendsBase>
    );
}
