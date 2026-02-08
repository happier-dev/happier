import React from 'react';
import { Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Switch } from '@/components/Switch';
import type { Profile } from '@/sync/profile';
import { getLinkedProvider } from '@/sync/profile';
import { useHappyAction } from '@/hooks/useHappyAction';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { HappyError } from '@/utils/errors';
import { setAccountIdentityShowOnProfile } from '@/sync/apiIdentity';
import { storage } from '@/sync/storageStore';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';
import { authProviderRegistry, normalizeProviderId } from '@/auth/providers/registry';
import { useOAuthProviderConfigured } from '@/hooks/useOAuthProviderConfigured';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';

type ProviderIdentityItemsProps = Readonly<{
    profile: Profile;
    credentials: AuthCredentials | null;
    applyProfile: (profile: Profile) => void;
    returnTo: string;
}>;

function mapIdentityErrorToMessage(error: unknown): string {
    if (!(error instanceof HappyError)) return t('errors.operationFailed');
    switch (error.message) {
        case 'username-disabled':
            return t('friends.username.disabled');
        case 'friends-disabled':
            return t('friends.disabled');
        default:
            return error.message;
    }
}

async function openProviderConnectUrl(params: {
    url: string;
}): Promise<boolean> {
    if (!isSafeExternalAuthUrl(params.url)) {
        await TokenStorage.clearPendingExternalConnect();
        await Modal.alert(t('common.error'), t('errors.operationFailed'));
        return false;
    }

    const supported = await Linking.canOpenURL(params.url);
    if (!supported) {
        await TokenStorage.clearPendingExternalConnect();
        await Modal.alert(t('common.error'), t('errors.operationFailed'));
        return false;
    }

    try {
        await Linking.openURL(params.url);
        return true;
    } catch {
        await TokenStorage.clearPendingExternalConnect();
        await Modal.alert(t('common.error'), t('errors.operationFailed'));
        return false;
    }
}

function ProviderIdentityItem(props: Readonly<{
    provider: (typeof authProviderRegistry)[number];
    profile: Profile;
    credentials: AuthCredentials | null;
    applyProfile: (profile: Profile) => void;
    returnTo: string;
}>) {
    const { theme } = useUnistyles();
    const providerId = normalizeProviderId(props.provider.id);
    const providerDisplayName = props.provider.displayName ?? props.provider.id;
    const identity = providerId ? getLinkedProvider(props.profile, providerId) : null;
    const oauthSupported = useOAuthProviderConfigured(providerId ?? '__none__');
    const [savingShowOnProfile, setSavingShowOnProfile] = React.useState(false);

    const [disconnecting, disconnect] = useHappyAction(async () => {
        if (!props.credentials) return;
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: providerDisplayName }),
            t('modals.disconnectServiceConfirm', { service: providerDisplayName }),
            { confirmText: t('modals.disconnect'), destructive: true },
        );
        if (!confirmed) return;
        await props.provider.disconnect(props.credentials);
        await sync.refreshProfile();
    });

    const [connecting, connect] = useHappyAction(async () => {
        if (oauthSupported !== true) return;
        if (!props.credentials || !providerId) return;

        try {
            await TokenStorage.setPendingExternalConnect({ provider: providerId, returnTo: props.returnTo });
            const url = await props.provider.getConnectUrl(props.credentials);
            await openProviderConnectUrl({ url });
        } catch (error) {
            await TokenStorage.clearPendingExternalConnect();
            await Modal.alert(t('common.error'), mapIdentityErrorToMessage(error));
        }
    });

    const onToggleShowOnProfile = async (value: boolean) => {
        if (!props.credentials || !identity || savingShowOnProfile) return;

        setSavingShowOnProfile(true);
        try {
            await setAccountIdentityShowOnProfile({
                credentials: props.credentials,
                providerId: identity.id,
                showOnProfile: value,
            });

            const currentProfile = storage.getState().profile;
            props.applyProfile({
                ...currentProfile,
                linkedProviders: (currentProfile.linkedProviders ?? []).map((linkedProvider) =>
                    normalizeProviderId(linkedProvider.id) === normalizeProviderId(identity.id)
                        ? { ...linkedProvider, showOnProfile: value }
                        : linkedProvider,
                ),
            });
        } catch (error) {
            await Modal.alert(t('common.error'), mapIdentityErrorToMessage(error));
        } finally {
            setSavingShowOnProfile(false);
        }
    };

    const iconName = props.provider.badgeIconName ?? 'key-outline';
    const iconColor = theme.colors.textSecondary;
    const icon =
        identity?.avatarUrl ? (
            <Image
                source={{ uri: identity.avatarUrl }}
                style={{ width: 29, height: 29, borderRadius: 14.5 }}
                contentFit="cover"
                transition={200}
                cachePolicy="memory-disk"
            />
        ) : (
            <Ionicons name={iconName as any} size={29} color={iconColor} />
        );

    if (!identity) {
        return (
            <Item
                title={providerDisplayName}
                subtitle={
                    oauthSupported === false
                        ? t('friends.providerGate.notConfigured', { provider: providerDisplayName })
                        : t('friends.providerGate.title', { provider: providerDisplayName })
                }
                onPress={oauthSupported === true ? connect : undefined}
                disabled={oauthSupported !== true || connecting}
                loading={connecting || oauthSupported == null}
                showChevron={false}
                icon={icon}
            />
        );
    }

    return (
        <>
            <Item
                title={providerDisplayName}
                detail={identity.login ? `@${identity.login}` : identity.displayName ?? undefined}
                subtitle={t('settingsAccount.tapToDisconnect')}
                onPress={disconnect}
                loading={disconnecting}
                showChevron={false}
                icon={icon}
            />
            {props.provider.supportsProfileBadge ? (
                <Item
                    title={t('settingsAccount.showProviderOnProfile', { provider: providerDisplayName })}
                    rightElement={(
                        <Switch
                            value={identity.showOnProfile}
                            onValueChange={(value) => {
                                void onToggleShowOnProfile(value);
                            }}
                            disabled={savingShowOnProfile}
                        />
                    )}
                    showChevron={false}
                />
            ) : null}
        </>
    );
}

export const ProviderIdentityItems = React.memo((props: ProviderIdentityItemsProps) => {
    return (
        <>
            {authProviderRegistry.map((provider) => (
                <ProviderIdentityItem
                    key={provider.id}
                    provider={provider}
                    profile={props.profile}
                    credentials={props.credentials}
                    applyProfile={props.applyProfile}
                    returnTo={props.returnTo}
                />
            ))}
        </>
    );
});
