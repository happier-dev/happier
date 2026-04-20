import { describe, expect, it } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import {
    isProfileCompatibleWithResolvedBackendEntry,
    readProfileTargetKeyValueForEntry,
    resolveProfileBackendTargetKeyForEntry,
    stripLegacyProviderSentinelTargetKeys,
} from './profileBackendEntryStorage';

const pluginBackendEntry: ResolvedBackendCatalogEntry = {
    backendTarget: { kind: 'backend', backendId: 'acme.review.backend' },
    backendTargetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'acme.review.backend' }),
    kind: 'pluginBackend',
    backendId: 'acme.review.backend',
    providerId: 'acme.review.provider',
    providerAgentId: 'claude',
    builtInAgentId: null,
    iconAgentId: 'claude',
    title: 'Acme Review Backend',
    subtitle: 'Plugin-backed review engine',
};

describe('profileBackendEntryStorage', () => {
    it('reads explicit compatibility by backend target key', () => {
        const profileTargetKey = resolveProfileBackendTargetKeyForEntry(pluginBackendEntry);
        expect(readProfileTargetKeyValueForEntry(
            {
                [profileTargetKey]: true,
            },
            pluginBackendEntry,
        )).toBe(true);
    });

    it('treats explicit compatibility as authoritative for plugin backends', () => {
        const profileTargetKey = resolveProfileBackendTargetKeyForEntry(pluginBackendEntry);
        expect(isProfileCompatibleWithResolvedBackendEntry(
            {
                compatibility: {},
                compatibilityByTargetKey: { [profileTargetKey]: true },
                isBuiltIn: false,
            },
            pluginBackendEntry,
        )).toBe(true);
    });

    it('returns a shallow copy when asked to strip legacy target-key sentinels', () => {
        const profileTargetKey = resolveProfileBackendTargetKeyForEntry(pluginBackendEntry);
        expect(stripLegacyProviderSentinelTargetKeys(
            {
                [pluginBackendEntry.backendTargetKey]: true,
                [profileTargetKey]: true,
            },
            [pluginBackendEntry],
        )).toEqual({
            [profileTargetKey]: true,
        });
    });
});
