import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { identityAdministrationFailureMessage } from '@/components/settings/identity/identityAdministrationFailure';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import type { ManagedGitHubAppSurface } from './managedGitHubAppSurface';
import { Icon } from '@/components/ui/icons/Icon';

const ORIGIN_NOT_APPROVED = 'github_enterprise_origin_not_approved';

/**
 * Form checks the GitHub App screens decide before any request. They travel as
 * codes like every other failure so one presenter words them; a translated
 * sentence stored as the failure fell through the classifier as an unknown code
 * and read as "Nothing was changed".
 */
export const GITHUB_APP_FIELDS_REQUIRED = 'github_app_fields_required';
export const GITHUB_MANIFEST_FIELDS_REQUIRED = 'github_manifest_fields_required';
export const GITHUB_INSTALLATION_ID_REQUIRED = 'github_installation_id_required';
export const GITHUB_ORGANIZATION_ID_REQUIRED = 'github_organization_id_required';
export const GITHUB_INSTALLATION_IDS_REQUIRED = 'github_installation_ids_required';

const FORM_FAILURE_MESSAGES: ReadonlyMap<string, () => string> = new Map([
    [GITHUB_APP_FIELDS_REQUIRED, () => t('identityAdministration.githubRequired')],
    [GITHUB_MANIFEST_FIELDS_REQUIRED, () => t('identityAdministration.required')],
    [GITHUB_INSTALLATION_ID_REQUIRED, () => t('identityAdministration.githubInstallationIdRequired')],
    [GITHUB_ORGANIZATION_ID_REQUIRED, () => t('identityAdministration.githubOrganizationIdRequired')],
    [GITHUB_INSTALLATION_IDS_REQUIRED, () => t('identityAdministration.githubInstallationIdsRequired')],
]);

/**
 * The GitHub App surface adds the explanations the shared identity classifier
 * cannot give — its own form checks and an origin this Home has not approved —
 * and defers every other code to it.
 *
 * Falling back to the raw code, as this did, put a server enum in front of an
 * administrator for any outcome the GitHub screens had not enumerated; the
 * shared owner already answers those in the person's language.
 */
export function managedGitHubAppFailureMessage(code: string): string {
    const formMessage = FORM_FAILURE_MESSAGES.get(code);
    if (formMessage) return formMessage();
    return code === ORIGIN_NOT_APPROVED
        ? t('identityAdministration.githubEnterpriseOriginNotApproved')
        : identityAdministrationFailureMessage(code);
}

/**
 * The recovery action for a Home-owned GitHub Enterprise origin refusal.
 *
 * The server remains the policy authority. This item only carries the person
 * to the existing exact-Home Policies screen; it is intentionally absent for
 * Team-owned registrations, whose Home-policy recovery is owned elsewhere.
 */
export const ManagedGitHubAppFailureRecovery = React.memo(function ManagedGitHubAppFailureRecovery(
    props: Readonly<{ code: string; surface: ManagedGitHubAppSurface }>,
) {
    const router = useRouter();
    const path = props.code === ORIGIN_NOT_APPROVED
        ? props.surface.githubEnterpriseOriginPolicyPath
        : undefined;
    if (!path) return null;
    return (
        <Item
            testID="github-enterprise-origin-policy"
            icon={<Icon name="shield-check" />}
            title={t('homeGovernance.githubEnterpriseOrigins')}
            subtitle={t('homeGovernance.policies')}
            onPress={() => router.push(path)}
        />
    );
});
