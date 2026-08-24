import { AccountProfileSchema, type AccountProfile } from '@happier-dev/protocol';

//
// Types
//

export type Profile = AccountProfile;

//
// Defaults
//

export const profileDefaults: Profile = {
    id: '',
    timestamp: 0,
    firstName: null,
    lastName: null,
    username: null,
    avatar: null,
    linkedProviders: [],
    connectedServices: [],
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
    connectedAccountsV4: [],
    connectedAccountGroupsV4: [],
};
Object.freeze(profileDefaults);

//
// Parsing
//

function parseProfile(profile: unknown) {
    return AccountProfileSchema.safeParse(profile);
}

export function tryParseProfile(profile: unknown): Profile | null {
    const parsed = parseProfile(profile);
    return parsed.success ? parsed.data : null;
}

export function profileParse(profile: unknown): Profile {
    const parsed = parseProfile(profile);
    if (!parsed.success) {
        console.error('Failed to parse profile:', parsed.error);
        return { ...profileDefaults };
    }
    return parsed.data;
}

//
// Utility functions
//

function normalizeLinkedProviders(profile: Pick<Profile, 'linkedProviders'>): readonly Profile['linkedProviders'][number][] {
    return Array.isArray(profile.linkedProviders) ? profile.linkedProviders : [];
}

function getPrimaryLinkedProvider(profile: Profile) {
    for (const provider of normalizeLinkedProviders(profile)) {
        if (provider.displayName || provider.login || provider.avatarUrl) return provider;
    }
    return normalizeLinkedProviders(profile)[0] ?? null;
}

export function getDisplayName(profile: Profile): string | null {
    if (profile.firstName || profile.lastName) {
        return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    }
    const primary = getPrimaryLinkedProvider(profile);
    if (primary?.displayName) return primary.displayName;
    if (primary?.login) return primary.login;
    if (profile.username) return profile.username;
    return null;
}

export function getAvatarUrl(profile: Profile): string | null {
    if (profile.avatar?.url) {
        return profile.avatar.url;
    }
    const primary = getPrimaryLinkedProvider(profile);
    return primary?.avatarUrl ?? null;
}

export function getBio(_profile: Profile): string | null {
    return null;
}

export function getLinkedProvider(profile: Profile, providerId: string) {
    const normalized = providerId.toString().trim().toLowerCase();
    return normalizeLinkedProviders(profile).find((p) => p.id.toString().trim().toLowerCase() === normalized) ?? null;
}

export function hasLinkedProvider(profile: Profile, providerId: string): boolean {
    return Boolean(getLinkedProvider(profile, providerId));
}
