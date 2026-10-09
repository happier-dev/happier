import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';
import { readDirectConnectionsEnabled, withDirectConnectionsEnabled } from '@/sync/domains/settings/peerMediationPreferences';

/** Account's searchable settings. Rows render their labels from these declarations. */
export const ACCOUNT_SETTINGS = defineSettingsPage({
    pageId: 'account',
    sections: {
        signIn: {
            titleKey: 'settingsAccount.security',
            settings: {
                emailPassword: {
                    titleKey: 'settingsAccount.nativePassword.securitySectionTitle',
                    keywordKeys: ['settingsAccount.nativePassword.password', 'settingsAccount.nativePassword.signInEmail'],
                },
            },
        },
        accountService: {
            settings: {
                accountService: {
                    titleKey: 'settingsAccount.accountServiceChooserTitle',
                    descriptionKey: 'settingsAccount.accountServiceDescription',
                    keywordKeys: [
                        'settingsAccount.accountServiceChangeService',
                        'settingsAccount.accountServiceLinkedHomes',
                        'settingsAccount.accountHomeDiscoveryTitle',
                    ],
                },
            },
        },
        connections: {
            titleKey: 'settingsConnections.sectionTitle',
            settings: {
                directConnections: {
                    storage: {
                        scope: 'account', kind: 'owner', access: 'read_write',
                        read: settings => readDirectConnectionsEnabled(settings.peerMediationPreferencesV1),
                        parse: value => typeof value === 'boolean' ? { success: true, value } : { success: false },
                        mutate: (settings, value) => typeof value === 'boolean'
                            ? { peerMediationPreferencesV1: withDirectConnectionsEnabled(settings.peerMediationPreferencesV1, value) } : null,
                    },
                    titleKey: 'settingsConnections.directTitle',
                    descriptionKey: 'settingsConnections.directOnDescription',
                    keywordKeys: ['settingsConnections.machineOptionRelay'],
                },
            },
        },
        privacy: {
            titleKey: 'settingsAccount.privacy',
            settings: {
                analytics: { storage: { scope: 'account', key: 'analyticsOptOut', access: 'read_write', invertBoolean: true }, titleKey: 'settingsAccount.shareUsageData', descriptionKey: 'settingsAccount.shareUsageDataDescription', keywordKeys: ['settingsAccount.analytics'] },
                crashReports: { storage: { scope: 'account', key: 'crashReportsOptOut', access: 'read_write', invertBoolean: true }, titleKey: 'settingsAccount.shareCrashReports', keywordKeys: ['settingsAccount.crashReports'] },
                settingsHistory: { titleKey: 'settingsAccount.history.title', descriptionKey: 'settingsAccount.history.footer',
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
