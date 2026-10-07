import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';

import { homeAdministrationReachPath } from './homeAdministrationRoutes';

/** How a Home is reached (plan §3.2): its addresses, the host's access method and direct connections. */
export const HOME_REACH_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'reach',
        titleKey: 'homeGovernance.reach.title',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationReachPath(serverId) : null;
        },
    },
    sections: {
        addresses: { titleKey: 'homeGovernance.reach.addresses', settings: {
            publicAddress: { titleKey: 'homeGovernance.reach.publicAddress', keywordKeys: ['homeGovernance.reach.methodTailscaleServe'] },
            webAppAddress: { titleKey: 'homeGovernance.reach.webAppAddress' },
            accessMethod: { titleKey: 'homeGovernance.reach.accessMethod', keywordKeys: ['homeGovernance.reach.methodCloudflare', 'homeGovernance.reach.methodTailscaleFunnel'] },
        } },
        directConnections: { titleKey: 'homeGovernance.reach.directConnections', settings: {
            directConnections: { titleKey: 'homeGovernance.reach.directConnectionsRow' },
            relay: { titleKey: 'homeGovernance.reach.relay' },
        } },
    },
});

/**
 * The registry keys the Reach page edits itself; Server settings leaves them to it (plan §3.14:
 * a bespoke page owns its rows, the registry-rendered page takes everything else).
 */
export const HOME_REACH_PAGE_SETTING_KEYS: ReadonlySet<string> = new Set([
    SERVER_CONFIG.HAPPIER_PUBLIC_SERVER_URL.key,
    SERVER_CONFIG.HAPPIER_WEBAPP_URL.key,
    SERVER_CONFIG.HAPPIER_HOME_IROH_MODE.key,
    SERVER_CONFIG.HAPPIER_IROH_RELAY_POLICY.key,
    SERVER_CONFIG.HAPPIER_IROH_RELAY_URLS.key,
]);
