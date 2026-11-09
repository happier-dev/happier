import { AccountProfileSchema, type AccountProfile } from '@happier-dev/protocol/account/profile';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { sameQualifiedConnectedAccountGroupRef } from '@happier-dev/protocol/connect/qualified-connected-account-projections';

//
// Types
//

export type Profile = AccountProfile;

/** A selected pool read joins the same projection that subsequent Account pushes update. */
export function upsertProfileConnectedAccountGroup(profile: Profile, group: Profile['connectedAccountGroupsV4'][number]): Profile {
    const groups = [...profile.connectedAccountGroupsV4];
    const index = groups.findIndex(current => sameQualifiedConnectedAccountGroupRef(current.ref, group.ref));
    if (index === -1) groups.push(group);
    else groups[index] = group;
    return { ...profile, connectedAccountGroupsV4: groups };
}

//
// Defaults
//

export const profileDefaults: Profile = {
    id: '',
    timestamp: 0,
    name: null,
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
    const parsed = createStoredReadSchema(AccountProfileSchema).safeParse(profile);
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
