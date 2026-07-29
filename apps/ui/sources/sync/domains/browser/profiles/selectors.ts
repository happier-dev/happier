import type { BrowserProfileV1 } from '@happier-dev/protocol';

import type { BrowserControlState, BrowserControlViewState } from '../control';
import type { BrowserProfilesState } from './store';

export function selectBrowserProfile(
    state: BrowserProfilesState,
    profileId: string | null | undefined,
): BrowserProfileV1 | null {
    if (!profileId) return null;
    return state.profilesById[profileId] ?? null;
}

export function selectUsableBrowserProfile(
    state: BrowserProfilesState,
    profileId: string | null | undefined,
): BrowserProfileV1 | null {
    const profile = selectBrowserProfile(state, profileId);
    if (!profile) return null;
    if ((profile.lifecycleState ?? 'active') !== 'active') return null;
    return profile;
}

export function selectBrowserProfileForView(
    controlState: BrowserControlState,
    profilesState: BrowserProfilesState,
    view: BrowserControlViewState | null | undefined,
): BrowserProfileV1 | null {
    if (!view) return null;
    const session = controlState.sessionsById[view.browserSessionId];
    return selectUsableBrowserProfile(profilesState, session?.profileId);
}

export function selectBrowserProfileMode(
    profile: BrowserProfileV1 | null | undefined,
): BrowserProfileV1['storageMode'] | null {
    return profile?.storageMode ?? null;
}
