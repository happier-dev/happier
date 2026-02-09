import type { AIBackendProfile } from '@/sync/domains/settings/settings';
import { getBuiltInProfileNameKey } from '@/sync/domains/profiles/profileUtils';
import { t } from '@/text';

export function getProfileDisplayName(profile: Pick<AIBackendProfile, 'id' | 'name' | 'isBuiltIn'>): string {
    if (profile.isBuiltIn) {
        const key = getBuiltInProfileNameKey(profile.id);
        if (key) {
            return t(key);
        }
    }
    return profile.name;
}

