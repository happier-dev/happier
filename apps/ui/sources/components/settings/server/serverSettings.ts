import { defineSettingsPage, settingsHosts, parseSettingScalarValue, type SettingsHostPredicate } from '@/components/settings/catalog/settingDeclarations';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';

// The setup surface policy is fixed by the build, so like a host fact it decides whether a row exists.
const localRelayHostAllowed: SettingsHostPredicate = (host) => settingsHosts.tauriDesktop(host)
    && resolveSetupSurfacePolicy().relay.allowLocalRelayHost;
const relaySelectionAllowed: SettingsHostPredicate = () => resolveSetupSurfacePolicy().relay.allowRelaySelection;
const addHomeAllowed: SettingsHostPredicate = () => {
    const { relay } = resolveSetupSurfacePolicy();
    return relay.allowRelaySelection && relay.allowCustomRelayUrl;
};

/**
 * The searchable settings of the `servers` page (Settings → Homes, landing on This device). Rows render
 * their labels from these declarations.
 */
export const SERVERS_SETTINGS = defineSettingsPage({
    pageId: 'servers',
    sections: {
        connection: {
            titleKey: 'server.page.connectionTitle',
            settings: {
                standardOnly: {
                    storage: { scope: 'local', kind: 'localOwner', access: 'read_write', allowedValues: [true, false],
                        read: local => local.homeApplicationCarrierEligibility === 'standard_only',
                        parse: value => typeof value === 'boolean' ? parseSettingScalarValue(value) : { success: false },
                        commit: async (_local, value, writeLocal) => {
                            const { commitHomeApplicationCarrierEligibility } = await import('@/sync/runtime/orchestration/connectionManager');
                            commitHomeApplicationCarrierEligibility(value === true ? 'standard_only' : 'automatic',
                                eligibility => writeLocal({ homeApplicationCarrierEligibility: eligibility }));
                        } } },
            },
        },
        homesView: {
            // Rendered while a Homes group is being edited (page state).
            titleKey: 'server.multiServerView.title',
            settings: {
                groupPresentation: {},
            },
        },
        relayAccess: {
            // The desktop app hosts the local relay (when the build allows it); its access controls
            // render nowhere else. The LAN and tunnel fields wait on the chosen method (page state).
            titleKey: 'settings.relayAccess.title',
            host: localRelayHostAllowed,
            settings: {
                accessMethod: {},
                lanUrl: {},
                cloudflareHostname: {},
                cloudflareToken: {},
            },
        },
    },
});

/**
 * The searchable settings of the `serversAdd` page (Settings → Homes → Add a Home, the collection's
 * draft): adding a Home by any path, and setting one up on a server (desktop app).
 */
export const HOMES_ADD_SETTINGS = defineSettingsPage({
    pageId: 'serversAdd',
    sections: {
        add: {
            titleKey: 'addFlows.addHome',
            settings: {
                addHome: { host: addHomeAllowed },
                createPersonalHome: {

                    host: relaySelectionAllowed,
                },
            },
        },
    },
});
