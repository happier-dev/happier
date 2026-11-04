import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
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
import { getAvatarUrl } from '@/sync/domains/profiles/profile';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { HappyError } from '@/utils/errors/errors';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { checkAccountUsername, releaseAccountUsername, setAccountUsername } from '@/sync/api/account/apiUsername';
import { setAccountName } from '@/sync/api/account/apiAccountName';
import { storage } from '@/sync/domains/state/storageStore';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { Icon } from '@/components/ui/icons/Icon';
import { accountErasureFailureNotice } from '@/components/settings/home/governance/homeGovernanceLabels';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { SettingsHistorySection } from '@/components/settings/account/SettingsHistorySection';
import { AccountServiceSettingsSection } from '@/components/settings/account/AccountServiceSettingsSection';
import { AccountIdentifier } from '@/components/settings/account/AccountIdentifier';
import { resolveAccountIdentityFacts } from '@/components/settings/account/accountIdentityFacts';
import { parseToken } from '@/utils/auth/parseToken';
import { readOrganizationPolicyFieldState } from '@/components/organizationPolicy/OrganizationPolicyFieldNotice';
import { AccountSignInSecuritySection } from '@/components/settings/account/AccountSignInSecuritySection';
import { useAccountSecurityProjection } from '@/components/settings/account/useAccountSecurityProjection';
import { ACCOUNT_SETTINGS } from '@/components/settings/account/accountSettings';
import { showHomePairingModal } from '@/components/auth/pairing/HomePairingModal';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { AccountDirectConnectionsSection } from '@/components/settings/connections/DirectConnectionSettings';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AccountNameField } from '@/components/account/AccountNameField';
import { AccountUsernameField, type AccountUsernameCheck } from '@/components/account/AccountUsernameField';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { SelectionTiles, type SelectionTile } from '@/components/ui/forms/SelectionTiles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { ADD_HOME_RESTORE_PATH } from '@/auth/pairing/homeQrEntryIntent';

