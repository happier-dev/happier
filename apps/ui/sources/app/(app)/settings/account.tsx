import React, { useState } from 'react';
import { View, Pressable, Platform, useWindowDimensions } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
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
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { HappyError } from '@/utils/errors/errors';
import { setAccountUsername } from '@/sync/api/account/apiUsername';
import { storage } from '@/sync/domains/state/storageStore';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { ProviderIdentityItems } from '@/components/account/ProviderIdentityItems';
import { isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { migrateAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMigrate';
import { Text } from '@/components/ui/text/Text';
import { useRouter } from 'expo-router';
import { isRunningOnMac } from '@/utils/platform/platform';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { buildAccountEncryptionMigrateToPlainRequest } from '@/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest';
import { getConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { authChallenge } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { buildAccountEncryptionMigrateToE2eeRequest } from '@/sync/ops/account/buildAccountEncryptionMigrateToE2eeRequest';
import { getConnectedServiceCredentialPlain } from '@/sync/api/account/apiConnectedServicesV3';
import {
    getQualifiedConnectedAccountConfigurationV4,
    getQualifiedConnectedAccountCredentialV4,
} from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import {
    AccountEncryptionMigrateInvalidParamsReasonSchema,
} from '@happier-dev/protocol';


export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const { width, height } = useWindowDimensions();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');
    const [crashReportsOptOut, setCrashReportsOptOut] = useSettingMutable('crashReportsOptOut');
    const { connectAccount, isLoading: isConnecting } = useConnectAccount();
    const profile = useProfile();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsEnabled = useFriendsEnabled();
    const applyProfile = storage((state) => state.applyProfile);
    const encryptionAccountOptOutEnabled = useFeatureEnabled('encryption.accountOptOut');

    const [accountEncryptionMode, setAccountEncryptionMode] = useState<'e2ee' | 'plain' | null>(null);
    const [accountEncryptionModeLoading, setAccountEncryptionModeLoading] = useState(false);
    const [accountEncryptionModeSaving, setAccountEncryptionModeSaving] = useState(false);

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

    React.useEffect(() => {
        if (!encryptionAccountOptOutEnabled) return;
        const credentials = auth.credentials;
        if (!credentials?.token) return;

        let cancelled = false;
        setAccountEncryptionModeLoading(true);
        fetchAccountEncryptionMode(credentials)
            .then((res) => {
                if (cancelled) return;
                setAccountEncryptionMode(res.mode);
            })
            .finally(() => {
                if (cancelled) return;
                setAccountEncryptionModeLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [auth.credentials?.token, encryptionAccountOptOutEnabled]);

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

    const handleShowSecret = () => {
        setShowSecret(!showSecret);
    };

    const handleCopySecret = async () => {
        if (!formattedSecret) return;
        const copied = await setClipboardStringSafe(formattedSecret);
        if (!copied) {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
            return;
        }
        setCopiedRecently(true);
        setTimeout(() => setCopiedRecently(false), 2000);
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true }
        );
        if (confirmed) {
            router.replace('/');
            await auth.logout();
        }
    };

    const isPhoneSizedWeb = Platform.OS === 'web' && isWebMobileLikeQrScannerHost({ width, height });
    const showAddYourPhone = isRunningOnMac() || (Platform.OS === 'web' && !isPhoneSizedWeb);
    const showLinkNewDevice = canUseCurrentDeviceQrScanner();
    const showAccountAccessGroup = showAddYourPhone || showLinkNewDevice;
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
                </ItemGroup>

                {/* Account access / linking */}
                {showAccountAccessGroup ? (
                    <ItemGroup>
                        {showAddYourPhone ? (
                            <Item
                                testID="settings-account-add-your-phone"
                                title={t('settings.addYourPhone')}
                                subtitle={t('settings.addYourPhoneSubtitle')}
                                icon={<SafeIonicons name="phone-portrait-outline" size={29} color={theme.colors.accent.blue} />}
                                onPress={() => router.push('/settings/add-phone')}
                                showChevron={false}
                            />
                        ) : null}
                        {showLinkNewDevice ? (
                            <Item
                                testID="settings-account-link-new-device"
                                title={t('settingsAccount.linkNewDevice')}
                                subtitle={isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle')}
                                icon={<SafeIonicons name="qr-code-outline" size={29} color={theme.colors.accent.blue} />}
                                onPress={connectAccount}
                                disabled={isConnecting}
                                showChevron={false}
                            />
                        ) : null}
                    </ItemGroup>
                ) : null}

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
                                icon={<SafeIonicons name="at-outline" size={29} color={theme.colors.text.secondary} />}
                            />
                        )}
                        <ProviderIdentityItems
                            profile={profile}
                            credentials={auth.credentials}
                            applyProfile={applyProfile}
                            returnTo="/settings/account"
                        />
                </ItemGroup>

                {/* Backup Section */}
                {formattedSecret ? (
                    <ItemGroup title={t('settingsAccount.backup')} footer={t('settingsAccount.backupDescription')}>
                        <Item
                            testID="settings-account-secret-key-item"
                            title={t('settingsAccount.secretKey')}
                            subtitle={showSecret ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                            icon={
                                <SafeIonicons
                                    name={showSecret ? 'eye-off-outline' : 'eye-outline'}
                                    size={29}
                                    color={theme.colors.accent.orange}
                                />
                            }
                            onPress={handleShowSecret}
                            rightElement={
                                copiedRecently ? (
                                    <CopiedPill visible testID="settings-account-secret-key-copy-feedback" />
                                ) : (
                                    <Pressable testID="settings-account-secret-key-copy" onPress={handleCopySecret} hitSlop={12}>
                                        <SafeIonicons
                                            name="copy-outline"
                                            size={18}
                                            color={theme.colors.text.secondary}
                                        />
                                    </Pressable>
                                )
                            }
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : null}

                {/* Secret Key Display */}
                {formattedSecret && showSecret && (
                    <ItemGroup>
                        <Pressable testID="settings-account-secret-key-revealed" onPress={handleCopySecret}>
                            <View style={{
                                backgroundColor: theme.colors.surface.base,
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.text.secondary,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('settingsAccount.secretKeyLabel')}
                                    </Text>
                                    <SafeIonicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? theme.colors.state.success.foreground : theme.colors.text.secondary}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: theme.colors.text.primary,
                                    ...Typography.mono()
                                }}>
                                    <Text testID="settings-account-secret-key-value">{formattedSecret}</Text>
                                </Text>
                            </View>
                        </Pressable>
                    </ItemGroup>
                )}

                {/* Analytics Section */}
                {encryptionAccountOptOutEnabled && (
                    <ItemGroup title={t('terminal.encryption')}>
                        <Item
                            title={t('terminal.endToEndEncrypted')}
                            rightElement={
                                <Switch
                                    testID="settings-account-encryption-mode-switch"
                                    value={(accountEncryptionMode ?? 'e2ee') === 'e2ee'}
                                    disabled={
                                        accountEncryptionModeLoading ||
                                        accountEncryptionModeSaving ||
                                        !auth.credentials ||
                                        accountEncryptionMode == null
                                    }
                                    onValueChange={async (enabled) => {
                                        if (!auth.credentials) return;
                                        if (accountEncryptionMode == null) return;
                                        const credentials = auth.credentials;
                                        const nextMode = enabled ? 'e2ee' : 'plain';

                                        setAccountEncryptionModeSaving(true);
                                        try {
                                            const expectedSettingsVersion = storage.getState().settingsVersion ?? 0;
                                            const connectedServiceProfiles = profile.connectedServicesV2.flatMap((svc) =>
                                                svc.profiles.map((p) => ({
                                                    serviceId: svc.serviceId as any,
                                                    profileId: p.profileId,
                                                })),
                                            );
                                            const automations = Object.values(storage.getState().automations ?? {}).map((a: any) => ({
                                                id: a.id,
                                                templateCiphertext: a.templateCiphertext,
                                            }));
                                            let generatedSecret: string | null = null;
                                            const legacyCredentialsForE2ee = nextMode === 'e2ee'
                                                ? (() => {
                                                    if (isLegacyAuthCredentials(credentials)) return credentials;
                                                    generatedSecret = encodeBase64(getRandomBytes(32), 'base64url');
                                                    return { token: credentials.token, secret: generatedSecret };
                                                })()
                                                : null;
                                            const keyProof = nextMode === 'e2ee'
                                                ? (() => {
                                                    try {
                                                        const seed = decodeBase64(legacyCredentialsForE2ee!.secret, 'base64url');
                                                        if (seed.length !== 32) return null;
                                                        const challenge = authChallenge(seed);
                                                        return {
                                                            seed,
                                                            publicKey: encodeBase64(challenge.publicKey),
                                                            challenge: encodeBase64(challenge.challenge),
                                                            signature: encodeBase64(challenge.signature),
                                                        };
                                                    } catch {
                                                        return null;
                                                    }
                                                })()
                                                : null;

                                            if (nextMode === 'e2ee' && !keyProof) {
                                                await Modal.alertAsync(t('common.error'), t('settingsAccount.secretKeyMissing'));
                                                return;
                                            }

                                            const contentBinding = nextMode === 'e2ee'
                                                ? await buildContentKeyBinding(keyProof!.seed)
                                                : null;
                                            const migrationKeyProof = nextMode === 'e2ee'
                                                ? {
                                                    publicKey: keyProof!.publicKey,
                                                    challenge: keyProof!.challenge,
                                                    signature: keyProof!.signature,
                                                    ...contentBinding!,
                                                }
                                                : null;
                                            const request = nextMode === 'plain'
                                                ? await buildAccountEncryptionMigrateToPlainRequest({
                                                    credentials,
                                                    expectedSettingsVersion,
                                                    settings: storage.getState().settings,
                                                    connectedServiceProfiles,
                                                    qualifiedConnectedAccounts:
                                                        profile.connectedAccountsV4,
                                                    automations,
                                                    fetchConnectedServiceCredentialSealed: async ({ serviceId, profileId }) =>
                                                        await getConnectedServiceCredentialSealed(credentials, { serviceId, profileId }),
                                                    fetchQualifiedConnectedAccountCredential: async (ref) =>
                                                        await getQualifiedConnectedAccountCredentialV4(credentials, ref),
                                                    fetchQualifiedConnectedAccountConfiguration: async (ref) =>
                                                        await getQualifiedConnectedAccountConfigurationV4(credentials, ref),
                                                    decryptAutomationTemplateRaw: async (payloadCiphertext: string) =>
                                                        await sync.encryption.decryptAutomationTemplateRaw(payloadCiphertext),
                                                })
                                                : await buildAccountEncryptionMigrateToE2eeRequest({
                                                    credentials: legacyCredentialsForE2ee!,
                                                    expectedSettingsVersion,
                                                    settings: storage.getState().settings,
                                                    connectedServiceProfiles,
                                                    qualifiedConnectedAccounts:
                                                        profile.connectedAccountsV4,
                                                    automations,
                                                    keyProof:
                                                        migrationKeyProof!,
                                                    fetchConnectedServiceCredentialPlain: async ({ serviceId, profileId }) =>
                                                        await getConnectedServiceCredentialPlain(credentials, { serviceId, profileId }),
                                                    fetchQualifiedConnectedAccountCredential: async (ref) =>
                                                        await getQualifiedConnectedAccountCredentialV4(credentials, ref),
                                                    fetchQualifiedConnectedAccountConfiguration: async (ref) =>
                                                        await getQualifiedConnectedAccountConfigurationV4(credentials, ref),
                                                });

                                            const result = await migrateAccountEncryptionMode(auth.credentials, request);
                                            setAccountEncryptionMode(result.mode);

                                            if (generatedSecret) {
                                                await auth.login(auth.credentials.token, generatedSecret);
                                                await Modal.alertAsync(t('settingsAccount.backup'), t('settingsAccount.backupDescription'));
                                            }
                                        } catch (e) {
                                            if (e instanceof HappyError) {
                                                if (nextMode === 'e2ee' && e.status === 400) {
                                                    if (
                                                        !isLegacyAuthCredentials(credentials) &&
                                                        e.code === AccountEncryptionMigrateInvalidParamsReasonSchema.enum.restore_required
                                                    ) {
                                                        await Modal.alertAsync(
                                                            t('settingsAccount.restoreRequiredTitle'),
                                                            t('settingsAccount.restoreRequiredBody'),
                                                            [
                                                                {
                                                                    text: t('navigation.restoreWithSecretKey'),
                                                                    onPress: () => router.push('/restore/manual'),
                                                                },
                                                                {
                                                                    text: t('connect.lostAccessConfirmButton'),
                                                                    style: 'destructive',
                                                                    onPress: () => router.push('/restore/lost-access'),
                                                                },
                                                            ],
                                                        );
                                                        return;
                                                    }
                                                    if (e.code === AccountEncryptionMigrateInvalidParamsReasonSchema.enum.key_proof_required) {
                                                        await Modal.alertAsync(t('common.error'), t('settingsAccount.secretKeyMissing'));
                                                        return;
                                                    }
                                                }
                                                await Modal.alertAsync(t('common.error'), e.message);
                                                return;
                                            }
                                            await Modal.alertAsync(t('common.error'), t('settingsAccount.encryptionUpdateFailed'));
                                            return;
                                        } finally {
                                            setAccountEncryptionModeSaving(false);
                                        }
                                    }}
                                />
                            }
                            showChevron={false}
                        />
                    </ItemGroup>
                )}

                <ItemGroup
                    title={t('settingsAccount.privacy')}
                    footer={t('settingsAccount.privacyDescription')}
                >
                    <Item
                        title={t('settingsAccount.analytics')}
                        subtitle={analyticsOptOut ? t('settingsAccount.analyticsDisabled') : t('settingsAccount.analyticsEnabled')}
                        rightElement={
                            <Switch
                                testID="settings-account-analytics-switch"
                                value={!analyticsOptOut}
                                onValueChange={(value) => {
                                    const optOut = !value;
                                    setAnalyticsOptOut(optOut);
                                }}
                                trackColor={{
                                    false: theme.colors.switch.track.inactive,
                                    true: theme.colors.switch.track.active,
                                }}
                                thumbColor={!analyticsOptOut ? theme.colors.switch.thumb.active : theme.colors.switch.thumb.inactive}
                            />
                        }
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsAccount.crashReports')}
                        subtitle={crashReportsOptOut ? t('settingsAccount.crashReportsDisabled') : t('settingsAccount.crashReportsEnabled')}
                        rightElement={
                            <Switch
                                testID="settings-account-crash-reports-switch"
                                value={!crashReportsOptOut}
                                onValueChange={(value) => {
                                    const optOut = !value;
                                    setCrashReportsOptOut(optOut);
                                }}
                                trackColor={{
                                    false: theme.colors.switch.track.inactive,
                                    true: theme.colors.switch.track.active,
                                }}
                                thumbColor={!crashReportsOptOut ? theme.colors.switch.thumb.active : theme.colors.switch.thumb.inactive}
                            />
                        }
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Danger Zone */}
                <ItemGroup title={t('settingsAccount.dangerZone')}>
                    <Item
                        testID="settings-account-logout"
                        title={t('settingsAccount.logout')}
                        subtitle={t('settingsAccount.logoutSubtitle')}
                        icon={<SafeIonicons name="log-out-outline" size={29} color={theme.colors.state.danger.foreground} />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});
