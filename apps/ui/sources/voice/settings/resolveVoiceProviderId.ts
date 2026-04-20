import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { Platform } from 'react-native';

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

export function resolveContinuousVoiceProviderId(
    value: unknown,
    options?: Readonly<{
        platformOs?: string | null;
    }>,
): ResolvedVoiceProviderId {
    const providerId = resolveStoredVoiceProviderId(value);
    const platformOs = normalizeNonEmptyString(options?.platformOs) ?? Platform.OS;

    if (platformOs === 'web' && (providerId === 'local_direct' || providerId === 'local_conversation')) {
        return 'realtime_elevenlabs';
    }

    return providerId;
}