export const WorkspaceRouteBody = React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const router = useRouter();
    const accountScope = useAccountSettingsScope();
    const accountExecution = useMountedActionExecution(accountScope);
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
    const displayName = formatAccountDisplayName(profile);
    const security = useAccountSecurityProjection();
    const publicProfilesEnabled = useFeatureDecision('account.publicProfiles', { scopeKind: 'runtime' })?.state === 'enabled';
    // One username serves Friends and the public page; either feature lets the Account choose it.
    const canSetUsername = publicProfilesEnabled || (
        friendsEnabled &&
        !friendsIdentityReadiness.isLoadingFeatures &&
        friendsIdentityReadiness.gate.gateVariant === 'username');

    // The profile editor: the Account's name for everyone, and its username where Friends uses one.
    const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);
    const [nameError, setNameError] = useState<string | null>(null);
    const [usernameError, setUsernameError] = useState<string | null>(null);
    const [usernameCheck, setUsernameCheck] = useState<AccountUsernameCheck | null>(null);
    const openProfileEditor = () => {
        setNameError(null);
        setUsernameError(null);
        setUsernameCheck(null);
        setProfileDraft({ name: profile.name ?? '', username: profile.username ?? '' });
    };
    const nameChanged = profileDraft !== null && profileDraft.name.trim() !== (profile.name ?? '');
    const usernameChanged = canSetUsername && profileDraft !== null && profileDraft.username.trim() !== (profile.username ?? '');
    // The service's answer is advisory; a service that cannot answer still decides on Save.
    const checkUsername = async (raw: string): Promise<AccountUsernameCheck | null> => {
        if (!auth.credentials || !raw) return null;
        try {
            const answer = { raw, result: await checkAccountUsername(auth.credentials, raw, accountExecution) };
            setUsernameCheck(answer);
            return answer;
        } catch {
            return null;
        }
    };
    const checkDraftUsername = () => {
        const raw = profileDraft?.username.trim() ?? '';
        if (usernameChanged && raw && usernameCheck?.raw !== raw) void checkUsername(raw);
    };
    const [savingProfile, saveProfile] = useHappyAction(async () => {
        if (!auth.credentials || profileDraft === null) return;
        if (nameChanged) {
            setNameError(null);
            try {
                // The API publishes the Home's acknowledgment itself; nothing captured here is re-applied.
                await setAccountName(auth.credentials, profileDraft.name, accountExecution);
            } catch {
                setNameError(t('settingsAccount.nameSaveFailed'));
                return;
            }
        }
        if (usernameChanged) {
            setUsernameError(null);
            const raw = profileDraft.username.trim();
            const answer = usernameCheck?.raw === raw ? usernameCheck : await checkUsername(raw);
            if (answer && answer.result.availability !== 'available') return;
            try {
                await setAccountUsername(auth.credentials, answer?.result.username ?? raw, accountExecution);
            } catch (e) {
                if (!(e instanceof HappyError)) throw e;
                setUsernameError(
                    e.message === 'username-taken' ? t('friends.username.taken')
                        : e.message === 'invalid-username' ? t('friends.username.invalid')
                            : e.message === 'username-disabled' ? t('friends.username.disabled')
                                : e.message === 'friends-disabled' ? t('friends.disabled')
                                    : t('errors.operationFailed'),
                );
                return;
            }
        }
        setProfileDraft(null);
    });
    const cancelProfileEditor = () => { if (!savingProfile && !releasingUsername) setProfileDraft(null); };
    const [releasingUsername, releaseUsername] = useHappyAction(async () => {
        if (!auth.credentials) return;
        setUsernameError(null);
        try {
            await releaseAccountUsername(auth.credentials, accountExecution);
        } catch (e) {
            if (e instanceof HappyError && isActionApprovalDeclinedErrorCode(e.code)) return;
            setUsernameError(t('publicIdentity.handle.releaseFailed'));
            return;
        }
        setProfileDraft(null);
    });
    const cancelOnEscape = (event: { nativeEvent: { key: string } }) => { if (event.nativeEvent.key === 'Escape') cancelProfileEditor(); };

    const executeLeavingAction = async (actionId: 'account.signOut' | 'account.credentials.forgetAll' | 'account.delete') => {
        if (!accountScope) throw new Error('Account is unavailable');
        const outcome = await accountExecution.execute(actionId, { ...accountScope,
            ...(actionId === 'account.credentials.forgetAll' ? { scope: 'all-credentials' } : {}) });
        if (!outcome.ok && isActionApprovalDeclinedErrorCode(outcome.errorCode)) return;
        if (!outcome.ok) throw new HappyError(outcome.error, false, { code: outcome.errorCode, details: outcome.details });
    };
    const handleLogout = async () => {
        await executeLeavingAction('account.signOut');
    };
    const handleForgetAllCredentials = async () => {
        await executeLeavingAction('account.credentials.forgetAll');
    };
    const handleDeleteAccount = async () => {
        if (accountDeletionPending) return;
        setAccountDeletionPending(true);
        try {
            await executeLeavingAction('account.delete');
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') return;
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
    const homePolicy = readOrganizationPolicyFieldState('home');
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
        // A Home fixed by organization policy cannot take another; the tile is left out, not offered dead.
        ...(homePolicy.disabled ? [] : [{
            id: 'addHome' as const,
            testID: 'settings-account-add-home',
            icon: 'house' as const,
            title: t('settingsAccount.addAnotherHome'),
            subtitle: t('settingsAccount.addAnotherHomeSubtitle'),
        }]),
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
                // Naming yourself is this page's own operation: it stays by the identity on phones too.
                actionsPlacement="page"
                actions={(
                    <RoundButton
                        testID="settings-account-edit-profile"
                        display="secondary"
                        title={profile.name ? t('settingsAccount.editProfile') : t('settingsAccount.addName')}
                        accessibilityHint={canSetUsername && !profile.username ? t('friends.username.required') : undefined}
                        onPress={openProfileEditor}
                        disabled={profileDraft !== null}
                    />
                )}
            />

            {profileDraft !== null ? (
                <ItemGroup
                    title={t('settingsAccount.profileTitle')}
                    description={t('settingsAccount.profileDescription', { home: activeHomeLabel })}
                >
                    {accountExecution.approval.approvalPending && accountExecution.approval.approvalId && accountExecution.binding ? (
                        <ActionApprovalPendingNotice
                            testID="settings-account-profile-approval-pending"
                            message={t('approvals.waitingForYou')}
                            summary={accountExecution.approval.approvalSummary}
                            onOpenApproval={() => router.pushRetainingCurrent(buildApprovalHref(accountExecution.approval.approvalId!, accountExecution.binding!.scope.serverId))}
                        />
                    ) : null}
                    <SectionContentRow>
                        <AccountNameField
                            testID="settings-account-name-field"
                            value={profileDraft.name}
                            onChangeText={(name) => { setNameError(null); setProfileDraft({ ...profileDraft, name }); }}
                            error={nameError}
                            autoFocus
                            editable={!savingProfile}
                            returnKeyType={canSetUsername ? 'next' : 'done'}
                            onSubmitEditing={saveProfile}
                            onKeyPress={cancelOnEscape}
                        />
                    </SectionContentRow>
                    {canSetUsername ? (
                        <SectionContentRow>
                            <AccountUsernameField
                                testID="settings-account-username-field"
                                value={profileDraft.username}
                                onChangeText={(username) => { setUsernameError(null); setProfileDraft({ ...profileDraft, username }); }}
                                currentUsername={profile.username ?? null}
                                check={usernameCheck}
                                error={usernameError}
                                editable={!savingProfile && !releasingUsername}
                                onBlur={checkDraftUsername}
                                onSubmitEditing={saveProfile}
                                onKeyPress={cancelOnEscape}
                            />
                        </SectionContentRow>
                    ) : null}
                    {canSetUsername && profile.username ? (
                        <Item
                            testID="settings-account-username-release"
                            title={t('publicIdentity.handle.releaseTitle')}
                            subtitle={t('publicIdentity.handle.releaseDetail', { username: profile.username })}
                            subtitleLines={0}
                            showChevron={false}
                            rightElement={(
                                <RoundButton
                                    testID="settings-account-username-release-button"
                                    size="small"
                                    display="destructive"
                                    title={t('publicIdentity.handle.releaseAction')}
                                    disabled={savingProfile || releasingUsername || !accountExecution.ready}
                                    loading={releasingUsername && !accountExecution.approval.approvalPending}
                                    onPress={releaseUsername}
                                />
                            )}
                        />
                    ) : null}
                    <SectionContentRow>
                        <View style={accountStyles.editorActions}>
                            <RoundButton testID="settings-account-profile-cancel" size="small" display="secondary" title={t('common.cancel')} disabled={savingProfile} onPress={cancelProfileEditor} />
                            <RoundButton
                                testID="settings-account-profile-save"
                                size="small"
                                title={t('common.save')}
                                disabled={savingProfile || !accountExecution.ready || !(nameChanged || usernameChanged) || (usernameChanged && !profileDraft.username.trim())}
                                loading={savingProfile && !accountExecution.approval.approvalPending}
                                onPress={saveProfile}
                            />
                        </View>
                    </SectionContentRow>
                </ItemGroup>
            ) : null}

            {publicProfilesEnabled ? (
                <ItemGroup>
                    <Item
                        testID="settings-account-public-profile"
                        icon={<Icon name="globe" size={20} color={theme.colors.text.secondary} />}
                        title={t('publicIdentity.profile.title')}
                        subtitle={t('publicIdentity.profile.entrySubtitle')}
                        onPress={() => router.push(SETTINGS_ROUTES.accountPublicProfile)}
                    />
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

            {/* On a narrow page the shared tile owner draws these actions as rows of one group. */}
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

            {/* Leaving: one group of rows; Delete is its only destructive row. */}
            <ItemGroup title={t('settingsAccount.dangerZone')}>
                <Item
                    testID="settings-account-logout"
                    icon={<Icon name="sign-out" size={20} color={theme.colors.text.secondary} />}
                    title={t('settingsAccount.logoutHome', { home: activeHomeLabel })}
                    subtitle={t('settingsAccount.logoutHomeSubtitle', { home: activeHomeLabel })}
                    subtitleLines={0}
                    showChevron={false}
                    disabled={accountDeletionPending}
                    onPress={handleLogout}
                />
                <Item
                    testID="settings-account-forget-all-credentials"
                    icon={<Icon name="key" size={20} color={theme.colors.text.secondary} />}
                    title={t('settingsAccount.forgetAllCredentials')}
                    subtitle={t('settingsAccount.forgetAllCredentialsSubtitle')}
                    subtitleLines={0}
                    showChevron={false}
                    disabled={accountDeletionPending}
                    onPress={handleForgetAllCredentials}
                />
                <Item
                    testID="settings-account-delete"
                    icon={<Icon name="trash" size={20} color={theme.colors.state.danger.foreground} />}
                    title={t('settingsAccount.deleteAccountEllipsis')}
                    subtitle={t('settingsAccount.deleteAccountSubtitle')}
                    subtitleLines={0}
                    destructive
                    showChevron={false}
                    disabled={accountDeletionPending}
                    loading={accountDeletionPending}
                    onPress={handleDeleteAccount}
                />
            </ItemGroup>
        </ItemList>
    );
});

type DeviceTileId = 'addPhone' | 'addHome' | 'linkDevice';
type ProfileDraft = Readonly<{ name: string; username: string }>;

const accountStyles = StyleSheet.create((theme) => ({
    identifier: {
        ...Typography.mono(),
        fontSize: 12.5,
        color: theme.colors.text.secondary,
    },
    editorActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
}));
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
