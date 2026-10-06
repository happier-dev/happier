import { PROVIDER_USAGE_GAUGE_SETTINGS_SECTION } from './providerUsageGaugeSettings';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/**
 * The searchable settings of Connected services. Services and accounts are a collection (they come
 * from the user's data), so only the rows of "How agents sign in" are declared: the per-agent default
 * sign-in rows as one entry (anchored on the first agent's row) and state sharing.
 */
export const CONNECTED_SERVICES_SETTINGS = defineSettingsPage({
    pageId: 'connectedServicesAgentSignIn',
    sections: {
        usage: {
            titleKey: 'connectedServicesSettings.usageTitle',
            settings: {
                agentDefaults: {
                    titleKey: 'connectedServicesSettings.agentDefaultsTitle',
                    descriptionKey: 'connectedServicesSettings.agentDefaultsDescription',
                    keywordKeys: ['connectedServicesSettings.agentDefaultsKeywords'],
                },
                sharing: {
                    titleKey: 'connectedServicesSettings.sharingTitle',
                    descriptionKey: 'connectedServices.providerStateSharing.footer',
                },
                sharingConfig: {
                    titleKey: 'connectedServices.providerStateSharing.configTitle',
                    keywordKeys: [
                        'connectedServicesSettings.configLinkedShort',
                        'connectedServicesSettings.configCopiedShort',
                        'connectedServicesSettings.configIsolatedShort',
                    ],
                },
                sharingState: {
                    titleKey: 'connectedServices.providerStateSharing.stateTitle',
                },
                sharingPerAgent: {
                    titleKey: 'connectedServicesSettings.perAgentTitle',
                    descriptionKey: 'connectedServicesSettings.perAgentDescription',
                },
            },
        },
    },
});

/** The sharing disclosure and its rows, revealed together by settings search. */
export const CONNECTED_SERVICES_SHARING_SETTINGS = [
    CONNECTED_SERVICES_SETTINGS.settings.sharing,
    CONNECTED_SERVICES_SETTINGS.settings.sharingConfig,
    CONNECTED_SERVICES_SETTINGS.settings.sharingState,
    CONNECTED_SERVICES_SETTINGS.settings.sharingPerAgent,
];

/** Composer gauges live on the collection's main page, rather than its sign-in subpage. */
export const CONNECTED_SERVICES_USAGE_GAUGE_SETTINGS = defineSettingsPage({
    pageId: 'connectedServices',
    sections: { usageGauge: PROVIDER_USAGE_GAUGE_SETTINGS_SECTION },
});
