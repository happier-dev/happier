import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { identitySettingAtRoute, identitySettingParam, identitySettingTeamAddress, identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationIdentityConnectionPath, homeAdministrationWorkosSetupPath } from '@/components/settings/home/governance/homeAdministrationRoutes';

import { teamAuthenticationPath, teamIdentityConnectionPath, teamIdentityProviderSetupPath } from '../teamsRoutes';

export const TEAM_AUTHENTICATION_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: {
        id: 'authentication',
        titleKey: 'teams.tabs.authentication',
        route: (context) => {
            const address = identitySettingTeamAddress(context);
            return address ? teamAuthenticationPath(address) : null;
        },
    },
    sections: {
        admission: { titleKey: 'teams.authentication.policy.admissionSection', settings: {
            admissionInviteOnly: {},
            admissionProvisioned: {},
            admissionJit: {},
        } },
        accepted: { titleKey: 'teams.authentication.policy.acceptedSection', settings: {
            acceptedInherit: {},
            acceptedRestricted: {},
            acceptedMethods: {},
            save: {},
        } },
        connections: { settings: {
            connections: {},
            eligibleProviders: {},
            githubApps: {},
            addGitHubApp: {},
        } },
        directory: { settings: {
            directory: {},
        } },
    },
});

const IDENTITY_CONNECTION_SECTIONS = {
        configuration: { titleKey: 'teams.authentication.detail.configuration', settings: {
            allowedUsers: {},
            allowedDomains: {},
            groupsAny: {},
            groupsAll: {},
            organization: {},
            save: {},
            workosConnection: {},
        } },
        groupMappings: { titleKey: 'identityAdministration.directoryGroups', settings: {
            groupMappings: {},
            externalGroupId: {},
            mapCreate: {},
            mapExisting: {},
        } },
        actions: { titleKey: 'identityAdministration.actions', settings: {
            edit: {},
            test: {},
            enable: {},
            disable: {},
            workosSetupSso: {},
            workosSetupDirectory: {},
            workosCheckSetup: {},
            remove: {},
        } },
};
export const TEAM_IDENTITY_CONNECTION_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: {
        id: 'identityConnection',
        titleKey: 'teams.authentication.detail.connection',
        route: (context) => {
            const address = identitySettingTeamAddress(context);
            const connectionId = identitySettingParam(context, 'connectionId');
            return address && connectionId ? identitySettingAtRoute(context, teamIdentityConnectionPath(address, connectionId)) : null;
        },
    },
    sections: IDENTITY_CONNECTION_SECTIONS,
});

export const HOME_IDENTITY_CONNECTION_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'identityConnection',
        titleKey: 'teams.authentication.detail.connection',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            const connectionId = identitySettingParam(context, 'connectionId');
            return serverId && connectionId ? identitySettingAtRoute(context, homeAdministrationIdentityConnectionPath(serverId, connectionId)) : null;
        },
    },
    sections: {
        configuration: { titleKey: 'teams.authentication.detail.configuration', settings: { workosConnection: {} } },
        actions: { titleKey: 'identityAdministration.actions', settings: {
            test: {}, enable: {}, disable: {}, workosSetupSso: {}, workosCheckSetup: {}, remove: {},
        } },
    },
});

const WORKOS_SETUP_SECTIONS = {
    configuration: { settings: { companyName: {}, create: {} } },
};

export const TEAM_WORKOS_SETUP_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: {
        id: 'workosSetup', titleKey: 'identityAdministration.homeWorkosAdd',
        route: (context) => {
            const address = identitySettingTeamAddress(context);
            return address && identitySettingParam(context, 'kind') === 'workos_sso'
                ? identitySettingAtRoute(context, teamIdentityProviderSetupPath(address, 'workos_sso')) : null;
        },
    },
    sections: WORKOS_SETUP_SECTIONS,
});

export const HOME_WORKOS_SETUP_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'workosSetup', titleKey: 'identityAdministration.homeWorkosAdd',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? identitySettingAtRoute(context, homeAdministrationWorkosSetupPath(serverId)) : null;
        },
    },
    sections: WORKOS_SETUP_SECTIONS,
});
