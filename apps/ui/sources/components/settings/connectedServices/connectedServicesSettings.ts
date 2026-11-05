import { sharingConfigStorage, sharingStateStorage, sharingPerAgentStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { prepareDefaultProviderStateSharingChange, prepareAgentProviderStateSharingChange } from './providerStateSharingSettings';

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
                agentDefaults: {},
                sharing: {},
                sharingConfig: {
                    storage: sharingConfigStorage,

                },
                sharingState: {
                    storage: {
                        ...sharingStateStorage,
                        prepare: async (settings, value, _services, context) => {
                            if (typeof value !== 'boolean') return null;
                            const apply = await prepareDefaultProviderStateSharingChange(settings.connectedServicesProviderStateSharingSettingsV1, value);
                            if (!apply || context?.isCurrent() === false) return null;
                            return current => {
                                if (context?.isCurrent() === false) return null;
                                const next = apply(current.connectedServicesProviderStateSharingSettingsV1);
                                return next ? { connectedServicesProviderStateSharingSettingsV1: next } : null;
                            };
                        },
                    },

                },
                sharingPerAgent: { storage: { ...sharingPerAgentStorage,
                    prepare: async (settings, value, _services, context) => {
                        const apply = await prepareAgentProviderStateSharingChange(settings.connectedServicesProviderStateSharingSettingsV1, value);
                        if (!apply || context?.isCurrent() === false) return null;
                        return current => {
                            if (context?.isCurrent() === false) return null;
                            const next = apply(current.connectedServicesProviderStateSharingSettingsV1);
                            return next ? { connectedServicesProviderStateSharingSettingsV1: next } : null;
                        };
                    },
                } },
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
