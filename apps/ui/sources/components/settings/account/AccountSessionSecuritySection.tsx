import React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useAuth } from '@/auth/context/AuthContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { ACCOUNT_SECURITY_SETTINGS } from './accountSecuritySettings';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createApiTokenSettingsController } from '@/components/settings/apiTokens/apiTokenSettingsController';
import { useApiTokenSettingsControllerState } from '@/components/settings/apiTokens/useApiTokenSettingsControllerState';
import { completeApiTokenSettingsSignOutEverywhere } from '@/components/settings/apiTokens/apiTokenSettingsSignOutLifecycle';
import { resolveApiTokenOperationErrorMessageKey } from '@/components/settings/apiTokens/apiTokenSettingsPresentation';
import { confirmForCapturedAccount } from '@/components/settings/apiTokens/confirmForCapturedAccount';

/**
 * Ends every signed-in session for this Account: a quiet bordered button in the page-closing row
 * (`patterns.md` → Leaving and destroying), never a red row inside a sheet.
 */
export const AccountSignOutEverywhereButton = React.memo(function AccountSignOutEverywhereButton() {
    const auth = useAuth();
    const router = useRouter();
    const [controller] = React.useState(createApiTokenSettingsController);
    const state = useApiTokenSettingsControllerState(controller);
    React.useInsertionEffect(() => () => controller.retire(), [controller]);

    const signOut = async () => {
        const target = await confirmForCapturedAccount(controller, () => Modal.confirm(
            t('settingsApiTokens.signOutEverywhere.title'),
            t('settingsApiTokens.signOutEverywhere.body'),
            { cancelText: t('common.cancel'), confirmText: t('settingsApiTokens.signOutEverywhere.confirm'), destructive: true },
        ));
        if (!target) return;
        const completed = await completeApiTokenSettingsSignOutEverywhere({
            signOutEverywhere: () => controller.signOutEverywhere(target),
            logout: auth.logout,
            replace: (path) => router.replace(path),
        });
        if (!completed && controller.getState().operationError) {
            await Modal.alertAsync(t('common.error'), t(resolveApiTokenOperationErrorMessageKey(controller.getState().operationError)));
        }
    };

    return (
        <RoundButton
            testID="settings-account-sign-out-everywhere"
            size="small"
            display="secondary"
            title={t('settingsApiTokens.signOutEverywhere.title')}
            accessibilityHint={t('settingsApiTokens.signOutEverywhere.subtitle')}
            disabled={!auth.credentials || state.operation !== null}
            loading={state.operation === 'signOutEverywhere'}
            onPress={signOut}
        />
    );
});

/** Closes the security page: its own section, so the button belongs to something; its consequence reads above it. Render it last. */
export const AccountSessionSecuritySection = React.memo(function AccountSessionSecuritySection() {
    return (
        <SettingAnchor setting={ACCOUNT_SECURITY_SETTINGS.settings.signOutEverywhere}>
            <ItemGroup surface="none" title={t('settingsAccount.sessionsSectionTitle')}
                description={t('settingsApiTokens.signOutEverywhere.subtitle')}>
                <SectionButtonRow>
                    <AccountSignOutEverywhereButton />
                </SectionButtonRow>
            </ItemGroup>
        </SettingAnchor>
    );
});
