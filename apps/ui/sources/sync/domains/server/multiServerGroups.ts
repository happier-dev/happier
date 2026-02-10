export type MultiServerGroupPresentation = 'grouped' | 'flat-with-badge';

export type MultiServerGroupProfile = Readonly<{
    id: string;
    name: string;
    serverIds: string[];
    presentation: MultiServerGroupPresentation;
}>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeName(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizePresentation(raw: unknown): MultiServerGroupPresentation {
    return raw === 'flat-with-badge' ? 'flat-with-badge' : 'grouped';
}

function normalizeServerIds(raw: unknown): string[] {
    const idsRaw = Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of idsRaw) {
        const id = normalizeId(item);
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

// Storage normalization must not depend on currently-known server profiles.
// Otherwise, transiently missing servers can permanently erase saved group membership.
export function normalizeStoredMultiServerGroupProfiles(raw: unknown): MultiServerGroupProfile[] {
    if (!Array.isArray(raw)) return [];
    const seenIds = new Set<string>();
    const result: MultiServerGroupProfile[] = [];

    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const id = normalizeId(record.id);
        const name = normalizeName(record.name);
        if (!id || !name) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        result.push({
            id,
            name,
            serverIds: normalizeServerIds(record.serverIds),
            presentation: normalizePresentation(record.presentation),
        });
    }

    return result;
}

export function filterMultiServerGroupProfilesToAvailable(
    profiles: ReadonlyArray<MultiServerGroupProfile>,
    availableServerIds: ReadonlySet<string>,
): MultiServerGroupProfile[] {
    // An empty available set is ambiguous (it can happen transiently while profiles load or
    // if an exception prevented reading server profiles). Filtering in that state would
    // permanently erase group membership if persisted.
    if (availableServerIds.size === 0) return profiles.slice();
    return profiles.map((profile) => {
        const serverIds = profile.serverIds.filter((id) => availableServerIds.has(id));
        return serverIds.length === profile.serverIds.length ? profile : { ...profile, serverIds };
    });
}
