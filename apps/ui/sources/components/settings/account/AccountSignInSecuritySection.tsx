import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { ProviderIdentityItems } from '@/components/account/ProviderIdentityItems';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SkeletonTitle } from '@/components/ui/lists/SkeletonRows';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import type { Profile } from '@/sync/domains/profiles/profile';
import { t } from '@/text';

import { ACCOUNT_SETTINGS } from './accountSettings';
import type { AccountSecurityProjectionState } from './useAccountSecurityProjection';
import { AccountRecoveryKeyItem } from './AccountRecoveryKeyItem';

function describeEmailPassword(security: AccountSecurityProjectionState): string | null {
    // While the facts load the row keeps its title and action; it never prints "Loading…".
    if (security.kind === 'loading') return null;
    if (security.kind === 'unavailable') return t('settingsAccount.emailPasswordManageHint');
    const { nativeEmail, password } = security.projection;
    const enrolled = password.status === 'enrolled';
    if (nativeEmail) {
        return enrolled
            ? t('settingsAccount.emailPasswordWithPassword', { email: nativeEmail })
            : t('settingsAccount.emailPasswordWithoutPassword', { email: nativeEmail });
    }
    return enrolled ? t('settingsAccount.passwordOnly') : t('settingsAccount.emailPasswordNotSetUp');
}

/**
 * How you sign in to the current Home: the sign-in methods first, each with its own action, then the
 * rarer controls behind "More security". Deep flows (password and email forms, encryption) stay on the
 * security screen; this section links there rather than reproducing them.
 */
export const AccountSignInSecuritySection = React.memo(function AccountSignInSecuritySection(props: Readonly<{
    homeName: string;
    security: AccountSecurityProjectionState;
    profile: Profile;
    credentials: AuthCredentials | null;
    applyProfile: (profile: Profile) => void;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const encryptionControlsEnabled = useFeatureEnabled('encryption.accountOptOut');
    const [moreExpanded, setMoreExpanded] = React.useState(false);
    const projection = props.security.kind === 'ready' ? props.security.projection : null;
    const rowMetrics = usePageRowMetrics();
    const emailPasswordFacts = describeEmailPassword(props.security);
    const openSecurity = React.useCallback(() => router.push(SETTINGS_ROUTES.accountSecurity), [router]);

    return (
        <ItemGroup
            title={t('settingsAccount.security')}
            description={t('settingsAccount.signInSecurityDescription', { home: props.homeName })}
        >
            <SettingRow
                setting={ACCOUNT_SETTINGS.settings.emailPassword}
                testID="settings-account-email-password"
                icon={<Icon name="envelope" size={18} color={theme.colors.text.secondary} />}
                // While its facts load, the description line is held by the quiet bar, so the row keeps the height its
                // facts will give it and nothing below moves when they land.
                subtitle={emailPasswordFacts ?? (
                    <SkeletonTitle
                        testID="settings-account-email-password-loading"
                        lineHeight={rowMetrics.subtitle.lineHeight}
                    />
                )}
                mode="info"
                showChevron={false}
                rightElementOutsidePressable
                rightElement={(
                    <RoundButton
                        testID="settings-account-email-password-manage"
                        size="small"
                        display="secondary"
                        title={t('settingsAccount.manageSignIn')}
                        onPress={openSecurity}
                    />
                )}
            />
            <ProviderIdentityItems
                profile={props.profile}
                credentials={props.credentials}
                applyProfile={props.applyProfile}
                returnTo="/settings/account"
            />
            {projection?.encryptionMode === 'e2ee' ? (
                <AccountRecoveryKeyItem recoveryEmail={projection.nativeEmail} />
            ) : props.security.kind === 'loading' ? (
                // Holds the row's place until the Account's encryption mode is known, so it never
                // inserts itself above the rows below.
                <ItemLoadStateRows
                    testID="settings-account-recovery-key-loading"
                    state={{ kind: 'loading' }}
                    rows={1}
                    accessibilityLabel={t('settingsAccount.secretKey')}
                />
            ) : null}
            <ExpandableItem
                testID="settings-account-more-security"
                expanded={moreExpanded}
                onExpandedChange={setMoreExpanded}
                header={({ headerProps }) => (
                    <Item
                        {...headerProps}
                        icon={<Icon name="shield-check" />}
                        title={t('settingsAccount.moreSecurity')}
                        // What it opens is a description, not a value: it reads under the name at every width, so a
                        // phone never draws it beside the name first and moves it beneath once the row has measured it.
                        subtitle={t('settingsAccount.moreSecuritySummary')}
                    />
                )}
            >
                <Item
                    testID="settings-account-api-tokens"
                    icon={<Icon name="code" />}
                    title={t('settingsApiTokens.title')}
                    subtitle={t('settingsApiTokens.entrySubtitle')}
                    onPress={() => router.push(SETTINGS_ROUTES.apiTokens)}
                />
                <Item
                    testID="settings-account-encryption"
                    icon={<Icon name="lock" />}
                    title={t('terminal.encryption')}
                    subtitle={projection
                        ? t(projection.encryptionMode === 'e2ee' ? 'settingsAccount.endToEndEncrypted' : 'settingsAccount.notEndToEndEncrypted')
                        : undefined}
                    mode={encryptionControlsEnabled ? 'interactive' : 'info'}
                    onPress={encryptionControlsEnabled ? openSecurity : undefined}
                    showChevron={encryptionControlsEnabled}
                />
                <Item
                    testID="settings-catalog-page-item.accountSecurity"
                    icon={<Icon name="shield-check" />}
                    title={t('settingsAccount.allSecuritySettings')}
                    onPress={openSecurity}
                    showDivider={false}
                />
            </ExpandableItem>
        </ItemGroup>
    );
});
