import { voiceSettingsParse, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';

export function readVoicePrivacySettings(settings: unknown): VoiceSettings['privacy'] {
    const voiceSettings = voiceSettingsParse((settings as { voice?: unknown } | null | undefined)?.voice ?? null);
    return voiceSettings.privacy;
}
