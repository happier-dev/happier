import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { identitySettingAtRoute, identitySettingParam, identitySettingTeamAddress } from '@/components/settings/identity/identitySettingsRoutes';

import { teamDirectoryPath, teamDirectorySourcePath } from '../teamsRoutes';

export const DIRECTORY_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: {
        id: 'directory',
        titleKey: 'teams.authentication.directory.title',
        route: (context) => {
            const address = identitySettingTeamAddress(context);
            return address ? teamDirectoryPath(address) : null;
        },
    },
    sections: {
        actions: { settings: {
            addSource: {},
            workosSetup: {},
        } },
    },
});

export const DIRECTORY_SOURCE_SETTINGS = defineSettingsPage({
    pageId: 'teams',
    subpage: {
        id: 'directorySource',
        titleKey: 'teams.authentication.directory.title',
        route: (context) => {
            const address = identitySettingTeamAddress(context);
            const sourceId = identitySettingParam(context, 'sourceId');
            return address && sourceId ? identitySettingAtRoute(context, teamDirectorySourcePath(address, sourceId)) : null;
        },
    },
    sections: {
        actions: { titleKey: 'teams.authentication.directory.actions.section', settings: {
            syncNow: {},
            pause: {},
            resume: {},
            remove: {},
            workosSetup: {},
        } },
        groups: { titleKey: 'identityAdministration.directoryGroups', settings: {
            searchGroups: {},
        } },
    },
});
