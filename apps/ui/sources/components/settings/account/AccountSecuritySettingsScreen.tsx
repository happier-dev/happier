import React from 'react';
import type { Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useAuth } from '@/auth/context/AuthContext';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { UnboundSessionHomeScopeCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { SettingsCatalogPageChildren } from '@/components/settings/SettingsCatalogOverviewGroup';
import { t } from '@/text';
import { AccountEmailPasswordSection } from './AccountEmailPasswordSection';
import { AccountEncryptionSettingsSection } from './AccountEncryptionSettingsSection';
import { AccountSessionSecuritySection } from './AccountSessionSecuritySection';
import { createAccountSecurityActionClient } from './accountSecurityActionClient';
import { useRecoveryKeyDisclosure } from './useRecoveryKeyDisclosure';
import { accountSecurityProjectionScopeKey } from './accountSecurityProjectionStore';
import { useScopedAccountSecurityProjection } from './useAccountSecurityProjection';
import { useProfile } from '@/sync/domains/state/storage';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingRow, SettingSection } from '@/components/settings/shell/SettingRow';
import { ACCOUNT_SECURITY_SETTINGS } from './accountSecuritySettings';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { parseToken } from '@/utils/auth/parseToken';
import {
    ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT,
    openAccountSecurityForHome,
} from './openAccountSecurityForHome';
import { Icon } from '@/components/ui/icons/Icon';

