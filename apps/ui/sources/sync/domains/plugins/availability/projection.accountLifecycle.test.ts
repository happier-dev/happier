import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const fixture = vi.hoisted(() => ({
    cache: null as unknown,
    lifetime: null as unknown,
}));

vi.mock('@/components/plugins/reactNative/bundleCache', () => ({
    getInstalledPluginReactNativeBundleCache: () => {
        if (!fixture.cache) throw new Error('Expected an Availability cache fixture.');
        return fixture.cache;
    },
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>();
    return {
        ...actual,
        captureActiveServerAccountScopeLifetime: () => fixture.lifetime,
    };
});

import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import {
    readPluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

import {
    clearPluginAccountAvailabilityProjection,
    forgetPluginAccountAvailabilityArtifacts,
    replacePluginAccountAvailabilityProjection,
} from './projection';
import type { PluginAccountAvailabilitySnapshot } from './reader';

const scope: ServerAccountScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });

const emptySnapshot: PluginAccountAvailabilitySnapshot = Object.freeze({
    availabilityCursor: 1,
    intentReads: Object.freeze([]),
    materializations: Object.freeze([]),
    snapshots: Object.freeze([]),
});

function createCacheFixture() {
    const removePersistentArtifactsForAccount = vi.fn(async () => undefined);
    const removePersistentArtifact = vi.fn(async () => undefined);
    let retire: (() => void) | null = null;
    const cache = {
        bindAccountLifetime: vi.fn((lifetime: Readonly<{
            scope: ServerAccountScope;
            isCurrent: () => boolean;
            onRetire: (cancel: () => void) => Readonly<{ dispose: () => void }>;
        }>) => {
            lifetime.onRetire(() => {
                // The cache owner's own retirement path: it evicts and retires
                // reachability. It deliberately does not delete bytes.
            });
        }),
        removePersistentArtifact,
        removePersistentArtifactsForAccount,
    };
    return {
        cache,
        removePersistentArtifactsForAccount,
        retireAccountLifetime: () => retire?.(),
        setRetire: (fn: () => void) => { retire = fn; },
    };
}

function createLifetimeFixture(cacheFixture: ReturnType<typeof createCacheFixture>) {
    let current = true;
    return Object.freeze({
        scope,
        isCurrent: () => current,
        onRetire: (cancel: () => void) => {
            cacheFixture.setRetire(() => {
                current = false;
                cancel();
            });
            return Object.freeze({ dispose: () => {} });
        },
    });
}

describe('Account artifact-byte lifecycle', () => {
    beforeEach(() => {
        clearPluginAccountAvailabilityProjection();
        fixture.cache = null;
        fixture.lifetime = null;
    });

    it('retires an Account switch without deleting its bytes and deletes them only when the Account is forgotten', () => {
        const cacheFixture = createCacheFixture();
        fixture.cache = cacheFixture.cache;
        fixture.lifetime = createLifetimeFixture(cacheFixture);

        replacePluginAccountAvailabilityProjection({ scope, snapshot: emptySnapshot });
        expect(cacheFixture.cache.bindAccountLifetime).toHaveBeenCalledTimes(1);

        // Account switch / deactivation: reachability retires immediately and
        // the Account-qualified bytes stay inert so returning to the same
        // Account does not force a full re-download.
        cacheFixture.retireAccountLifetime();
        clearPluginAccountAvailabilityProjection();
        expect(cacheFixture.removePersistentArtifactsForAccount).not.toHaveBeenCalled();

        // Logout / forget Account / explicit clear: the same bytes are deleted.
        forgetPluginAccountAvailabilityArtifacts(scope);
        expect(cacheFixture.removePersistentArtifactsForAccount).toHaveBeenCalledTimes(1);
        expect(cacheFixture.removePersistentArtifactsForAccount).toHaveBeenCalledWith(scope);
    });

    it('keeps the retained admission snapshot across a switch and drops it when the Account is forgotten', async () => {
        await prepareWarmCacheEncryptionKey();
        const cacheFixture = createCacheFixture();
        fixture.cache = cacheFixture.cache;
        fixture.lifetime = createLifetimeFixture(cacheFixture);
        const target = { targetKey: 'server-a:machine-a', machineId: 'machine-a' } as const;
        savePluginUiProjectionAdmissionSnapshot({
            scope,
            ...target,
            projection: PluginProjectionV2Schema.parse({
                v: 2,
                generation: 7,
                familiesById: {
                    pluginUi: {
                        family: 'pluginUi',
                        entriesById: {
                            'translations:acme.preview': {
                                id: 'translations:acme.preview',
                                pluginId: 'acme.preview',
                                contributionKind: 'translations',
                                locales: ['en'],
                                bundles: { en: { title: 'Retained' } },
                            },
                        },
                    },
                },
            }),
        });
        expect(readPluginUiProjectionAdmissionSnapshot({ scope, ...target })).not.toBeNull();

        // Account switch / deactivation retires reachability only.
        cacheFixture.retireAccountLifetime();
        clearPluginAccountAvailabilityProjection();
        expect(readPluginUiProjectionAdmissionSnapshot({ scope, ...target })).not.toBeNull();

        forgetPluginAccountAvailabilityArtifacts(scope);
        expect(readPluginUiProjectionAdmissionSnapshot({ scope, ...target })).toBeNull();
    });

    it('does not let a failed Account deletion escape the cache owner', async () => {
        const cacheFixture = createCacheFixture();
        cacheFixture.removePersistentArtifactsForAccount.mockRejectedValueOnce(
            new Error('cache_delete_failed'),
        );
        fixture.cache = cacheFixture.cache;
        fixture.lifetime = createLifetimeFixture(cacheFixture);

        expect(() => forgetPluginAccountAvailabilityArtifacts(scope)).not.toThrow();
        await Promise.resolve();
        expect(cacheFixture.removePersistentArtifactsForAccount).toHaveBeenCalledWith(scope);
    });
});
