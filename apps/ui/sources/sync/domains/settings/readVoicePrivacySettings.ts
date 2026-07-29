import { voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';

export function readVoicePrivacySettings(settings: unknown): VoiceSettings['privacy'] {
    const rawVoice = (settings as { voice?: unknown } | null | undefined)?.voice ?? null;
    const voiceSettings = voiceSettingsParse(rawVoice);
    const rawPrivacy = rawVoice && typeof rawVoice === 'object' && !Array.isArray(rawVoice)
        ? (rawVoice as { privacy?: unknown }).privacy
        : null;
    const privacyRecord = rawPrivacy && typeof rawPrivacy === 'object' && !Array.isArray(rawPrivacy)
        ? rawPrivacy as Record<string, unknown>
        : null;
    const explicitlyShares = (key: string): boolean => privacyRecord?.[key] === true;

    return {
        ...voiceSettings.privacy,
        // These values are consumed at provider boundaries. A malformed or
        // partial payload must never inherit the account schema's UI defaults.
        shareSessionSummary: explicitlyShares('shareSessionSummary'),
        shareRecentMessages: explicitlyShares('shareRecentMessages'),
        shareToolNames: explicitlyShares('shareToolNames'),
        sharePermissionRequests: explicitlyShares('sharePermissionRequests'),
        shareDeviceInventory: explicitlyShares('shareDeviceInventory'),
        // These remain hard-disabled unless the canonical parser and raw value
        // both explicitly admit sharing.
        shareFilePaths: voiceSettings.privacy.shareFilePaths && explicitlyShares('shareFilePaths'),
        shareToolArgs: voiceSettings.privacy.shareToolArgs && explicitlyShares('shareToolArgs'),
    };
}
