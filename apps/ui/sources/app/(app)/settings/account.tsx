import React, { useState } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/recovery/secretKeyBackup';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { useSettingMutable, useProfile } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import { useConnectAccount } from '@/hooks/auth/useConnectAccount';
import { getDisplayName } from '@/sync/domains/profiles/profile';
import { Image } from 'expo-image';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { disconnectVendorToken } from '@/sync/api/account/apiVendorTokens';
import { getAgentCore, resolveAgentIdFromConnectedServiceId, getAgentIconSource, getAgentIconTintColor } from '@/agents/catalog/catalog';
import { HappyError } from '@/utils/errors/errors';
import { setAccountUsername } from '@/sync/api/account/apiUsername';
import { storage } from '@/sync/domains/state/storageStore';
import { useInboxFriendsEnabled } from '@/hooks/server/useInboxFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { ProviderIdentityItems } from '@/components/account/ProviderIdentityItems';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';

export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');
    const { connectAccount, isLoading: isConnecting } = useConnectAccount();
    const profile = useProfile();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsEnabled = useInboxFriendsEnabled();
    const applyProfile = storage((state) => state.applyProfile);

    // Get the current secret key
    const legacySecret =
        auth.credentials && isLegacyAuthCredentials(auth.credentials)
            ? auth.credentials.secret
            : '';
    const formattedSecret = legacySecret ? formatSecretKeyForBackup(legacySecret) : '';

    // Profile display values
    const displayName = getDisplayName(profile);
    const canSetUsername =
        friendsEnabled &&
        !friendsIdentityReadiness.isLoadingFeatures &&
        friendsIdentityReadiness.gate.gateVariant === 'username';

    const [savingUsername, saveUsername] = useHappyAction(async () => {
        if (!auth.credentials) return;
        if (!canSetUsername) return;

        const next = await Modal.prompt(
            t('profile.username'),
            undefined,
            {
                placeholder: t('profile.username'),
                defaultValue: profile.username ?? undefined,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (next == null) return;

        try {
            const res = await setAccountUsername(auth.credentials, next);
            applyProfile({ ...profile, username: res.username });
        } catch (e) {
            if (e instanceof HappyError) {
                const msg =
                    e.message === 'username-taken' ? t('friends.username.taken')
                        : e.message === 'invalid-username' ? t('friends.username.invalid')
                            : e.message === 'username-disabled' ? t('friends.username.disabled')
                                : e.message === 'friends-disabled' ? t('friends.disabled')
                                    : e.message;
                await Modal.alert(t('common.error'), msg);
                return;
            }
            throw e;
        }
    });

    // Service disconnection
    const [disconnectingService, setDisconnectingService] = useState<string | null>(null);
    const handleDisconnectService = async (service: string, displayName: string) => {
        if (!auth.credentials) return;
        const confirmed = await Modal.confirm(
            t('modals.disconnectService', { service: displayName }),
            t('modals.disconnectServiceConfirm', { service: displayName }),
            { confirmText: t('modals.disconnect'), destructive: true }
        );
        if (confirmed) {
            setDisconnectingService(service);
            try {
                await disconnectVendorToken(auth.credentials, service);
                await sync.refreshProfile();
                // The profile will be updated via sync
            } catch (error) {
                Modal.alert(t('common.error'), t('errors.disconnectServiceFailed', { service: displayName }));
            } finally {
                setDisconnectingService(null);
            }
        }
    };

    const handleShowSecret = () => {
        setShowSecret(!showSecret);
    };

    const handleCopySecret = async () => {
        if (!formattedSecret) return;
        try {
            await Clipboard.setStringAsync(formattedSecret);
            setCopiedRecently(true);
            setTimeout(() => setCopiedRecently(false), 2000);
            Modal.alert(t('common.success'), t('settingsAccount.secretKeyCopied'));
        } catch (error) {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
        }
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true }
        );
        if (confirmed) {
            auth.logout();
        }
    };

    return (
        <>
            <ItemList>
                {/* Account Info */}
                <ItemGroup title={t('settingsAccount.accountInformation')}>
                    <Item
                        title={t('settingsAccount.status')}
                        detail={auth.isAuthenticated ? t('settingsAccount.statusActive') : t('settingsAccount.statusNotAuthenticated')}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsAccount.anonymousId')}
                        detail={sync.anonID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.anonID}
                    />
                    <Item
                        title={t('settingsAccount.publicId')}
                        detail={sync.serverID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.serverID}
                    />
                    {Platform.OS !== 'web' && (
                        <Item
                            title={t('settingsAccount.linkNewDevice')}
                            subtitle={isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle')}
                            icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                            onPress={connectAccount}
                            disabled={isConnecting}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>

                {/* Profile Section */}
                <ItemGroup title={t('settingsAccount.profile')}>
                        {displayName && (
                            <Item
                                title={t('settingsAccount.name')}
                                detail={displayName}
                                showChevron={false}
                            />
                        )}
                        {canSetUsername && (
                            <Item
                                title={t('profile.username')}
                                detail={profile.username ? `@${profile.username}` : undefined}
                                subtitle={
                                    profile.username ? undefined : t('friends.username.required')
                                }
                                onPress={saveUsername}
                                disabled={savingUsername}
                                loading={savingUsername}
                                showChevron={false}
                                icon={<Ionicons name="at-outline" size={29} color={theme.colors.textSecondary} />}
                            />
                        )}
                        <ProviderIdentityItems
                            profile={profile}
                            credentials={auth.credentials}
                            applyProfile={applyProfile}
                            returnTo="/settings/account"
                        />
                </ItemGroup>

                {/* Connected Services Section */}
                {profile.connectedServices && profile.connectedServices.length > 0 && (() => {
                    const displayServices = profile.connectedServices
                        .map((serviceId) => {
                            const agentId = resolveAgentIdFromConnectedServiceId(serviceId);
                            if (!agentId) return null;
                            const core = getAgentCore(agentId);
                            if (!core.connectedService?.id) return null;
                            return {
                                serviceId,
                                name: core.connectedService.name,
                                icon: getAgentIconSource(agentId),
                                tintColor: getAgentIconTintColor(agentId, theme) ?? null,
                            };
                        })
                        .filter((x): x is NonNullable<typeof x> => Boolean(x));

                    if (displayServices.length === 0) return null;
                    
                    return (
                        <ItemGroup title={t('settings.connectedAccounts')}>
                            {displayServices.map(service => {
                                const isDisconnecting = disconnectingService === service.serviceId;
                                return (
                                    <Item
                                        key={service.serviceId}
                                        title={service.name}
                                        detail={t('settingsAccount.statusActive')}
                                        subtitle={t('settingsAccount.tapToDisconnect')}
                                        onPress={() => handleDisconnectService(service.serviceId, service.name)}
                                        loading={isDisconnecting}
                                        disabled={isDisconnecting}
                                        showChevron={false}
                                        icon={
                                            <Image
                                                source={service.icon}
                                                style={{ width: 29, height: 29 }}
                                                tintColor={service.tintColor}
                                                contentFit="contain"
                                            />
                                        }
                                    />
                                );
                            })}
                        </ItemGroup>
                    );
                })()}

                {/* Backup Section */}
                {formattedSecret ? (
                    <ItemGroup title={t('settingsAccount.backup')} footer={t('settingsAccount.backupDescription')}>
                        <Item
                            title={t('settingsAccount.secretKey')}
                            subtitle={showSecret ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                            icon={
                                <Ionicons
                                    name={showSecret ? 'eye-off-outline' : 'eye-outline'}
                                    size={29}
                                    color="#FF9500"
                                />
                            }
                            onPress={handleShowSecret}
                            rightElement={
                                <Pressable onPress={handleCopySecret} hitSlop={12}>
                                    <Ionicons
                                        name="copy-outline"
                                        size={18}
                                        color={theme.colors.textSecondary}
                                    />
                                </Pressable>
                            }
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : null}

                {/* Secret Key Display */}
                {formattedSecret && showSecret && (
                    <ItemGroup>
                        <Pressable onPress={handleCopySecret}>
                            <View style={{
                                backgroundColor: theme.colors.surface,
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.textSecondary,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('settingsAccount.secretKeyLabel')}
                                    </Text>
                                    <Ionicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? "#34C759" : theme.colors.textSecondary}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: theme.colors.text,
                                    ...Typography.mono()
                                }}>
                                    {formattedSecret}
                                </Text>
                            </View>
                        </Pressable>
                    </ItemGroup>
                )}

                {/* Analytics Section */}
                <ItemGroup
                    title={t('settingsAccount.privacy')}
                    footer={t('settingsAccount.privacyDescription')}
                >
                    <Item
                        title={t('settingsAccount.analytics')}
                        subtitle={analyticsOptOut ? t('settingsAccount.analyticsDisabled') : t('settingsAccount.analyticsEnabled')}
                        rightElement={
                            <Switch
                                value={!analyticsOptOut}
                                onValueChange={(value) => {
                                    const optOut = !value;
                                    setAnalyticsOptOut(optOut);
                                }}
                                trackColor={{ false: '#767577', true: '#34C759' }}
                                thumbColor="#FFFFFF"
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Danger Zone */}
                <ItemGroup title={t('settingsAccount.dangerZone')}>
                    <Item
                        title={t('settingsAccount.logout')}
                        subtitle={t('settingsAccount.logoutSubtitle')}
                        icon={<Ionicons name="log-out-outline" size={29} color="#FF3B30" />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});
