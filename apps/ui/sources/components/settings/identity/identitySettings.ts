import { defineSettingsPage, type SettingsRouteContext, type SettingsSectionDeclaration } from '@/components/settings/catalog/settingDeclarations';
import {
    homeAdministrationGitHubAppCreatePath,
    homeAdministrationGitHubAppEditPath,
    homeAdministrationGitHubAppPath,
    homeAdministrationIdentityProviderCreatePath,
    homeAdministrationIdentityProviderEditPath,
    homeAdministrationIdentityProviderPath,
} from '@/components/settings/home/governance/homeAdministrationRoutes';
import { teamGitHubAppEditPath, teamGitHubAppPath, teamIdentityConnectionProviderEditPath, teamIdentityProviderSetupPath } from '@/components/settings/teams/teamsRoutes';

import { identitySettingAtRoute, identitySettingHomeId, identitySettingParam, identitySettingTeamAddress } from './identitySettingsRoutes';

function homeOidcEditor(context: SettingsRouteContext): string | null {
    const serverId = identitySettingHomeId(context);
    if (!serverId) return null;
    const create = identitySettingAtRoute(context, homeAdministrationIdentityProviderCreatePath(serverId));
    if (create) return create;
    const providerId = identitySettingParam(context, 'providerId');
    return providerId ? identitySettingAtRoute(context, homeAdministrationIdentityProviderEditPath(serverId, providerId)) : null;
}

function teamOidcEditor(context: SettingsRouteContext): string | null {
    const address = identitySettingTeamAddress(context);
    if (!address) return null;
    const kind = identitySettingParam(context, 'kind');
    if (context.params.kind === undefined || kind === 'oidc') {
        const create = identitySettingAtRoute(context, teamIdentityProviderSetupPath(address, 'oidc'));
        if (create) return create;
    }
    const connectionId = identitySettingParam(context, 'connectionId');
    const providerId = identitySettingParam(context, 'providerId');
    return connectionId && providerId
        ? identitySettingAtRoute(context, teamIdentityConnectionProviderEditPath(address, connectionId, providerId))
        : null;
}

const oidcSections = {
    configuration: {
        titleKey: 'identityAdministration.configuration',
        settings: {
            displayName: {},
            issuer: {},
            clientId: {},
            clientSecret: {},
            callbackUrl: {},
        },
    },
    advanced: {
        titleKey: 'identityAdministration.advanced',
        settings: {
            scopes: {},
            loginClaim: {},
            emailClaim: {},
            groupsClaim: {},
            fetchUserInfo: {},
            clientAuthenticationMethod: {},
            usersAllowlist: {},
            emailDomains: {},
            groupsAny: {},
            groupsAll: {},
            storeRefreshToken: {},
            buttonColor: {},
            iconHint: {},
        },
    },
    actions: {
        titleKey: 'identityAdministration.actions',
        settings: {
            validate: {},
            save: {},
        },
    },
} as const satisfies Record<string, SettingsSectionDeclaration>;

export const HOME_MANAGED_OIDC_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: { id: 'oidc', route: homeOidcEditor, titleKey: 'identityAdministration.configuration' },
    sections: oidcSections,
});
export const TEAM_MANAGED_OIDC_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: { id: 'oidc', route: teamOidcEditor, titleKey: 'identityAdministration.configuration' },
    sections: oidcSections,
});

export const HOME_IDENTITY_PROVIDER_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'identityProvider',
        titleKey: 'identityAdministration.configuration',
        route: (context: SettingsRouteContext) => {
            const serverId = identitySettingHomeId(context);
            const providerId = identitySettingParam(context, 'providerId');
            return serverId && providerId
                ? identitySettingAtRoute(context, homeAdministrationIdentityProviderPath(serverId, providerId))
                : null;
        },
    },
    sections: {
        configuration: { titleKey: 'identityAdministration.configuration', settings: {
            callbackUrl: {},
            issuer: {},
            clientId: {},
            clientSecret: {},
            secretRepair: {},
        } },
        consumers: { titleKey: 'identityAdministration.teamConsumers', settings: {
            teamConsumers: {},
        } },
        actions: { titleKey: 'identityAdministration.actions', settings: {
            test: {},
            edit: {},
            enable: {},
            disable: {},
            remove: {},
        } },
    },
});

