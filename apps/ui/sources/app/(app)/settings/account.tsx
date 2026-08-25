import React, { useState } from 'react';
import { View, Pressable, Platform, useWindowDimensions } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/recovery/secretKeyBackup';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SettingsCatalogPageChildren } from '@/components/settings/SettingsCatalogOverviewGroup';
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
import {
    isLegacyAuthCredentials,
    isTokenOnlyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    fetchAccountEncryptionCurrentness,
    fetchAccountEncryptionMode,
} from '@/sync/api/account/apiAccountEncryptionMode';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { migrateAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMigrate';
import { Text } from '@/components/ui/text/Text';
import { useRouter } from 'expo-router';
import { isRunningOnMac } from '@/utils/platform/platform';
import { buildAccountEncryptionMigrateToPlainRequest } from '@/sync/ops/account/buildAccountEncryptionMigrateToPlainRequest';
import { getConnectedServiceCredentialSealed } from '@/sync/api/account/apiConnectedServicesV2';
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
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { fetchMachineRows } from '@/sync/engine/machines/syncMachines';
import { kvList } from '@/sync/api/account/apiKv';
import {
    fetchArtifact,
    fetchArtifacts,
} from '@/sync/api/artifacts/apiArtifacts';
import {
    buildAccountEncryptionMigrationStorageDirectives,
} from '@/sync/ops/account/buildAccountEncryptionMigrationStorageDirectives';
import {
    fetchAccountEncryptionMigrationSessionInventory,
} from '@/sync/ops/account/fetchAccountEncryptionMigrationSessionInventory';
import {
    fetchReviewCommentAccountEncryptionMigrationInventory,
} from '@/sync/domains/reviews/comments/accountEncryptionMigrationApi';
import {
    fetchSessionOrganizationAccountEncryptionMigrationInventory,
} from '@/sync/ops/account/fetchSessionOrganizationAccountEncryptionMigrationInventory';
import {
    prepareAccountEncryptionMigrateToE2eeKey,
} from '@/sync/ops/account/prepareAccountEncryptionMigrateToE2eeKey';
import {
    openAccountEncryptionFirstKeyExternalAuthUrl,
    retryPendingAccountEncryptionFirstKeyExternalAuth,
    resumeAccountEncryptionFirstKeyExternalAuth,
    startAccountEncryptionFirstKeyExternalAuth,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { Icon } from '@/components/ui/icons/Icon';
import {
    presentFirstKeyCredentialLifecycle,
} from '@/components/account/presentFirstKeyCredentialLifecycle';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import {
    acknowledgeNewSessionDraftEncryptionMigration,
    listNewSessionDraftEncryptionMigrationCandidates,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { runAccountEncryptionModeMigration } from '@/sync/ops/account/runAccountEncryptionModeMigration';


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
    const sessionDraftSyncEnabled = useFeatureEnabled('sessions.drafts');

    const [accountEncryptionMode, setAccountEncryptionMode] = useState<'e2ee' | 'plain' | null>(null);
    const [accountEncryptionModeLoading, setAccountEncryptionModeLoading] = useState(false);
    const [accountEncryptionModeSaving, setAccountEncryptionModeSaving] = useState(false);
    const firstKeyRecoveryAttemptedTokenRef =
        React.useRef<string | null>(null);

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
        const credentialsToken = credentials.token;

        let cancelled = false;
        setAccountEncryptionModeLoading(true);
        fetchAccountEncryptionMode(credentials)
            .then(async (res) => {
                if (cancelled) return;
                try {
                    if (
                        res.mode === 'plain'
                        && !isTokenOnlyAuthCredentials(credentials)
                    ) {
                        const credentialReplacement =
                            await auth.loginWithCredentials({
                                token: credentialsToken,
                            });
                        if (credentialReplacement.kind !== 'completed') {
                            throw new Error(
                                'Plain Account credentials could not be persisted',
                            );
                        }
                        if (cancelled) return;
                    }
                    setAccountEncryptionMode(res.mode);
                    const recoveryAttemptKey =
                        isLegacyAuthCredentials(credentials)
                            ? [
                                credentials.token,
                                credentials.secret,
                            ].join('\u0000')
                            : credentials.token;
                    if (
                        res.mode !== 'e2ee'
                        || firstKeyRecoveryAttemptedTokenRef.current
                            === recoveryAttemptKey
                    ) {
                        return;
                    }
                    firstKeyRecoveryAttemptedTokenRef.current =
                        recoveryAttemptKey;
                    const replayed =
                        await retryPendingAccountEncryptionFirstKeyExternalAuth({
                            currentCredentials: credentials,
                            persistCredentials:
                                auth.loginWithCredentials,
                        });
                    if (cancelled || !replayed) return;
                    setAccountEncryptionMode(
                        replayed.mode,
                    );
                } catch (error) {
                    if (cancelled) return;
                    await Modal.alertAsync(
                        t('common.error'),
                        error instanceof HappyError
                            ? error.message
                            : t(
                                'settingsAccount.encryptionUpdateFailed',
                            ),
                    );
                }
            })
            .finally(() => {
                if (cancelled) return;
                setAccountEncryptionModeLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [
        auth.credentials,
        encryptionAccountOptOutEnabled,
    ]);

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
            await presentFirstKeyCredentialLifecycle({
                run: async () =>
                    await auth.logout({
                        beforeMutation: () =>
                            router.replace('/'),
                    }),
            });
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

                <SettingsCatalogPageChildren
                    parentPageId="account"
                    router={router}
                    theme={theme}
                />

                {/* Account access / linking */}
                {showAccountAccessGroup ? (
                    <ItemGroup>
                        {showAddYourPhone ? (
                            <Item
                                testID="settings-account-add-your-phone"
                                title={t('settings.addYourPhone')}
                                subtitle={t('settings.addYourPhoneSubtitle')}
                                icon={<Icon name="device-mobile" size={29} color={theme.colors.accent.blue} />}
                                onPress={() => router.push('/settings/add-phone')}
                                showChevron={false}
                            />
                        ) : null}
                        {showLinkNewDevice ? (
                            <Item
                                testID="settings-account-link-new-device"
                                title={t('settingsAccount.linkNewDevice')}
                                subtitle={isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle')}
                                icon={<Icon name="qr-code" size={29} color={theme.colors.accent.blue} />}
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
                                icon={<Icon name="at" size={29} color={theme.colors.text.secondary} />}
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
                                <Icon
                                    name={showSecret ? 'eye-slash' : 'eye'}
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
                                        <Icon
                                            name="copy"
                                            size={16}
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
                                    <Icon
                                        name={copiedRecently ? "check-circle" : "copy"}
                                        size={16}
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
                                        const credentialsToken =
                                            credentials.token;
                                        const nextMode = enabled ? 'e2ee' : 'plain';
                                        const sourceEncryption = sync.encryption;

                                        setAccountEncryptionModeSaving(true);
                                        try {
                                            if (
                                                nextMode === 'e2ee'
                                                && isTokenOnlyAuthCredentials(
                                                    credentials,
                                                )
                                            ) {
                                                const replayed =
                                                    await retryPendingAccountEncryptionFirstKeyExternalAuth({
                                                        currentCredentials:
                                                            credentials,
                                                        persistCredentials:
                                                            auth.loginWithCredentials,
                                                    });
                                                if (replayed) {
                                                    setAccountEncryptionMode(
                                                        replayed.mode,
                                                    );
                                                    return;
                                                }
                                            }
                                            if (nextMode === 'plain' && !sourceEncryption) {
                                                throw new Error(
                                                    'Account encryption material is unavailable for the E2EE-to-plaintext migration',
                                                );
                                            }
                                            const currentness =
                                                await fetchAccountEncryptionCurrentness(
                                                    credentials,
                                                );
                                            if (
                                                currentness.mode
                                                !== accountEncryptionMode
                                            ) {
                                                if (
                                                    currentness.mode === 'plain'
                                                    && !isTokenOnlyAuthCredentials(
                                                        credentials,
                                                    )
                                                ) {
                                                    const credentialReplacement =
                                                        await auth.loginWithCredentials({
                                                            token: credentialsToken,
                                                        });
                                                    if (
                                                        credentialReplacement.kind
                                                        !== 'completed'
                                                    ) {
                                                        throw new Error(
                                                            'Plain Account credentials could not be persisted',
                                                        );
                                                    }
                                                    setAccountEncryptionMode(
                                                        currentness.mode,
                                                    );
                                                    return;
                                                }
                                                setAccountEncryptionMode(
                                                    currentness.mode,
                                                );
                                                throw new Error(
                                                    'Account encryption mode changed while preparing the migration',
                                                );
                                            }
                                            const expectedSettingsVersion = storage.getState().settingsVersion ?? 0;
                                            const connectedServiceProfiles = profile.connectedServicesV2.flatMap((svc) =>
                                                svc.profiles.map((p) => ({
                                                    serviceId: svc.serviceId as any,
                                                    profileId: p.profileId,
                                                })),
                                            );
                                            const automations = Object.values(storage.getState().automations ?? {}).map((a: any) => ({
                                                id: a.id,
                                                templateVersion: a.templateVersion,
                                                templateCiphertext: a.templateCiphertext,
                                            }));
                                            const preparedE2eeKey =
                                                nextMode === 'e2ee'
                                                    ? await prepareAccountEncryptionMigrateToE2eeKey({
                                                        credentials,
                                                        expectedSigningKeyFingerprint:
                                                            currentness
                                                                .signingKeyFingerprint,
                                                        expectedContentKeyFingerprint:
                                                            currentness
                                                                .contentKeyFingerprint,
                                                    })
                                                    : null;
                                            const targetEncryption =
                                                nextMode === 'e2ee'
                                                    ? await createEncryptionFromAuthCredentials(
                                                        preparedE2eeKey!
                                                            .credentials,
                                                    )
                                                    : null;
                                            const [
                                                machineRows,
                                                todoRows,
                                                artifactList,
                                                sessionRows,
                                                reviewCommentsInventory,
                                                sessionOrganizationInventory,
                                            ] = await Promise.all([
                                                fetchMachineRows({
                                                    credentials,
                                                }),
                                                kvList(credentials, {
                                                    prefix: 'todo.',
                                                    limit: 1000,
                                                    retry: 'none',
                                                }).then(
                                                    (response) =>
                                                        response.items,
                                                ),
                                                fetchArtifacts(credentials, {
                                                    retry: 'none',
                                                }),
                                                fetchAccountEncryptionMigrationSessionInventory({
                                                    token: credentials.token,
                                                }),
                                                fetchReviewCommentAccountEncryptionMigrationInventory(),
                                                fetchSessionOrganizationAccountEncryptionMigrationInventory(),
                                            ]);
                                            const artifactRows =
                                                await runTasksWithLimit(
                                                    artifactList.map(
                                                        (artifact) =>
                                                            async () => {
                                                                const full =
                                                                    await fetchArtifact(
                                                                        credentials,
                                                                        artifact.id,
                                                                        {
                                                                            retry:
                                                                                'none',
                                                                        },
                                                                    );
                                                                if (
                                                                    typeof full.body
                                                                        !==
                                                                        'string'
                                                                    || typeof full.bodyVersion
                                                                        !==
                                                                        'number'
                                                                ) {
                                                                    throw new Error(
                                                                        `Artifact migration snapshot is incomplete (${artifact.id})`,
                                                                    );
                                                                }
                                                                return {
                                                                    id: full.id,
                                                                    header:
                                                                        full.header,
                                                                    headerVersion:
                                                                        full.headerVersion,
                                                                    body:
                                                                        full.body,
                                                                    bodyVersion:
                                                                        full.bodyVersion,
                                                                    dataEncryptionKey:
                                                                        full.dataEncryptionKey,
                                                                };
                                                            },
                                                    ),
                                                    4,
                                                );
                                            const storageDirectives =
                                                await buildAccountEncryptionMigrationStorageDirectives({
                                                    fromMode:
                                                        currentness.mode,
                                                    toMode: nextMode,
                                                    sourceEncryption:
                                                        nextMode === 'plain'
                                                            ? sourceEncryption
                                                            : null,
                                                    targetEncryption,
                                                    machines: machineRows,
                                                    todos: todoRows,
                                                    artifacts: artifactRows,
                                                    sessions: sessionRows,
                                                    reviewCommentsInventory,
                                                    sessionOrganizationInventory,
                                                    sessionSourceCredentials:
                                                        credentials,
                                                    sessionTargetCredentials:
                                                        preparedE2eeKey
                                                            ?.credentials
                                                        ?? null,
                                                });
                                            const sessionDraftScope = sessionDraftSyncEnabled
                                                ? getActiveServerAccountScope()
                                                : null;
                                            const sessionDrafts = sessionDraftScope
                                                ? listNewSessionDraftEncryptionMigrationCandidates(
                                                    sessionDraftScope,
                                                )
                                                : [];
                                            const request = nextMode === 'plain'
                                                ? await buildAccountEncryptionMigrateToPlainRequest({
                                                    credentials,
                                                    expectedAccountVersion:
                                                        currentness.version,
                                                    expectedSigningKeyFingerprint:
                                                        currentness
                                                            .signingKeyFingerprint,
                                                    expectedContentKeyFingerprint:
                                                        currentness
                                                            .contentKeyFingerprint,
                                                    storageDirectives,
                                                    expectedSettingsVersion,
                                                    settings: storage.getState().settings,
                                                    connectedServiceProfiles,
                                                    qualifiedConnectedAccounts:
                                                        profile.connectedAccountsV4,
                                                    automations,
                                                    sessionDrafts,
                                                    fetchConnectedServiceCredentialSealed: async ({ serviceId, profileId }) =>
                                                        await getConnectedServiceCredentialSealed(credentials, { serviceId, profileId }),
                                                    fetchQualifiedConnectedAccountCredential: async (ref) =>
                                                        await getQualifiedConnectedAccountCredentialV4(credentials, ref),
                                                    fetchQualifiedConnectedAccountConfiguration: async (ref) =>
                                                        await getQualifiedConnectedAccountConfigurationV4(credentials, ref),
                                                    decryptAutomationTemplateRaw: async (payloadCiphertext: string) =>
                                                        await sourceEncryption!.decryptAutomationTemplateRaw(payloadCiphertext),
                                                })
                                                : await buildAccountEncryptionMigrateToE2eeRequest({
                                                    credentials:
                                                        preparedE2eeKey!
                                                            .credentials,
                                                    accountId: profile.id,
                                                    expectedAccountVersion:
                                                        currentness.version,
                                                    expectedSigningKeyFingerprint:
                                                        currentness
                                                            .signingKeyFingerprint,
                                                    expectedContentKeyFingerprint:
                                                        currentness
                                                            .contentKeyFingerprint,
                                                    storageDirectives,
                                                    expectedSettingsVersion,
                                                    settings: storage.getState().settings,
                                                    connectedServiceProfiles,
                                                    qualifiedConnectedAccounts:
                                                        profile.connectedAccountsV4,
                                                    automations,
                                                    sessionDrafts,
                                                    keyProof:
                                                        preparedE2eeKey!
                                                            .keyProof,
                                                    fetchConnectedServiceCredentialPlain: async ({ serviceId, profileId }) =>
                                                        await getConnectedServiceCredentialPlain(credentials, { serviceId, profileId }),
                                                    fetchQualifiedConnectedAccountCredential: async (ref) =>
                                                        await getQualifiedConnectedAccountCredentialV4(credentials, ref),
                                                    fetchQualifiedConnectedAccountConfiguration: async (ref) =>
                                                        await getQualifiedConnectedAccountConfigurationV4(credentials, ref),
                                                });

                                            const result =
                                                nextMode === 'e2ee'
                                                && preparedE2eeKey!
                                                    .requiresExternalAuthProof
                                                    ? await (async () => {
                                                        const externalAuth =
                                                            await startAccountEncryptionFirstKeyExternalAuth({
                                                                accountId:
                                                                    profile.id,
                                                                currentCredentials:
                                                                    credentials,
                                                                proposedCredentials:
                                                                    preparedE2eeKey!
                                                                        .credentials,
                                                                request,
                                                                linkedProviderIds:
                                                                    (
                                                                        profile
                                                                            .linkedProviders
                                                                        ?? []
                                                                    ).map(
                                                                        (
                                                                            provider,
                                                                        ) =>
                                                                            provider.id,
                                                                    ),
                                                                returnTo:
                                                                    '/settings/account',
                                                            });
                                                        if (
                                                            externalAuth.kind
                                                            === 'oauth'
                                                        ) {
                                                            await openAccountEncryptionFirstKeyExternalAuthUrl(
                                                                externalAuth.url,
                                                            );
                                                            return null;
                                                        }
                                                        const resumed =
                                                            await resumeAccountEncryptionFirstKeyExternalAuth({
                                                            provider:
                                                                externalAuth
                                                                    .externalAuthProof
                                                                    .provider,
                                                            pending:
                                                                externalAuth
                                                                    .externalAuthProof
                                                                    .pending,
                                                            currentCredentials:
                                                                credentials,
                                                            persistCredentials:
                                                                auth.loginWithCredentials,
                                                        });
                                                        return resumed.migration;
                                                    })()
                                                    : await runAccountEncryptionModeMigration({
                                                        request,
                                                        migrate: async (migrationRequest) =>
                                                            await migrateAccountEncryptionMode(
                                                                credentials,
                                                                migrationRequest,
                                                            ),
                                                        activateTargetMode: () => {
                                                            sync.reconfigureSessionDraftRepositoryForAccountMode(
                                                                nextMode === 'e2ee'
                                                                    ? preparedE2eeKey!.credentials
                                                                    : credentials,
                                                                nextMode,
                                                            );
                                                        },
                                                        acknowledgeSessionDrafts: async (records) => {
                                                            if (!sessionDraftScope) {
                                                                throw new Error(
                                                                    'Session draft repository scope is unavailable',
                                                                );
                                                            }
                                                            await acknowledgeNewSessionDraftEncryptionMigration(
                                                                sessionDraftScope,
                                                                records,
                                                            );
                                                        },
                                                    });
                                            if (!result) return;
                                            if (
                                                nextMode === 'plain'
                                                && result.mode === 'plain'
                                            ) {
                                                const credentialReplacement =
                                                    await auth.loginWithCredentials({
                                                        token: credentials.token,
                                                    });
                                                if (
                                                    credentialReplacement.kind
                                                    !== 'completed'
                                                ) {
                                                    throw new Error(
                                                        'Plain Account credentials could not be persisted',
                                                    );
                                                }
                                            }
                                            setAccountEncryptionMode(result.mode);

                                        } catch (e) {
                                            if (e instanceof HappyError) {
                                                if (nextMode === 'e2ee' && e.status === 400) {
                                                    if (
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
                        icon={<Icon name="sign-out" size={29} color={theme.colors.state.danger.foreground} />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});
