import { beforeEach, describe, expect, it, vi } from 'vitest';

import { computePluginUiArtifactFileSetSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiPersistentArtifactIdentity } from '@/sync/domains/plugins/ui/artifactByteCache';

const fixtures = vi.hoisted(() => ({
    cache: null as unknown,
    lifetime: null as unknown,
}));

vi.mock('@/components/plugins/reactNative/bundleCache', () => ({
    getInstalledPluginReactNativeBundleCache: () => {
        if (!fixtures.cache) throw new Error('Expected an Availability cache fixture.');
        return fixtures.cache;
    },
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>();
    return {
        ...actual,
        captureActiveServerAccountScopeLifetime: () => fixtures.lifetime,
    };
});

import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
} from './projection';
import type { PluginAccountAvailabilitySnapshot } from './reader';

const scope: ServerAccountScope = Object.freeze({ serverId: 'srv-local-a', accountId: 'account-a' });
const slot = Object.freeze({
    pluginId: 'com.acme.fixture',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});

function snapshotWith(input: Readonly<{
    availabilityCursor: number;
    /** Absent means the Account no longer names any release for the plugin. */
    version?: string;
    enabled?: boolean;
}>): PluginAccountAvailabilitySnapshot {
    if (!input.version) {
        return Object.freeze({
            availabilityCursor: input.availabilityCursor,
            intentReads: Object.freeze([]),
            materializations: Object.freeze([]),
            snapshots: Object.freeze([]),
        });
    }
    const entryBytes = new TextEncoder().encode(`<!doctype html><!-- ${input.version} -->`);
    const digest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: 'index.html', bytes: entryBytes },
    ]);
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: input.availabilityCursor,
        hostingCapability: { enabled: false },
        intent: {
            pluginId: slot.pluginId,
            desiredVersion: input.version,
            enabled: input.enabled ?? true,
            offlineUiHosting: 'disabled',
            writableCollections: [],
            revision: `intent-${input.version}`,
        },
        release: {
            ref: { pluginId: slot.pluginId, version: input.version },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: slot.pluginId,
                version: input.version,
                displayName: 'Fixture',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                contributes: {},
            },
            collectionContracts: [],
            uiSlots: [{
                contributionId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: digest,
                compatibility: { hostUiApiVersion: '1.0.0' },
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        },
        uiArtifacts: [],
    });
    return Object.freeze({
        availabilityCursor: input.availabilityCursor,
        intentReads: Object.freeze([{ pluginId: slot.pluginId, response }]),
        materializations: Object.freeze([]),
        snapshots: Object.freeze([]),
    });
}

function installFixtures() {
    const removePersistentArtifact = vi.fn(async (
        _identity: PluginUiPersistentArtifactIdentity,
        _isCurrent?: () => boolean,
    ) => undefined);
    const removePersistentArtifactsForAccount = vi.fn(async (_scope: ServerAccountScope) => undefined);
    fixtures.cache = {
        bindAccountLifetime: vi.fn(),
        removePersistentArtifact,
        removePersistentArtifactsForAccount,
    };
    fixtures.lifetime = Object.freeze({
        scope,
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => {} }),
    });
    return { removePersistentArtifact, removePersistentArtifactsForAccount };
}

describe('Availability projection artifact retention', () => {
    beforeEach(() => {
        // Drop the lifetime first: the writer retains a cleared predecessor only
        // while its Account lifetime is still current, so clearing with the
        // previous test's lifetime installed would carry that snapshot forward.
        fixtures.cache = null;
        fixtures.lifetime = null;
        clearPluginAccountAvailabilityProjection();
    });

    it('retains A across A -> B -> A rather than deleting it when the projection names B', () => {
        // Ordinary projection replacement is not a deletion authority: retiring
        // reachability is what stops A from being used while B is current, and
        // returning to A must not cost a full re-download (PEP master decision
        // 9; PEP-ARTIFACTS 8.2).
        const cache = installFixtures();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2, version: '2.0.0' }),
        });
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 3, version: '1.2.3' }),
        });

        expect(cache.removePersistentArtifact).not.toHaveBeenCalled();
        expect(cache.removePersistentArtifactsForAccount).not.toHaveBeenCalled();
    });

    it('retains the withdrawn entry across the clear the refresh performs first', () => {
        const cache = installFixtures();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });

        // Every level-triggered AccountChange withdraws the projection before its
        // one coalesced refresh replaces it. Withdrawal retires reachability; the
        // bytes stay inert until logout, forget, explicit clear or corruption.
        clearPluginAccountAvailabilityProjection();
        expect(cache.removePersistentArtifact).not.toHaveBeenCalled();

        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2 }),
        });

        expect(cache.removePersistentArtifact).not.toHaveBeenCalled();
        expect(cache.removePersistentArtifactsForAccount).not.toHaveBeenCalled();
    });

    it('retains the entry when the Account disables the plugin but still names its release', () => {
        // Disable prevents new invocation and renderer adoption while retaining
        // the bounded archives (PEP-ARTIFACTS 10.1); re-enabling must not cost a
        // full re-download.
        const cache = installFixtures();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2, version: '1.2.3', enabled: false }),
        });

        expect(cache.removePersistentArtifact).not.toHaveBeenCalled();
    });

    it('retains the entry when the same release survives the clear and refresh', () => {
        const cache = installFixtures();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 1, version: '1.2.3' }),
        });
        clearPluginAccountAvailabilityProjection();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWith({ availabilityCursor: 2, version: '1.2.3' }),
        });

        expect(cache.removePersistentArtifact).not.toHaveBeenCalled();
        expect(cache.removePersistentArtifactsForAccount).not.toHaveBeenCalled();
    });
});
