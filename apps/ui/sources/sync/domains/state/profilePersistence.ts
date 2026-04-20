import { profileDefaults, profileParse, type Profile } from '../profiles/profile';

import { getPersistenceStorage } from './persistenceStorage';

export function loadProfile(): Profile {
    const mmkv = getPersistenceStorage();
    const profile = mmkv.getString('profile');
    if (profile) {
        try {
            const parsed = JSON.parse(profile);
            return profileParse(parsed);
        } catch (e) {
            console.error('Failed to parse profile', e);
            return { ...profileDefaults };
        }
    }
    return { ...profileDefaults };
}

export function saveProfile(profile: Profile) {
    const mmkv = getPersistenceStorage();
    mmkv.set('profile', JSON.stringify(profile));
}
