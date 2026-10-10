import { builtInSettingsPageSections, defineSettingsPage, type SettingDeclaration } from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationSignInProvidersPath } from '../governance/homeAdministrationRoutes';

/** Every Home-editable registry key a Sign-in platform row renders (AM-12), found by its own name. */
function platformKeySettings(): Record<string, SettingDeclaration> {
    const sections = builtInSettingsPageSections('homeAdministration.signInProviders');
    return sections.signInPlatforms?.settings ?? {};
}

/**
 * The Sign-in providers page: the platforms the Home signs in through (GitHub sign-in, WorkOS), its
 * identity providers and GitHub Apps, where managed sign-in may reach, and what Teams may add.
 * Titles are generic translations, never a provider's own name or host.
 */
export const HOME_SIGN_IN_PROVIDERS_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'signInProviders',
        titleKey: 'homeGovernance.signInProviders.title',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationSignInProvidersPath(serverId) : null;
        },
    },
    sections: {
        signInPlatforms: { titleKey: 'homeGovernance.signInProviders.platforms', settings: {
            githubSignIn: {},
            workos: {},
            ...platformKeySettings(),
        } },
        homeConnections: { titleKey: 'identityAdministration.homeConnections', settings: {
            homeConnections: {},
            addProvider: {},
        } },
        githubApps: { titleKey: 'identityAdministration.githubApps', settings: {
            githubApps: {},
            addGitHubApp: {},
        } },
        identityNetwork: { titleKey: 'homeGovernance.privateEndpoints', settings: {
            publicOnly: {},
            privateAllowlist: {},
            hostnames: {},
            cidrs: {},
            ports: {},
            saveNetwork: {},
        } },
        teamProviders: { titleKey: 'homeGovernance.signInProviders.teamRules', settings: {
            allowedTeamProviderKinds: {},
            teamJitAllowed: {},
            approvedGitHubEnterpriseOrigins: {},
            saveOrigins: {},
        } },
    },
});
