import { useLocalSetting } from '@/sync/domains/state/storage';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { useDeviceType } from '@/utils/platform/responsive';

export type VoicePresenceContainer = NonNullable<LocalSettings['voicePresenceContainer']>;

export function resolveVoicePresenceContainer(
    preference: LocalSettings['voicePresenceContainer'] | undefined,
    deviceType: 'phone' | 'tablet',
): VoicePresenceContainer {
    const available = getAvailableVoicePresenceContainers(deviceType);
    return preference && available.includes(preference) ? preference : available[0];
}

/** Phone presentation has no title strip. This resolves presentation only, never stored choice. */
export function getAvailableVoicePresenceContainers(deviceType: 'phone' | 'tablet'): readonly VoicePresenceContainer[] {
    return deviceType === 'phone' ? PHONE_CONTAINERS : WIDE_CONTAINERS;
}

const PHONE_CONTAINERS: readonly VoicePresenceContainer[] = ['island', 'orb'];
const WIDE_CONTAINERS: readonly VoicePresenceContainer[] = ['top_bar', 'island', 'orb'];

export function useVoicePresenceContainer(): VoicePresenceContainer {
    const preference = useLocalSetting('voicePresenceContainer');
    const deviceType = useDeviceType();
    return resolveVoicePresenceContainer(preference, deviceType);
}