function homeGitHubApp(context: SettingsRouteContext, editor: boolean): string | null {
    const serverId = identitySettingHomeId(context);
    if (!serverId) return null;
    if (editor) {
        const create = identitySettingAtRoute(context, homeAdministrationGitHubAppCreatePath(serverId));
        if (create) return create;
    }
    const registrationId = identitySettingParam(context, 'registrationId');
    return registrationId ? identitySettingAtRoute(context, editor
        ? homeAdministrationGitHubAppEditPath(serverId, registrationId)
        : homeAdministrationGitHubAppPath(serverId, registrationId)) : null;
}

function teamGitHubApp(context: SettingsRouteContext, editor: boolean): string | null {
    const address = identitySettingTeamAddress(context);
    if (!address) return null;
    if (editor && identitySettingParam(context, 'kind') === 'github_app_identity') {
        const create = identitySettingAtRoute(context, teamIdentityProviderSetupPath(address, 'github_app_identity'));
        if (create) return create;
    }
    const registrationId = identitySettingParam(context, 'registrationId');
    return registrationId ? identitySettingAtRoute(context, editor
        ? teamGitHubAppEditPath(address, registrationId)
        : teamGitHubAppPath(address, registrationId)) : null;
}

const githubAppSections = {
    configuration: { titleKey: 'identityAdministration.configuration', settings: {
        githubHost: {},
        callbackUrl: {},
        githubAppSlug: {},
        githubOwnerLogin: {},
        githubPrivateKey: {},
        clientSecret: {},
    } },
    installations: { titleKey: 'identityAdministration.githubInstallations', settings: {
        githubInstallations: {},
        teamConsumers: {},
        remove: {},
    } },
    verification: { titleKey: 'identityAdministration.githubVerifyInstallation', settings: {
        githubInstallationId: {},
        githubOrganizationId: {},
        verify: {},
    } },
    access: { settings: {
        currentAccess: {},
        setupAccess: {},
    } },
    actions: { titleKey: 'identityAdministration.actions', settings: {
        edit: {},
        signIn: {},
        directory: {},
    } },
} as const satisfies Record<string, SettingsSectionDeclaration>;

export const HOME_GITHUB_APP_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: { id: 'githubApp', route: (context) => homeGitHubApp(context, false), titleKey: 'identityAdministration.githubAppEditTitle' },
    sections: githubAppSections,
});
export const TEAM_GITHUB_APP_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: { id: 'githubApp', route: (context) => teamGitHubApp(context, false), titleKey: 'identityAdministration.githubAppEditTitle' },
    sections: githubAppSections,
});

const githubEditorSections = {
    configuration: { titleKey: 'identityAdministration.configuration', settings: {
        githubHost: {},
        githubAppId: {},
        githubClientId: {},
        githubAppSlug: {},
        githubOwnerLogin: {},
        clientSecret: {},
        privateKey: {},
        webhookSecret: {},
        callbackUrl: {},
    } },
    setup: { settings: {
        manifestAppName: {},
        manifestForOrganization: {},
        manifestOrganization: {},
        manifestSetup: {},
        manualSetup: {},
    } },
    actions: { titleKey: 'identityAdministration.actions', settings: {
        save: {},
    } },
} as const satisfies Record<string, SettingsSectionDeclaration>;

export const HOME_GITHUB_APP_EDITOR_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: { id: 'githubAppEditor', route: (context) => homeGitHubApp(context, true), titleKey: 'identityAdministration.githubAppEditTitle' },
    sections: githubEditorSections,
});
export const TEAM_GITHUB_APP_EDITOR_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: { id: 'githubAppEditor', route: (context) => teamGitHubApp(context, true), titleKey: 'identityAdministration.githubAppEditTitle' },
    sections: githubEditorSections,
});
