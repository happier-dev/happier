import { profileDefaults, tryParseProfile, type Profile } from '../profiles/profile';

import { getPersistenceStorage } from './persistenceStorage';

export function loadProfile(): Profile {
    const mmkv = getPersistenceStorage();
    const profile = mmkv.getString('profile');
    if (profile) {
        try {
            const parsed = tryParseProfile(JSON.parse(profile) as unknown);
            if (parsed) return parsed;
        } catch {
            // Fall through to discard the malformed cached projection.
        }
        mmkv.delete('profile');
    }
    return { ...profileDefaults };
}

export function saveProfile(profile: Profile) {
    const mmkv = getPersistenceStorage();
    mmkv.set('profile', JSON.stringify(profile));
}
