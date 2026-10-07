import type { Profile } from '../../domains/profiles/profile';
import { profileDefaults } from '../../domains/profiles/profile';
import type { ServerAccountScope } from '../../domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '../../domains/scope/serverAccountScope';
import { retireActiveServerAccountScopeLifetime } from '../../domains/scope/activeServerAccountScope';
import {
    loadAccountProfile,
    prepareAccountProfileScopeForActivation,
    saveAccountProfile,
} from '../../domains/state/accountProfilePersistence';
import { loadProfile, saveProfile } from '../../domains/state/profilePersistence';

import type { StoreGet, StoreSet } from './_shared';

export type ProfileDomain = {
    profile: Profile;
    profileScope: ServerAccountScope | null;
    activateProfileScope: (scope: ServerAccountScope, legacyScopes?: readonly ServerAccountScope[]) => void;
    clearProfileScope: () => void;
    applyProfile: (profile: Profile) => void;
    applyProfileForScope: (scope: ServerAccountScope, profile: Profile) => void;
};

export function createProfileDomain<S extends ProfileDomain>({
    set,
    get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): ProfileDomain {
    const profile = loadProfile();

    return {
        profile,
        profileScope: null,
        activateProfileScope: (scope, legacyScopes = []) => {
            prepareAccountProfileScopeForActivation(scope, legacyScopes);
            const profile = loadAccountProfile(scope);
            if (!areServerAccountScopesEqual(get().profileScope, scope)) {
                retireActiveServerAccountScopeLifetime();
            }
            set((state) => ({
                ...state,
                profile,
                profileScope: scope,
            }));
        },
        clearProfileScope: () => {
            if (get().profileScope) retireActiveServerAccountScopeLifetime();
            set((state) => ({
                ...state,
                profile: { ...profileDefaults },
                profileScope: null,
            }));
        },
        applyProfile: (nextProfile) =>
            set((state) => {
                if (state.profileScope) {
                    saveAccountProfile(state.profileScope, nextProfile);
                } else {
                    saveProfile(nextProfile);
                }
                return {
                    ...state,
                    profile: nextProfile,
                };
            }),
        applyProfileForScope: (scope, nextProfile) =>
            set((state) => {
                saveAccountProfile(scope, nextProfile);
                if (!areServerAccountScopesEqual(state.profileScope, scope)) {
                    return state;
                }
                return {
                    ...state,
                    profile: nextProfile,
                };
            }),
    };
}
