import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationEmailPath } from './homeAdministrationRoutes';

/** How a Home sends mail: its SMTP server, sender and test send. Never a value, only the fields. */
export const HOME_EMAIL_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'email',
        titleKey: 'homeGovernance.email.title',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationEmailPath(serverId) : null;
        },
    },
    sections: {
        mailServer: { titleKey: 'homeGovernance.email.mailServer', settings: {
            host: {},
            port: {},
            username: {},
            password: {},
        } },
        sender: { titleKey: 'homeGovernance.email.sender', settings: {
            fromAddress: {},
            fromName: {},
        } },
        test: { titleKey: 'homeGovernance.email.test', settings: {
            sendTest: {},
        } },
    },
});
