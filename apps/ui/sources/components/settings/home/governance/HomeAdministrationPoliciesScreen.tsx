import * as React from 'react';

import { SettingSection } from '@/components/settings/shell/SettingRow';
import { t } from '@/text';

import { HomeAdministrationSection } from './HomeAdministrationSection';
import { SignInPolicyEditor } from './HomeSignInPolicySections';
import { HOME_AUTHENTICATION_SETTINGS } from './homeAuthenticationSettings';
import type { HomeAdministrationContext } from './homeAdministrationContext';

/**
 * How people sign in and join this Home: methods, Account modes, the recommended mode and admission.
 * Identity providers, GitHub Apps, private endpoints and Team sign-in rules live on the Sign-in
 * providers page; this page only turns a provider's sign-in method on or off.
 */
export const HomeAuthenticationPolicySections = React.memo(function HomeAuthenticationPolicySections(
    props: Readonly<{ context: HomeAdministrationContext }>,
) {
    return <SignInPolicyEditor context={props.context} />;
});

export const HomeAdministrationPoliciesScreen = React.memo(function HomeAdministrationPoliciesScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection serverId={props.serverId} title={t('homeGovernance.policies')} description={t('homeGovernance.pages.policies')}>
            {(context) => (
                <>
                    {/* Sign-in methods and admission, then encryption; Team creation lives on Teams (DR-09). */}
                    {/* Owners edit sign-in and encryption; admins read them (plan I4), so the page stays one page. */}
                    <SettingSection section={HOME_AUTHENTICATION_SETTINGS.sectionRefs.authentication}>
                        <HomeAuthenticationPolicySections context={context} />
                    </SettingSection>
                </>
            )}
        </HomeAdministrationSection>
    );
});
