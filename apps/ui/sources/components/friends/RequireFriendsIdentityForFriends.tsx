import React from 'react';
import { Linking, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useOAuthProviderConfigured } from '@/hooks/server/useOAuthProviderConfigured';
import { resolveFriendsIdentityConnectOption, type FriendsIdentityConnectOption, type FriendsUsernameHint } from './resolveFriendsIdentityGate';
import { t } from '@/text';
import { useAuth } from '@/auth/context/AuthContext';
import { getAuthProvider } from '@/auth/providers/registry';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setAccountUsername } from '@/sync/api/account/apiUsername';
import { HappyError } from '@/utils/errors/errors';
import { Modal } from '@/modal';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { isSafeExternalAuthUrl } from '@/auth/providers/externalAuthUrl';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AccountUsernameField } from '@/components/account/AccountUsernameField';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';


function translateUsernameHint(hint: FriendsUsernameHint): string {
    switch (hint.key) {
        case 'friends.username.preferredNotAvailable':
            return t(hint.key);
        case 'friends.username.preferredNotAvailableWithLogin':
            return t(hint.key, hint.params);
    }
}

/**
 * The identity Friends needs, as one section of the page it stands on: the username claim (its field, Save, and the
 * configured provider as the other way in), or, where the Home requires a provider, that provider by name. A provider
 * this Home has not configured is never offered (`resolveFriendsIdentityConnectOption`).
 */
export function RequireFriendsIdentityForFriendsBase(props: {
    variant: 'provider' | 'username';
    isReady: boolean;
    /** The Home's Friends features are still being read: the section holds its place without a form. */
    loading?: boolean;
    connect: FriendsIdentityConnectOption;
    initialUsername?: string;
    usernameHint?: string;
    /** Why the last Save failed, under the field. */
    usernameError?: string | null;
    onConnectProvider?: () => void;
    connectingProvider?: boolean;
    connectProviderDisabled?: boolean;
    onSaveUsername?: (username: string) => void;
    savingUsername?: boolean;
    saveUsernameDisabled?: boolean;
    approvalNotice?: React.ReactNode;
    children: React.ReactNode;
}) {
    const [username, setUsername] = React.useState(props.initialUsername ?? '');

    React.useEffect(() => {
        if (!props.initialUsername) return;
        setUsername((current) => (current ? current : props.initialUsername!));
    }, [props.initialUsername]);

    if (props.isReady) {
        return <>{props.children}</>;
    }

    if (props.loading) {
        return (
            <ItemGroup title={t('friends.title')}>
                <SurfaceStateCard testID="friends-identity-loading" kind="loading" size="line" title={t('common.loading')} />
            </ItemGroup>
        );
    }

    const connect = props.connect;
    const connectButton = connect.kind === 'connect' ? (
        <RoundButton
            testID="friends-identity-connect"
            size="small"
            display={props.variant === 'provider' ? 'default' : 'secondary'}
            title={t('friends.providerGate.continueWith', { provider: connect.providerName })}
            accessibilityLabel={t('friends.providerGate.continueWith', { provider: connect.providerName })}
            loading={props.connectingProvider === true}
            disabled={props.connectProviderDisabled === true}
            onPress={props.onConnectProvider}
        />
    ) : null;

    if (props.variant === 'provider') {
        const provider = connect.kind === 'none' ? null : connect.providerName;
        return (
            <ItemGroup
                testID="friends-identity-provider"
                title={t('friends.title')}
                description={provider ? t('friends.providerGate.body', { provider }) : undefined}
            >
                {connect.kind === 'notConfigured' ? (
                    <SurfaceStateCard
                        testID="friends-identity-provider-unavailable"
                        kind="unavailable"
                        size="line"
                        title={t('friends.providerGate.notConfigured', { provider: connect.providerName })}
                    />
                ) : connectButton ? (
                    <SectionContentRow><View style={styles.actions}>{connectButton}</View></SectionContentRow>
                ) : null}
            </ItemGroup>
        );
    }

    const save = () => props.onSaveUsername?.(username);
    return (
        <ItemGroup
            testID="friends-identity-username"
            title={t('friends.usernameClaimTitle')}
            description={props.usernameHint ?? t('friends.usernameClaimDescription')}
        >
            {props.approvalNotice}
            <SectionContentRow>
                <AccountUsernameField
                    testID="friends-username-field"
                    value={username}
                    onChangeText={setUsername}
                    currentUsername={null}
                    check={null}
                    error={props.usernameError}
                    editable={props.savingUsername !== true}
                    onSubmitEditing={save}
                />
            </SectionContentRow>
            <SectionContentRow>
                <View style={styles.actions}>
                    {connectButton}
                    <RoundButton
                        testID="friends-username-save"
                        size="small"
                        title={t('common.save')}
                        accessibilityLabel={t('common.save')}
                        loading={props.savingUsername === true}
                        disabled={props.saveUsernameDisabled === true || username.trim().length === 0}
                        onPress={save}
                    />
                </View>
            </SectionContentRow>
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The section's operations close it on its trailing edge, as the Account profile editor's do.
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
    },
}));

