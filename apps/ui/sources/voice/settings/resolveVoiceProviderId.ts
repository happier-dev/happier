import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

type ResolvedVoiceProviderId = VoiceSettings['providerId'] | null;

function normalizeStoredVoiceProviderId(value: unknown): ResolvedVoiceProviderId {
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

export function resolveStoredVoiceProviderId(value: unknown): ResolvedVoiceProviderId {
    return normalizeStoredVoiceProviderId(value);
}

export function resolveVoiceProviderId(value: unknown): ResolvedVoiceProviderId {
    return resolveStoredVoiceProviderId(value);
}
