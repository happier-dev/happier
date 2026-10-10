import { directConnectionsStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** Account's searchable settings. Rows render their labels from these declarations. */
export const ACCOUNT_SETTINGS = defineSettingsPage({
    pageId: 'account',
    sections: {
        signIn: {
            titleKey: 'settingsAccount.security',
            settings: {
                emailPassword: {},
            },
        },
        accountService: {
            settings: {
                accountService: {},
            },
        },
        connections: {
            titleKey: 'settingsConnections.sectionTitle',
            settings: {
                directConnections: {
                    storage: directConnectionsStorage,

                },
            },
        },
        privacy: {
            titleKey: 'settingsAccount.privacy',
            settings: {
                analytics: {},
                crashReports: {},
                settingsHistory: {
                    operation: { kind: 'invoke', requiresHumanInteraction: false, requiresApproval: true,
                        async invoke(context) {
                            if (context.input?.kind !== 'account_settings_history_purge') return { status: 'unavailable', reason: 'invalid_history_operation' };
                            const purge = context.services?.purgeAccountSettingsHistory;
                            if (!purge || !context.isCurrent()) return { status: 'unavailable', reason: 'history_transport_unavailable' };
                            const result = await purge(context.input.versions, context.signal);
                            return result.status === 'complete' ? { status: 'completed', value: { versions: [...context.input.versions] } }
                                : { status: 'unavailable', reason: 'history_cleanup_pending', value: { versions: [...result.versions] } };
                        },
                    },
                },
            },
        },
    },
});
