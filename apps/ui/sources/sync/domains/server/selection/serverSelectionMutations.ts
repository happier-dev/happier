import type { ServerSelectionGroup, ServerSelectionPresentation } from './serverSelectionTypes';

export type ToggleServerSelectionGroupServerIdResult = Readonly<{
    nextServerIds: string[];
    preventedEmpty: boolean;
}>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeName(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizePresentation(raw: unknown): ServerSelectionPresentation {
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

export function toggleServerSelectionGroupServerIdEnsuringNonEmpty(
    currentServerIds: ReadonlyArray<string>,
    serverIdRaw: string,
): ToggleServerSelectionGroupServerIdResult {
    const serverId = normalizeId(serverIdRaw);
    const normalizedCurrent = normalizeServerIds(currentServerIds);
    if (!serverId) {
        return { nextServerIds: normalizedCurrent.slice(), preventedEmpty: false };
    }

    const exists = normalizedCurrent.includes(serverId);
    if (!exists) {
        return { nextServerIds: [...normalizedCurrent, serverId], preventedEmpty: false };
    }

    if (normalizedCurrent.length <= 1) {
        return { nextServerIds: normalizedCurrent.slice(), preventedEmpty: true };
    }

    return {
        nextServerIds: normalizedCurrent.filter((id) => id !== serverId),
        preventedEmpty: false,
    };
}

export function normalizeStoredServerSelectionGroups(raw: unknown): ServerSelectionGroup[] {
    if (!Array.isArray(raw)) return [];
    const seenIds = new Set<string>();
    const result: ServerSelectionGroup[] = [];

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

export function filterServerSelectionGroupsToAvailableServers(
    groups: ReadonlyArray<ServerSelectionGroup>,
    availableServerIds: ReadonlySet<string>,
): ServerSelectionGroup[] {
    if (availableServerIds.size === 0) return groups.slice();
    return groups.map((group) => {
        const serverIds = group.serverIds.filter((id) => availableServerIds.has(id));
        return serverIds.length === group.serverIds.length ? group : { ...group, serverIds };
    });
}
