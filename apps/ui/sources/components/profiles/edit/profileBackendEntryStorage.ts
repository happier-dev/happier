import { buildBackendTargetKey } from '@happier-dev/protocol';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

type ProfileTargetValueRecord<TValue> = Readonly<Record<string, TValue | undefined>> | null | undefined;

function getLegacyProviderSentinelTargetKey(entry: ResolvedBackendCatalogEntry): string | null {
    if (entry.builtInAgentId != null) return null;
    return buildBackendTargetKey({ kind: 'builtInAgent', agentId: entry.providerAgentId });
}

export function readProfileTargetKeyValueForEntry<TValue>(
    record: ProfileTargetValueRecord<TValue>,
    entry: ResolvedBackendCatalogEntry,
): TValue | undefined {
    const exact = record?.[entry.targetKey];
    if (exact !== undefined) {
        return exact;
    }

    const legacyProviderSentinelTargetKey = getLegacyProviderSentinelTargetKey(entry);
    if (!legacyProviderSentinelTargetKey) {
        return undefined;
    }

    return record?.[legacyProviderSentinelTargetKey];
}

export function isProfileCompatibleWithResolvedBackendEntry(
    profile: Pick<AIBackendProfile, 'compatibility' | 'compatibilityByTargetKey' | 'isBuiltIn'>,
    entry: ResolvedBackendCatalogEntry,
): boolean {
    const explicitByTargetKey = readProfileTargetKeyValueForEntry(profile.compatibilityByTargetKey, entry);
    if (typeof explicitByTargetKey === 'boolean') {
        return explicitByTargetKey === true;
    }

    if (entry.builtInAgentId && typeof profile.compatibility?.[entry.builtInAgentId] === 'boolean') {
        return profile.compatibility[entry.builtInAgentId] === true;
    }

    if (typeof profile.compatibility?.[entry.providerAgentId] === 'boolean') {
        return profile.compatibility[entry.providerAgentId] === true;
    }

    return profile.isBuiltIn ? false : entry.family === 'builtInAgent';
}

export function stripLegacyProviderSentinelTargetKeys<TValue>(
    record: ProfileTargetValueRecord<TValue>,
    entries: readonly ResolvedBackendCatalogEntry[],
): Record<string, TValue | undefined> {
    const next = { ...(record ?? {}) };
    for (const entry of entries) {
        const legacyProviderSentinelTargetKey = getLegacyProviderSentinelTargetKey(entry);
        if (!legacyProviderSentinelTargetKey) continue;
        delete next[legacyProviderSentinelTargetKey];
    }
    return next;
}