export const AccountSecuritySettingsScreen = React.memo(function AccountSecuritySettingsScreen() {
    const auth = useAuth();
    const router = useRouter();
    const params = useLocalSearchParams<{
        verificationToken?: string | string[];
        serverId?: string | string[];
        intent?: string | string[];
    }>();
    const verificationToken = Array.isArray(params.verificationToken)
        ? params.verificationToken[0] ?? null
        : params.verificationToken ?? null;
    const routeServerId = Array.isArray(params.serverId)
        ? params.serverId[0] ?? null
        : params.serverId ?? null;
    const routeIntent = Array.isArray(params.intent)
        ? params.intent[0] ?? null
        : params.intent ?? null;
    const connectIntent = routeIntent === ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT;
    const activeServer = useActiveServerSnapshot();
    const routeTargetsActiveHome = routeServerId === null
        || areServerProfileIdentifiersEquivalent(routeServerId, activeServer.serverId);
    const targetAccountScope = useServerCredentialAccountScopeResolution(
        routeServerId ?? activeServer.serverId,
    );
    const authenticatedAccountId = auth.credentials ? parseToken(auth.credentials.token) : null;
    const routeTargetsActiveAccount = targetAccountScope.kind === 'bound'
        && targetAccountScope.scope.accountId === authenticatedAccountId;
    const securityClient = React.useMemo(() => createAccountSecurityActionClient({
        resolveServerId: () => routeServerId ?? activeServer.serverId,
    }), [activeServer.serverId, routeServerId]);
    // One reader owns this projection: the mounted email/password section
    // publishes what it already read, so this route never issues a competing
    // Account Security request or drifts from the section's retry state.
    const profile = useProfile();
    const securityAccountId = authenticatedAccountId ?? profile.id;
    // Begin from the last projection read for this Account and Home (the Account overview's), so the
    // recovery-key row does not arrive after first paint and push the page.
    const { state: projectionState, publishProjection } = useScopedAccountSecurityProjection(
        auth.credentials
            ? accountSecurityProjectionScopeKey(activeServer.serverId, securityAccountId)
            : null,
    );
    const projection = projectionState.kind === 'ready' ? projectionState.projection : null;
    const recoveryEmail = projection?.password.status === 'enrolled' ? projection.nativeEmail : null;
    const recoveryApplicable = projection?.encryptionMode === 'e2ee';
    const targetServerId = routeServerId ?? activeServer.serverId;
    const targetKey = `${targetServerId}\u0000${routeIntent ?? ''}\u0000${verificationToken ?? ''}`;
    const [switchAttempt, setSwitchAttempt] = React.useState(0);
    const [switchState, setSwitchState] = React.useState<Readonly<{
        targetKey: string | null;
        status: 'switching' | 'failed';
    }>>({ targetKey: null, status: 'switching' });

    React.useEffect(() => {
        if (routeTargetsActiveHome && routeTargetsActiveAccount) return;
        // Settled credential failures already have a canonical recovery owner.
        // A Home focus handoff cannot repair absent or unreadable credentials.
        if (targetAccountScope.kind !== 'bound' && targetAccountScope.kind !== 'resolving') return;
        if (routeServerId === null || (routeTargetsActiveHome && targetAccountScope.kind === 'resolving')) return;

        let current = true;
        setSwitchState((currentState) => (
            currentState.targetKey === targetKey && currentState.status === 'switching'
                ? currentState
                : { targetKey, status: 'switching' }
        ));
        void openAccountSecurityForHome({
            serverId: targetServerId,
            router,
            refreshAuth: auth.refreshFromActiveServer,
            ...(connectIntent ? { intent: ACCOUNT_SECURITY_EMAIL_PASSWORD_CONNECT_INTENT } : {}),
            ...(verificationToken ? { verificationToken } : {}),
        }).then((opened) => {
            if (current && !opened) setSwitchState({ targetKey, status: 'failed' });
        }).catch(() => {
            if (current) setSwitchState({ targetKey, status: 'failed' });
        });
        return () => { current = false; };
    }, [auth.refreshFromActiveServer, connectIntent, routeServerId, routeTargetsActiveAccount, routeTargetsActiveHome, router, switchAttempt, targetAccountScope.kind, targetKey, targetServerId, verificationToken]);

    const retryExactHome = React.useCallback(() => {
        setSwitchState({ targetKey, status: 'switching' });
        setSwitchAttempt((attempt) => attempt + 1);
    }, [targetKey]);

    const recoveryKeyTriggerRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);
    const { canDisclose, open: openRecoveryKey } = useRecoveryKeyDisclosure(recoveryEmail, recoveryKeyTriggerRef);
    const [connectRequest, setConnectRequest] = React.useState<Readonly<{ accountId: string; serverId: string; count: number }> | null>(null);
    const openPasswordEnrollment = React.useCallback(() => {
        if (!securityAccountId) return;
        setConnectRequest((previous) => ({ accountId: securityAccountId, serverId: targetServerId, count: (previous?.count ?? 0) + 1 }));
    }, [securityAccountId, targetServerId]);

    if (targetAccountScope.kind !== 'bound' && targetAccountScope.kind !== 'resolving') {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <SettingsPageHeader description={t('settingsAccount.securityPageDescription')} />
                <UnboundSessionHomeScopeCard
                    resolution={targetAccountScope}
                    serverId={targetServerId}
                    testIDPrefix="settings-account-security"
                />
            </ItemList>
        );
    }

    // A mailbox bearer addressed to Home A must never reach Home B while the
    // explicit focus handoff is still publishing. Mounting no Account Security
    // consumers here also aborts the previous Home's scoped preparation work.
    if (!routeTargetsActiveHome || !routeTargetsActiveAccount) {
        const currentSwitchStatus = switchState.targetKey === targetKey
            ? switchState.status
            : 'switching';
        if (currentSwitchStatus === 'failed') {
            return (
                <SurfaceStateCard
                    testID="settings-account-security-home-switch-failed"
                    kind="unavailable"
                    title={t('errors.operationFailed')}
                    reason={t('settingsAccount.accountServiceDiscoveryUnavailableDescription')}
                    action={{ label: t('common.retry'), onPress: retryExactHome }}
                    secondaryAction={{ label: t('common.back'), onPress: router.back }}
                    accessibilitySemantics="alert"
                />
            );
        }
        // The page keeps its header and reserves its rows while the Home switch lands.
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <SettingsPageHeader description={t('settingsAccount.securityPageDescription')} />
                <ItemGroup>
                    <ItemLoadStateRows
                        testID="settings-account-security-home-switching"
                        state={{ kind: 'loading' }}
                        rows={3}
                        accessibilityLabel={t('settingsAccount.securityPageDescription')}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SettingsPageHeader description={t('settingsAccount.securityPageDescription')} />
            {/* While sign-in facts are unavailable the section's own state row answers for its rows. */}
            <SettingSection section={ACCOUNT_SECURITY_SETTINGS.sectionRefs.emailPassword}>
                <AccountEmailPasswordSection
                    client={securityClient}
                    accountId={securityAccountId}
                    verificationToken={verificationToken}
                    connectIntent={connectIntent}
                    connectRequest={connectRequest?.accountId === securityAccountId && connectRequest.serverId === targetServerId
                        ? connectRequest.count : undefined}
                    onProjection={publishProjection}
                />
            </SettingSection>
            {/* A plaintext Account has no recovery key; its Backup section says so rather than vanishing. */}
            <SettingSection section={ACCOUNT_SECURITY_SETTINGS.sectionRefs.backup}>
            {recoveryApplicable ? (
                <ItemGroup title={t('settingsAccount.backup')}>
                    <SettingRow
                        setting={ACCOUNT_SECURITY_SETTINGS.settings.recoveryKey}
                        testID="settings-account-recovery-key"
                        icon={<Icon name="key" />}
                        pressableRef={recoveryKeyTriggerRef}
                        subtitle={canDisclose ? undefined : t('settingsAccount.nativePassword.recoveryKeyOffDevice')}
                        detail={canDisclose ? undefined : t('settingsAccount.nativePassword.addPassword')}
                        onPress={canDisclose ? openRecoveryKey : openPasswordEnrollment}
                    />
                </ItemGroup>
            ) : projectionState.kind === 'loading' ? (
                <ItemGroup title={t('settingsAccount.backup')}>
                    <ItemLoadStateRows
                        testID="settings-account-recovery-key-loading"
                        state={{ kind: 'loading' }}
                        rows={1}
                        accessibilityLabel={t('settingsAccount.secretKey')}
                    />
                </ItemGroup>
            ) : projectionState.kind !== 'ready' ? (
                <ItemGroup title={t('settingsAccount.backup')}>
                    <Item
                        testID="settings-account-recovery-key-unavailable"
                        title={t('settingsAccount.secretKey')}
                        // Its own fact: the sign-in section above carries the one Retry for this read.
                        subtitle={t('settingsAccount.nativePassword.securityFactUnavailable')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : (
                <ItemGroup title={t('settingsAccount.backup')}>
                    <Item
                        testID="settings-account-recovery-key-not-applicable"
                        title={t('settingsAccount.secretKey')}
                        subtitle={t('settingsAccount.notEndToEndEncrypted')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            )}
            </SettingSection>
            <SettingsCatalogPageChildren
                parentPageId="accountSecurity"
                title={t('settingsAccount.apiAccessSectionTitle')}
                router={router}
            />
            <AccountEncryptionSettingsSection />
            {/* Leaving closes the page. */}
            <AccountSessionSecuritySection />
        </ItemList>
    );
});
