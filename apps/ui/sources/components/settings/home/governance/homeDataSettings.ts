import {
    defineSettingsPage,
    type SettingDeclaration,
} from '@/components/settings/catalog/settingDeclarations';
import { identitySettingHomeId } from '@/components/settings/identity/identitySettingsRoutes';
import { SERVER_RETENTION_DOMAIN_METADATA } from '@/sync/domains/server/retention/serverRetentionDomainMetadata';

import { homeAdministrationDataPath } from './homeAdministrationRoutes';

const domainSettings: Record<string, SettingDeclaration> = Object.fromEntries(
    SERVER_RETENTION_DOMAIN_METADATA.map((domain) => [domain.key, { titleKey: domain.titleKey }]),
);

/** What a Home keeps and for how long: automatic deletion, its dry run and each kind of record. */
export const HOME_DATA_SETTINGS = defineSettingsPage({
    pageId: 'homeAdministration',
    subpage: {
        id: 'data',
        titleKey: 'homeGovernance.data.title',
        route: (context) => {
            const serverId = identitySettingHomeId(context);
            return serverId ? homeAdministrationDataPath(serverId) : null;
        },
    },
    sections: {
        deletion: { titleKey: 'homeGovernance.data.deletion', settings: {
            automaticDeletion: {},
            dryRunMode: {},
            dryRun: {},
        } },
        records: { titleKey: 'homeGovernance.data.deletion', settings: domainSettings },
    },
});
