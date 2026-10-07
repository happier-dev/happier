import { buildBackendTargetKey } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { buildBackendTargetKeyV2, convertBackendTargetRefV2ToV1, readBackendTargetRefV2, type BackendTargetRefV2Input } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { isProfileCompatibleWithBackendTarget } from '@/sync/domains/profiles/profileCompatibility';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

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
    let legacyKey: string | null = null;
    if (entry.builtInAgentId) {
        legacyKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: entry.builtInAgentId });
    } else if (entry.backendTarget.kind === 'backend') {
        legacyKey = buildBackendTargetKey(convertBackendTargetRefV2ToV1(entry.backendTarget));
    }
    if (!legacyKey) return undefined;
    return record?.[legacyKey];
}

export function isProfileCompatibleWithResolvedBackendEntry(
    profile: Pick<AIBackendProfile, 'compatibility' | 'compatibilityByTargetKey' | 'isBuiltIn'>,
    entry: ResolvedBackendCatalogEntry,
): boolean {
    return isProfileCompatibleWithBackendTarget(profile, entry.backendTarget);
}

export function stripLegacyProviderSentinelTargetKeys<TValue>(
    record: ProfileTargetValueRecord<TValue>,
    entries: readonly ResolvedBackendCatalogEntry[],
): Record<string, TValue> {
    if (!record || typeof record !== 'object') {
        return {};
    }

    const currentTargetKeys = new Set(entries.map(resolveProfileBackendTargetKeyForEntry));
    const out: Record<string, TValue> = {};
    for (const [rawKey, value] of Object.entries(record)) {
        if (value === undefined) continue;
        if (currentTargetKeys.has(rawKey)) {
            out[rawKey] = value;
            continue;
        }
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
