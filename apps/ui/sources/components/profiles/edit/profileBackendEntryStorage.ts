import {
    buildBackendTargetKey,
    buildBackendTargetKeyV2,
    convertBackendTargetRefV2ToV1,
    readBackendTargetRefV2,
    type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { isAgentId } from '@/agents/catalog/catalog';

type ProfileTargetValueRecord<TValue> = Readonly<Record<string, TValue | undefined>> | null | undefined;

export function resolveProfileBackendTargetKeyForEntry(entry: ResolvedBackendCatalogEntry): string {
    return buildBackendTargetKeyV2(entry.backendTarget);
}

export function readProfileTargetKeyValueForEntry<TValue>(
    record: ProfileTargetValueRecord<TValue>,
    entry: ResolvedBackendCatalogEntry,
): TValue | undefined {
    const canonical = record?.[resolveProfileBackendTargetKeyForEntry(entry)];
    if (canonical !== undefined) return canonical;
    const legacyKey = buildBackendTargetKey(convertBackendTargetRefV2ToV1(entry.backendTarget));
    return record?.[legacyKey];
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

    if (isAgentId(entry.agentId) && typeof profile.compatibility?.[entry.agentId] === 'boolean') {
        return profile.compatibility[entry.agentId] === true;
    }

    return profile.isBuiltIn ? false : entry.kind === 'builtInAgent';
}

export function stripLegacyProviderSentinelTargetKeys<TValue>(
    record: ProfileTargetValueRecord<TValue>,
    entries: readonly ResolvedBackendCatalogEntry[],
): Record<string, TValue> {
    void entries;
    if (!record || typeof record !== 'object') {
        return {};
    }

    const out: Record<string, TValue> = {};
    for (const [rawKey, value] of Object.entries(record)) {
        if (value === undefined) continue;
        try {
            const canonicalKey = buildBackendTargetKeyV2(
                readBackendTargetRefV2(rawKey as BackendTargetRefV2Input),
            );
            out[canonicalKey] = value;
        } catch {
            // Unsupported compatibility sentinels are not durable target identities.
        }
    }
    return out;
}
