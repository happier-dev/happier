import React, { useState } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useAuth } from '@/auth/context/AuthContext';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSettingMutable, useProfile } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/ui/forms/Switch';
import { useConnectAccount } from '@/hooks/auth/useConnectAccount';
import { getAvatarUrl, getDisplayName } from '@/sync/domains/profiles/profile';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { HappyError } from '@/utils/errors/errors';
import { setAccountUsername } from '@/sync/api/account/apiUsername';
import { storage } from '@/sync/domains/state/storageStore';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { ACCOUNT_ERASURE_CONFIRMATION_V1 } from '@happier-dev/protocol/auth/accountErasure';
import { Icon } from '@/components/ui/icons/Icon';
import { presentFirstKeyCredentialLifecycle } from '@/components/account/presentFirstKeyCredentialLifecycle';
import { deleteCurrentAccount } from '@/sync/api/account/deleteCurrentAccount';
import { accountErasureFailureNotice } from '@/components/settings/home/governance/homeGovernanceLabels';
import { AccountDeletedLocalCleanupError, completeAccountDeletion } from '@/components/settings/account/accountDeletionLifecycle';
import { SettingsHistorySection } from '@/components/settings/account/SettingsHistorySection';
import { AccountServiceSettingsSection } from '@/components/settings/account/AccountServiceSettingsSection';
import { AccountIdentifier } from '@/components/settings/account/AccountIdentifier';
import { resolveAccountIdentityFacts } from '@/components/settings/account/accountIdentityFacts';
import { parseToken } from '@/utils/auth/parseToken';
import { AccountSignInSecuritySection } from '@/components/settings/account/AccountSignInSecuritySection';
import { useAccountSecurityProjection } from '@/components/settings/account/useAccountSecurityProjection';
import { ACCOUNT_SETTINGS } from '@/components/settings/account/accountSettings';
import { showHomePairingModal } from '@/components/auth/pairing/HomePairingModal';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { AccountDirectConnectionsSection } from '@/components/settings/connections/DirectConnectionSettings';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ADD_HOME_RESTORE_PATH } from '@/auth/pairing/homeQrEntryIntent';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';

