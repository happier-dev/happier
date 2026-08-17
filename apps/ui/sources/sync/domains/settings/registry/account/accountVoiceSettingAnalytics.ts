import { projectVoiceSettingsAnalytics } from '@/sync/domains/settings/voiceSettings';

import { defineAccountSettingAnalytics } from './accountSettingAnalyticsPresentation';

/**
 * Presentation-only Voice telemetry. Persistence schema, defaults, parsing, provider identity,
 * and provider-specific safe summaries remain owned by the canonical Voice settings domain.
 */
export const ACCOUNT_VOICE_SETTING_ANALYTICS = defineAccountSettingAnalytics({
    voice: {
        trackCurrentState: true,
        trackChanges: true,
        valueKind: 'enum',
        privacy: 'safe',
        identityScope: 'person',
        serializeCurrentProperties: projectVoiceSettingsAnalytics,
    },
});
