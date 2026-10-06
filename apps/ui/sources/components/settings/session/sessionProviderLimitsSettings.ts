import { PROVIDER_USAGE_GAUGE_SETTINGS_SECTION } from '@/components/settings/connectedServices/providerUsageGaugeSettings';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

/** The searchable settings of Sessions › Provider limits (a sub-page linked from Sessions). */
export const SESSION_PROVIDER_LIMITS_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'providerLimits', route: SETTINGS_ROUTES.sessionProviderLimits, titleKey: 'settingsSession.providerLimits.title' },
    sections: {
        usageLimitRecovery: {
            titleKey: 'settingsSession.usageLimitRecovery.title',
            featureId: 'sessions.usageLimitRecovery',
            settings: {
                autoWait: { titleKey: 'settingsSession.usageLimitRecovery.autoWaitTitle' },
                resumePrompt: {
                    titleKey: 'settingsSession.usageLimitRecovery.resumePromptTitle',
                    keywordKeys: ['settingsSession.usageLimitRecovery.customResumePromptTitle'],
                },
            },
        },
        usageGauge: PROVIDER_USAGE_GAUGE_SETTINGS_SECTION,
    },
});