export const WorkspaceRouteBody = React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const { width, height } = useWindowDimensions();
    const [accountDeletionPending, setAccountDeletionPending] = useState(false);
    const [analyticsOptOut, setAnalyticsOptOut] = useSettingMutable('analyticsOptOut');
    const [crashReportsOptOut, setCrashReportsOptOut] = useSettingMutable('crashReportsOptOut');
    const { connectAccount, isLoading: isConnecting } = useConnectAccount();
    const profile = useProfile();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendsEnabled = useFriendsEnabled();
    const applyProfile = storage((state) => state.applyProfile);
    const activeServer = useActiveServerSnapshot();
    // The Home's name, never its address; a sentence without one says "this Home".
    const activeHomeName = resolveHomeDisplayName(getServerProfileById(activeServer.serverId));
    const activeHomeLabel = activeHomeName ?? t('settingsAccount.thisHome');
    // Profile display values
    const displayName = getDisplayName(profile);
    const security = useAccountSecurityProjection();
    const canSetUsername =
        friendsEnabled &&
        !friendsIdentityReadiness.isLoadingFeatures &&
        friendsIdentityReadiness.gate.gateVariant === 'username';

    const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
    const [savingUsername, saveUsername] = useHappyAction(async () => {
        if (!auth.credentials) return;
        if (!canSetUsername) return;
        if (usernameDraft === null) return;

        try {
            const res = await setAccountUsername(auth.credentials, usernameDraft);
            applyProfile({ ...profile, username: res.username });
            setUsernameDraft(null);
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

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('settingsAccount.logoutHome', { home: activeHomeLabel }),
            t('settingsAccount.logoutHomeConfirm', { home: activeHomeLabel }),
            {
                confirmText: t('settingsAccount.logoutHome', { home: activeHomeLabel }),
                destructive: true,
            },
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
    const handleForgetAllCredentials = async () => {
        const confirmed = await Modal.confirm(
            t('settingsAccount.forgetAllCredentials'),
            t('settingsAccount.forgetAllCredentialsConfirm'),
            {
                confirmText: t('settingsAccount.forgetAllCredentials'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        let routed = false;
        const routeAfterAuthorization = () => {
            if (routed) return;
            routed = true;
            router.replace('/');
        };
        await presentFirstKeyCredentialLifecycle({
            run: async () =>
                await auth.logout({
                    scope: 'all-credentials',
                    beforeMutation: routeAfterAuthorization,
                }),
            onCompleted: routeAfterAuthorization,
        });
    };
    const handleDeleteAccount = async () => {
        if (accountDeletionPending) return;
        const confirmation = await Modal.prompt(t('settingsAccount.deleteAccountConfirmTitle'), t('settingsAccount.deleteAccountConfirmBody'), { placeholder: ACCOUNT_ERASURE_CONFIRMATION_V1, confirmText: t('settingsAccount.deleteAccount') });
        if (confirmation === null) return;
        if (confirmation.trim() !== ACCOUNT_ERASURE_CONFIRMATION_V1) { await Modal.alertAsync(t('settingsAccount.deleteAccountInvalidTitle'), t('settingsAccount.deleteAccountInvalidBody')); return; }
        const credentials = auth.credentials;
        const deletionScope = getActiveServerAccountScope();
        if (!credentials || !deletionScope) { await Modal.alertAsync(t('common.error'), t('settingsAccount.deleteAccountFailed')); return; }
        setAccountDeletionPending(true);
        let runDeletionCleanup = async () => await completeAccountDeletion({
            scope: deletionScope,
            deleteCurrentAccount: async () => await deleteCurrentAccount(credentials),
            logout: auth.logout,
            replace: (path) => router.replace(path),
        });
        try {
            while (true) {
                try {
                    await presentFirstKeyCredentialLifecycle({ run: runDeletionCleanup });
                    break;
                } catch (error) {
                    if (!(error instanceof AccountDeletedLocalCleanupError)) throw error;
                    let retry = false;
                    await Modal.alertAsync(
                        t('settingsAccount.deleteAccountCleanupFailedTitle'),
                        t('settingsAccount.deleteAccountCleanupFailed'),
                        [
                            { text: t('common.cancel'), style: 'cancel' },
                            { text: t('common.retry'), onPress: () => { retry = true; } },
                        ],
                    );
                    if (!retry) break;
                    runDeletionCleanup = error.retryLocalCleanup;
                }
            }
        } catch (error) {
            // The Home's typed verdict names the real obstacle — the last Home
            // or Team owner must hand ownership on first — so it is shown
            // through the same owner that names it for administrators. Only an
            // answer without a verdict keeps the "not confirmed" notice.
            const notice = accountErasureFailureNotice(error);
            await Modal.alertAsync(notice.title, notice.body);
        }
        finally { setAccountDeletionPending(false); }
    };

    const isPhoneSizedWeb = Platform.OS === 'web' && isWebMobileLikeQrScannerHost({ width, height });
    const showAddYourPhone = isRunningOnMac() || (Platform.OS === 'web' && !isPhoneSizedWeb);
    // Only Link new device needs this device's scanner. Add another Home opens the
    // shared add_home restore entry, which falls back to pasting a pairing link.
    const showLinkNewDevice = canUseCurrentDeviceQrScanner();
    // The Account ID on this Home is the subject of the signed-in credential.
    const accountId = React.useMemo(() => {
        if (!auth.credentials) return null;
        try {
            return parseToken(auth.credentials.token) || null;
        } catch {
            return null;
        }
    }, [auth.credentials]);
    const identityMeta = resolveAccountIdentityFacts({ username: profile.username, homeName: activeHomeName, security });
    const deviceTiles: SelectionTile<DeviceTileId>[] = [
        ...(showAddYourPhone ? [{
            id: 'addPhone' as const,
            testID: 'settings-account-add-your-phone',
            icon: 'device-mobile' as const,
            title: t('settings.addYourPhone'),
            subtitle: t('settings.addYourPhoneSubtitle'),
        }] : []),
        {
            id: 'addHome',
            testID: 'settings-account-add-home',
            icon: 'house',
            title: t('settingsAccount.addAnotherHome'),
            subtitle: t('settingsAccount.addAnotherHomeSubtitle'),
        },
        ...(showLinkNewDevice ? [{
            id: 'linkDevice' as const,
            testID: 'settings-account-link-new-device',
            icon: 'qr-code' as const,
            title: t('settingsAccount.linkNewDevice'),
            subtitle: isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle'),
            disabled: isConnecting,
        }] : []),
    ];
    const openDeviceTile = (id: DeviceTileId) => {
        // The QR opens over the page (lab I5): there is no tile here to grow in place.
        if (id === 'addPhone') showHomePairingModal('phone');
        else if (id === 'addHome') router.push(ADD_HOME_RESTORE_PATH);
        else void connectAccount();
    };
    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader
                testID="settings-account-identity"
                {...(displayName ? { title: displayName, alwaysShowTitle: true } : {})}
                details={accountId ? <AccountIdentifier accountId={accountId} /> : undefined}
                meta={identityMeta}
                leading={(
                    <Avatar
                        id={profile.id}
                        size={56}
                        imageUrl={getAvatarUrl(profile)}
                        thumbhash={profile.avatar?.thumbhash}
                    />
                )}
                actions={canSetUsername ? (
                    <RoundButton
                        testID="settings-account-username"
                        size="small"
                        display="secondary"
                        title={profile.username ? t('settingsAccount.editUsername') : t('settingsAccount.chooseUsername')}
                        accessibilityHint={profile.username ? undefined : t('friends.username.required')}
                        onPress={() => setUsernameDraft(profile.username ?? '')}
                        disabled={savingUsername}
                        loading={savingUsername}
                    />
                ) : undefined}
            />

            {canSetUsername && usernameDraft !== null ? (
                <ItemGroup>
                    <SectionContentRow>
                        <FieldItem label={t('profile.username')}>
                            <FieldTextInput
                                testID="settings-account-username-field"
                                value={usernameDraft}
                                onChangeText={setUsernameDraft}
                                accessibilityLabel={t('profile.username')}
                                autoCapitalize="none"
                                editable={!savingUsername}
                                onSubmitEditing={saveUsername}
                            />
                        </FieldItem>
                    </SectionContentRow>
                    <SectionContentRow>
                        <View style={{ flexDirection: 'row', gap: 8 }}>
                            <RoundButton testID="settings-account-username-cancel" size="small" display="secondary" title={t('common.cancel')} disabled={savingUsername} onPress={() => setUsernameDraft(null)} />
                            <RoundButton testID="settings-account-username-save" size="small" title={t('common.save')} disabled={savingUsername || !usernameDraft.trim()} loading={savingUsername} onPress={saveUsername} />
                        </View>
                    </SectionContentRow>
                </ItemGroup>
            ) : null}

            <AccountSignInSecuritySection
                homeName={activeHomeLabel}
                security={security}
                profile={profile}
                credentials={auth.credentials}
                applyProfile={applyProfile}
            />

            <AccountServiceSettingsSection />

            <ItemGroup title={t('settingsAccount.devices')} surface="none">
                <SelectionTiles
                    variant="action"
                    accessibilityLabel={t('settingsAccount.devices')}
                    options={deviceTiles}
                    onPress={openDeviceTile}
                />
            </ItemGroup>

            <AccountDirectConnectionsSection />

            <ItemGroup title={t('settingsAccount.privacy')}>
                <SettingRow
                    setting={ACCOUNT_SETTINGS.settings.analytics}
                    subtitleLines={2}
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
                <SettingRow
                    setting={ACCOUNT_SETTINGS.settings.crashReports}
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
                {/* Settings history: the client-side classification-aware restore owner, as a disclosure. */}
                <SettingAnchor setting={ACCOUNT_SETTINGS.settings.settingsHistory}>
                    <SettingsHistorySection
                        credentials={auth.credentials}
                        encryption={sync.encryption}
                    />
                </SettingAnchor>
            </ItemGroup>

            <ItemGroup title={t('settingsAccount.accountDetails')}>
                <Item
                    title={t('settingsAccount.anonymousId')}
                    detail={sync.anonID || t('settingsAccount.notAvailable')}
                    showChevron={false}
                    copy={!!sync.anonID}
                    detailStyle={sync.anonID ? accountStyles.identifier : undefined}
                />
                <Item
                    title={t('settingsAccount.status')}
                    detail={auth.isAuthenticated ? t('settingsAccount.statusActive') : t('settingsAccount.statusNotAuthenticated')}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>

            {/* Leaving: quiet, separated actions. The irreversible one stands apart at the end. */}
            <ItemGroup surface="none" accessibilityLabel={t('settingsAccount.dangerZone')}>
                <View testID="settings-account-danger-zone" style={accountStyles.leaveActions}>
                    <RoundButton
                        testID="settings-account-logout"
                        size="small"
                        display="secondary"
                        leading={<Icon name="sign-out" size={15} color={theme.colors.text.primary} />}
                        title={t('settingsAccount.logoutHome', { home: activeHomeLabel })}
                        titleNumberOfLines="complete"
                        accessibilityHint={t('settingsAccount.logoutHomeSubtitle', { home: activeHomeLabel })}
                        disabled={accountDeletionPending}
                        onPress={handleLogout}
                    />
                    <RoundButton
                        testID="settings-account-forget-all-credentials"
                        size="small"
                        display="inverted"
                        title={t('settingsAccount.forgetAllCredentials')}
                        titleNumberOfLines="complete"
                        textStyle={accountStyles.quietAction}
                        accessibilityHint={t('settingsAccount.forgetAllCredentialsSubtitle')}
                        disabled={accountDeletionPending}
                        onPress={handleForgetAllCredentials}
                    />
                    <View style={accountStyles.leaveSpacer} />
                    <RoundButton
                        testID="settings-account-delete"
                        size="small"
                        display="destructive"
                        title={t('settingsAccount.deleteAccountEllipsis')}
                        titleNumberOfLines="complete"
                        accessibilityHint={t('settingsAccount.deleteAccountSubtitle')}
                        disabled={accountDeletionPending}
                        loading={accountDeletionPending}
                        onPress={handleDeleteAccount}
                    />
                </View>
                <Text style={accountStyles.footnote}>{t('settingsAccount.signOutFootnote')}</Text>
            </ItemGroup>
        </ItemList>
    );
});

type DeviceTileId = 'addPhone' | 'addHome' | 'linkDevice';

const accountStyles = StyleSheet.create((theme) => ({
    identifier: {
        ...Typography.mono(),
        fontSize: 12.5,
        color: theme.colors.text.secondary,
    },
    leaveActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
    },
    // Pushes "Delete account" to the far edge when the row fits, apart from the recoverable actions.
    leaveSpacer: {
        flexGrow: 1,
    },
    quietAction: {
        ...Typography.default('medium'),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    footnote: {
        ...Typography.default('regular'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        marginTop: 10,
        marginHorizontal: 2,
    },
}));
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
