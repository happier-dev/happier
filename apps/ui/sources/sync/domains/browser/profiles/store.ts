import type { BrowserProfileV1 } from '@happier-dev/protocol';

export type BrowserProfilesState = Readonly<{
    profilesById: Readonly<Record<string, BrowserProfileV1>>;
}>;

export function createBrowserProfilesState(): BrowserProfilesState {
    return { profilesById: {} };
}

export function upsertBrowserProfile(state: BrowserProfilesState, profile: BrowserProfileV1): BrowserProfilesState {
    return {
        profilesById: {
            ...state.profilesById,
            [profile.profileId]: profile,
        },
    };
}

export function markBrowserProfileUnusable(
    state: BrowserProfilesState,
    profileId: string,
    reasonCode: string,
): BrowserProfilesState {
    const profile = state.profilesById[profileId];
    if (!profile) return state;
    const disabledReasons = profile.disabledReasons?.includes(reasonCode)
        ? profile.disabledReasons
        : [...(profile.disabledReasons ?? []), reasonCode];
    return {
        profilesById: {
            ...state.profilesById,
            [profileId]: {
                ...profile,
                lifecycleState: 'unusable',
                disabledReasons,
            },
        },
    };
}

export function dropBrowserProfilesByOwnerSession(
    state: BrowserProfilesState,
    sessionId: string,
): BrowserProfilesState {
    const profilesById: Record<string, BrowserProfileV1> = {};
    for (const profile of Object.values(state.profilesById)) {
        if (profile.owner.kind === 'session' && profile.owner.id === sessionId) continue;
        profilesById[profile.profileId] = profile;
    }
    return { profilesById };
}

export function dropEphemeralBrowserProfiles(state: BrowserProfilesState): BrowserProfilesState {
    const profilesById: Record<string, BrowserProfileV1> = {};
    for (const profile of Object.values(state.profilesById)) {
        if (profile.storageMode === 'ephemeral') continue;
        profilesById[profile.profileId] = profile;
    }
    return { profilesById };
}
