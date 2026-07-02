import {
    resolveServerProfileScopeId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';

import type { RawServerSelectionSettings } from './serverSelectionResolution';

export type ServerProfileScopeIdentity = Pick<ServerProfile, 'id' | 'serverIdentityId' | 'legacyServerIds'>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function createServerProfileScopeIdAliasMap(profiles: ReadonlyArray<ServerProfileScopeIdentity>): Map<string, string> {
    const aliases = new Map<string, string>();
    for (const profile of profiles) {
        const scopeId = resolveServerProfileScopeId(profile);
        if (!scopeId) continue;
        aliases.set(profile.id, scopeId);
        aliases.set(scopeId, scopeId);
        for (const legacyId of profile.legacyServerIds ?? []) {
            const id = normalizeId(legacyId);
            if (id) aliases.set(id, scopeId);
        }
    }
    return aliases;
}

function uniqueMappedServerIds(idsRaw: unknown, aliases: ReadonlyMap<string, string>): string[] {
    if (!Array.isArray(idsRaw)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of idsRaw) {
        const id = normalizeId(raw);
        if (!id) continue;
        const mapped = aliases.get(id) ?? id;
        if (seen.has(mapped)) continue;
        seen.add(mapped);
        result.push(mapped);
    }
    return result;
}

function mapServerId(raw: unknown, aliases: ReadonlyMap<string, string>): string | null {
    const id = normalizeId(raw);
    if (!id) return null;
    return aliases.get(id) ?? id;
}

export function listServerProfileScopeIds(profiles: ReadonlyArray<ServerProfileScopeIdentity>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const profile of profiles) {
        const id = resolveServerProfileScopeId(profile);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}

export function normalizeServerSelectionSettingsForProfileScopeIds(
    settings: RawServerSelectionSettings,
    profiles: ReadonlyArray<ServerProfileScopeIdentity>,
): RawServerSelectionSettings {
    const aliases = createServerProfileScopeIdAliasMap(profiles);
    const rawGroups = settings.serverSelectionGroups;
    const serverSelectionGroups = Array.isArray(rawGroups)
        ? rawGroups.map((group) => {
            if (!group || typeof group !== 'object') return group;
            const record = group as Record<string, unknown>;
            return {
                ...record,
                serverIds: uniqueMappedServerIds(record.serverIds, aliases),
            };
        })
        : rawGroups;

    const activeTargetId =
        settings.serverSelectionActiveTargetKind === 'server'
            ? mapServerId(settings.serverSelectionActiveTargetId, aliases)
            : settings.serverSelectionActiveTargetId;

    return {
        serverSelectionGroups,
        serverSelectionActiveTargetKind: settings.serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId: activeTargetId,
    };
}
