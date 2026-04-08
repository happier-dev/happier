import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export function resolveVoiceProviderId(value: unknown): VoiceSettings['providerId'] | null {
    const normalized = normalizeNonEmptyString(value);
    if (
        normalized === 'off'
        || normalized === 'realtime_elevenlabs'
        || normalized === 'local_direct'
        || normalized === 'local_conversation'
    ) {
        return normalized;
    }
    return null;
}
