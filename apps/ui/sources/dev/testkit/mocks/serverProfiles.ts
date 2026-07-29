export type ServerProfileMockProfile = Readonly<{
    id: string;
    name?: string;
    serverUrl: string;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly string[];
}>;

type ServerProfilesModule = typeof import('@/sync/domains/server/serverProfiles');
type ServerProfile = ReturnType<ServerProfilesModule['listServerProfiles']>[number];

export type ServerProfilesModuleMockOptions = Readonly<{
    listServerProfiles?: () => unknown;
    overrides?: Partial<ServerProfilesModule>;
    profiles?: readonly ServerProfileMockProfile[];
}>;

function normalizeServerProfileTestId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function toServerProfile(profile: ServerProfileMockProfile): ServerProfile {
    return {
        id: profile.id,
        name: profile.name ?? profile.id,
        serverUrl: profile.serverUrl,
        serverIdentityId: profile.serverIdentityId,
        legacyServerIds: profile.legacyServerIds,
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
    };
}

function readProfiles(options: ServerProfilesModuleMockOptions): ServerProfile[] {
    const value = options.listServerProfiles ? options.listServerProfiles() : options.profiles;
    return Array.isArray(value) ? (value as ServerProfileMockProfile[]).map(toServerProfile) : [];
}

function findProfileByIdentifier(
    options: ServerProfilesModuleMockOptions,
    idRaw: unknown,
): ServerProfile | null {
    const id = normalizeServerProfileTestId(idRaw);
    if (!id) return null;
    return readProfiles(options).find((profile) => (
        normalizeServerProfileTestId(profile.id) === id
        || normalizeServerProfileTestId(profile.serverIdentityId) === id
        || (profile.legacyServerIds ?? []).some((legacyId) => normalizeServerProfileTestId(legacyId) === id)
    )) ?? null;
}

function resolveProfileScopeId(profile: Pick<ServerProfileMockProfile, 'id' | 'serverIdentityId'>): string {
    return normalizeServerProfileTestId(profile.serverIdentityId) || normalizeServerProfileTestId(profile.id);
}

function createServerProfilesModuleMockBase(options: ServerProfilesModuleMockOptions) {
    return {
        listServerProfiles: () => readProfiles(options),
        getServerProfileById: (id: unknown) => findProfileByIdentifier(options, id),
        resolveServerProfileScopeId: (profile: Pick<ServerProfileMockProfile, 'id' | 'serverIdentityId'>) => resolveProfileScopeId(profile),
        resolveServerProfileScopeIdForIdentifier: (id: unknown) => {
            const profile = findProfileByIdentifier(options, id);
            return profile ? resolveProfileScopeId(profile) : normalizeServerProfileTestId(id);
        },
        areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => {
            const leftId = normalizeServerProfileTestId(left);
            const rightId = normalizeServerProfileTestId(right);
            if (!leftId || !rightId) return false;
            if (leftId === rightId) return true;
            const leftProfile = findProfileByIdentifier(options, leftId);
            const rightProfile = findProfileByIdentifier(options, rightId);
            return Boolean(leftProfile && rightProfile && leftProfile.id === rightProfile.id);
        },
    };
}

export function createServerProfilesModuleMock(options: ServerProfilesModuleMockOptions = {}) {
    return {
        ...createServerProfilesModuleMockBase(options),
        ...(options.overrides ?? {}),
    };
}

export async function createPartialServerProfilesModuleMock(
    importOriginal: <T>() => Promise<T>,
    options: ServerProfilesModuleMockOptions = {},
): Promise<ServerProfilesModule> {
    const actual = await importOriginal<ServerProfilesModule>();
    return {
        ...actual,
        ...createServerProfilesModuleMockBase(options),
        ...(options.overrides ?? {}),
    };
}
