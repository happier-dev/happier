import {
    BackendTargetKeySchema,
    buildBackendTargetKey,
    convertBackendTargetRefV2ToV1,
} from '@happier-dev/protocol';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { isAgentId } from '@/agents/catalog/catalog';

type ProfileTargetValueRecord<TValue> = Readonly<Record<string, TValue | undefined>> | null | undefined;

export function resolveProfileBackendTargetKeyForEntry(entry: ResolvedBackendCatalogEntry): string {
    return buildBackendTargetKey(convertBackendTargetRefV2ToV1(entry.backendTarget));
}

export function readProfileTargetKeyValueForEntry<TValue>(
    record: ProfileTargetValueRecord<TValue>,
    entry: ResolvedBackendCatalogEntry,
): TValue | undefined {
    return record?.[resolveProfileBackendTargetKeyForEntry(entry)];
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

    if (isAgentId(entry.providerId) && typeof profile.compatibility?.[entry.providerId] === 'boolean') {
        return profile.compatibility[entry.providerId] === true;
    }

    return profile.isBuiltIn ? false : entry.kind === 'builtInAgent';
}

export function stripLegacyProviderSentinelTargetKeys<TValue>(
    record: ProfileTargetValueRecord<TValue>,
    entries: readonly ResolvedBackendCatalogEntry[],
): Record<string, TValue | undefined> {
    void entries;
    if (!record || typeof record !== 'object') {
        return {};
    }

    const out: Record<string, TValue | undefined> = {};
    for (const [rawKey, value] of Object.entries(record)) {
        if (BackendTargetKeySchema.safeParse(rawKey).success) {
            out[rawKey] = value;
        }
    }
    return out;
}
