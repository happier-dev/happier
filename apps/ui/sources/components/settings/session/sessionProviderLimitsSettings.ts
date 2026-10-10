import { PROVIDER_USAGE_GAUGE_SETTINGS_SECTION } from '@/components/settings/connectedServices/providerUsageGaugeSettings';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { defineSettingsPage } from '@/components/settings/catalog/settingDeclarations';

import { personalPaceTargetStorage, autoWaitStorage } from '@happier-dev/protocol/actions/settings/accountSettingBindings';

/** The searchable settings of Sessions › Provider limits (a sub-page linked from Sessions). */
export const SESSION_PROVIDER_LIMITS_SETTINGS = defineSettingsPage({
    pageId: 'session',
    subpage: { id: 'providerLimits', route: SETTINGS_ROUTES.sessionProviderLimits, titleKey: 'settingsSession.providerLimits.title' },
    sections: {
        usageLimitRecovery: {
            titleKey: 'settingsSession.usageLimitRecovery.title',
            featureId: 'sessions.usageLimitRecovery',
            settings: {
                autoWait: { storage: autoWaitStorage },
                resumePrompt: {},
                customResumePrompt: {},
            },
        },
        usageGauge: PROVIDER_USAGE_GAUGE_SETTINGS_SECTION,
        capacityAlerts: {
            titleKey: 'usage.board.plans.alertsTitle',
            featureId: 'connectedServices.quotas',
            settings: {
                personalPaceTarget: { storage: personalPaceTargetStorage },
                alertPace: {},
                alertDepletion: {},
                alertAlmostOut: {},
                alertReset: {},
                alertUnused: {},
                alertEnding: {},
                alertCreditExpiry: {},
            },
        },
    },
});
