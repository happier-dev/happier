import { projectVoiceSettingsAnalytics } from '@/sync/domains/settings/voiceSettings';


/**
 * Presentation-only Voice telemetry. Persistence schema, defaults, parsing, provider identity,
 * and provider-specific safe summaries remain owned by the canonical Voice settings domain.
 */
export const ACCOUNT_VOICE_SETTING_ANALYTICS = {
    voice: projectVoiceSettingsAnalytics,
};
