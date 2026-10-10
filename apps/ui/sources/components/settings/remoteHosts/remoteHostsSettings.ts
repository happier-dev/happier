import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** The searchable settings of the `remoteHosts` page. Rows render their labels from these declarations. */
export const REMOTE_HOSTS_SETTINGS = defineSettingsPage({
    pageId: 'remoteHosts',
    sections: {
        savedHosts: {
            titleKey: 'settingsRemoteHostsPage.savedHostsSection',
            settings: {
                addHost: {},
            },
        },
    },
});

/** Remote hosts › Keys and connections: what this device trusts and has open, across hosts. */
export const REMOTE_HOSTS_ACCESS_SETTINGS = defineSettingsPage({
    pageId: 'remoteHosts',
    subpage: { id: 'access', route: SETTINGS_ROUTES.remoteHostsAccess, titleKey: 'settingsRemoteHostsPage.accessTitle' },
    sections: {
        trustedHostKeys: {
            titleKey: 'settings.remoteHostsTrustedHostKeysTitle',
            settings: {
                clearTrustedHostKeys: {},
            },
        },
    },
});