export function RequireFriendsIdentityForFriends(props: { children: React.ReactNode }) {
    const auth = useAuth();
    const activeServer = useActiveServerSnapshot();
    const profileExecution = useMountedActionExecution(activeServer.serverId);
    const router = useRouter();
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

    const [usernameError, setUsernameError] = React.useState<string | null>(null);
    const onSaveUsername = React.useCallback(async (username: string) => {
        if (!auth.credentials) return;
        const trimmed = username.trim();
        if (!trimmed) return;
        setUsernameError(null);
        if (isMountedRef.current) setSavingUsername(true);
        try {
            await setAccountUsername(auth.credentials, trimmed, profileExecution);
        } catch (e) {
            const code = e instanceof HappyError ? e.message : null;
            const message =
                code === 'username-taken' ? t('friends.username.taken')
                    : code === 'invalid-username' ? t('friends.username.invalid')
                        : code === 'username-disabled' ? t('friends.username.disabled')
                            : code === 'friends-disabled' ? t('friends.disabled')
                                : t('errors.operationFailed');
            if (isMountedRef.current) setUsernameError(message);
        } finally {
            if (isMountedRef.current) setSavingUsername(false);
        }
    }, [auth.credentials, profileExecution.execute]);

    const connect = resolveFriendsIdentityConnectOption({
        gateVariant: gate.gateVariant,
        requiredProviderId,
        requiredProviderName: friendsIdentityReadiness.requiredProviderDisplayName,
        providerConnected: friendsIdentityReadiness.requiredProviderConnected,
        providerConfigured: requiredProviderId ? oauthSupported : null,
    });

    return (
        <RequireFriendsIdentityForFriendsBase
            variant={gate.gateVariant}
            isReady={gate.isReady}
            loading={friendsIdentityReadiness.isLoadingFeatures}
            connect={connect}
            initialUsername={gate.initialUsername}
            usernameHint={gate.usernameHint ? translateUsernameHint(gate.usernameHint) : undefined}
            usernameError={usernameError}
            onConnectProvider={() => void onConnectProvider()}
            connectingProvider={connectingProvider}
            connectProviderDisabled={!auth.credentials}
            onSaveUsername={(u) => void onSaveUsername(u)}
            savingUsername={savingUsername && !profileExecution.approval.approvalPending}
            saveUsernameDisabled={savingUsername || !profileExecution.ready}
            approvalNotice={profileExecution.approval.approvalPending && profileExecution.approval.approvalId && profileExecution.binding ? (
                <ActionApprovalPendingNotice
                    testID="friends-username-approval-pending"
                    message={t('approvals.waitingForYou')}
                    summary={profileExecution.approval.approvalSummary}
                    onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(profileExecution.approval.approvalId!)}?serverId=${encodeURIComponent(profileExecution.binding!.scope.serverId)}`)}
                />
            ) : null}
        >
            {props.children}
        </RequireFriendsIdentityForFriendsBase>
    );
}
