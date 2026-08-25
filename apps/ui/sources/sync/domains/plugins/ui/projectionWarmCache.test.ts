import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { PluginUiTargetedContributionsV1Schema } from '@happier-dev/protocol/plugins/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        getAllKeys() {
            return [...store.keys()];
        }

        trim() {}
    }

    return { MMKV };
});

import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';

import {
    loadPluginUiProjectionWarmCacheEntries,
    savePluginUiProjectionWarmCacheEntries,
} from '@/sync/domains/state/warmCachePersistence';

import {
    forgetPluginUiProjectionAdmissionSnapshots,
    pluginUiProjectionAdmissionTargetKey,
    readPluginUiProjectionTargetedAdmissionSnapshot,
    savePluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionTargetedAdmissionSnapshot,
} from './projectionWarmCache';

const ACCOUNT_A = { serverId: 'server-a', accountId: 'account-a' } as const;
const ACCOUNT_B = { serverId: 'server-a', accountId: 'account-b' } as const;
const MACHINE_ID = 'machine-1';
const TARGET_KEY = pluginUiProjectionAdmissionTargetKey({ serverId: 'server-1', machineId: MACHINE_ID });

function projectionAtGeneration(immutableGenerationId: string, generation: number) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation,
        installedPackagesById: {
            'acme.browser': {
                id: 'acme.browser',
                displayName: 'Browser Inspector',
                version: '3.2.1',
                enabled: true,
                source: { kind: 'bundled', locator: 'acme.browser' },
                immutableGenerationId,
                brand: { state: 'missing' },
            },
        },
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.browser': {
                        id: 'translations:acme.browser',
                        pluginId: 'acme.browser',
                        contributionKind: 'translations',
                        locales: ['en'],
                        bundles: { en: { title: 'Browser Inspector' } },
                    },
                },
            },
        },
    });
}

/**
 * A retained target admission is only useful as a positive fact, so the
 * fixture carries one admitted point. `emptyTargetedContributionsFor` is the
 * live-but-not-retainable shape: schema-valid, and never offline authority.
 */
function targetedContributionsFor(immutableGenerationId: string) {
    return PluginUiTargetedContributionsV1Schema.parse({
        target: { pluginId: 'acme.browser', immutableGenerationId },
        points: [{
            pointId: 'review-detail',
            protocols: [{
                protocol: { id: 'review/detail', version: 1 },
                contributions: [{
                    contributor: {
                        pluginId: 'acme.review',
                        contributionId: 'detail',
                        immutableGenerationId: 'review-generation-a',
                    },
                    protocol: { id: 'review/detail', version: 1 },
                    operations: [],
                    surfaces: [],
                }],
            }],
        }],
    });
}

function emptyTargetedContributionsFor(immutableGenerationId: string) {
    return PluginUiTargetedContributionsV1Schema.parse({
        target: { pluginId: 'acme.browser', immutableGenerationId },
        points: [],
    });
}

describe('plugin UI projection admission custody', () => {
    beforeEach(async () => {
        // Nothing reads or writes device custody until its at-rest key resolves,
        // exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        store.clear();
        forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
        forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_B);
    });

    it('refuses a target admission the retained presentation slice does not admit', () => {
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-a', 77),
        });

        // A response for a generation this Account's retained slice never
        // admitted is not custody-worthy, so nothing is recorded for it.
        savePluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            targetedContributions: targetedContributionsFor('browser-generation-unadmitted'),
        });
        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-unadmitted' },
        })).toBeNull();

        // The admitted generation from the same response is recorded, so the
        // refusal above is a real comparison and not a blanket rejection.
        const admitted = targetedContributionsFor('browser-generation-a');
        savePluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            targetedContributions: admitted,
        });
        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-a' },
        })).toEqual(admitted);
    });

    it('carries a recorded admission through a machine-wide refresh but never restores it for a superseded generation', () => {
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-a', 77),
        });
        const admitted = targetedContributionsFor('browser-generation-a');
        savePluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            targetedContributions: admitted,
        });

        // The machine-wide describe re-runs on every reconnect. It must not wipe
        // the admission, or a fresh offline process would have nothing to mount.
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-a', 78),
        });
        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-a' },
        })).toEqual(admitted);

        // The plugin is then upgraded while a daemon is reachable. The carried
        // admission is now superseded, and the offline mount derives its target
        // from the newly retained package row — which this admission cannot
        // prove. This is the one guard that makes carrying it forward safe.
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-b', 79),
        });
        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-b' },
        })).toBeNull();
    });

    it('restores the admission in a genuinely fresh process that only has the persisted bytes', async () => {
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-a', 77),
        });
        const admitted = targetedContributionsFor('browser-generation-a');
        savePluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            targetedContributions: admitted,
        });

        // A live process answers this read out of the warm cache's in-memory
        // value map, which hands back the very object that was saved. That
        // would make a cold-start claim vacuous, so drop the whole module
        // registry: only the persisted bytes survive into the next process.
        vi.resetModules();
        const fresh = await import('./projectionWarmCache');
        const { prepareWarmCacheEncryptionKey: prepareFresh } = await import(
            '@/sync/domains/state/warmCacheEncryptionKey'
        );
        await prepareFresh();

        const restored = fresh.readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-a' },
        });
        expect(restored).toEqual(admitted);
        expect(restored).not.toBe(admitted);
    });

    it('retires the retained target row when the current response admits no points', () => {
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-a', 77),
        });
        savePluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            targetedContributions: targetedContributionsFor('browser-generation-a'),
        });

        // An empty point list is valid live data, but it is not a retainable
        // positive admission. Declining the write alone would leave the older
        // nonempty row acting as authority, so the row is removed.
        savePluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            targetedContributions: emptyTargetedContributionsFor('browser-generation-a'),
        });

        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-a' },
        })).toBeNull();
        // The row is physically gone rather than replaced by an empty envelope,
        // while the presentation slice is a separate retained fact and survives.
        const entry = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)[TARGET_KEY];
        expect(entry).toMatchObject({ machineId: MACHINE_ID });
        expect(entry?.targetedContributionsByPluginId?.['acme.browser']).toBeUndefined();
    });

    it('refuses an already-persisted empty target row rather than restoring it', () => {
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-a', 77),
        });
        const entries = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
        const entry = entries[TARGET_KEY];
        if (!entry) throw new Error('Expected a retained presentation slice.');
        // Bytes an earlier build could already have written to this device.
        savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, {
            ...entries,
            [TARGET_KEY]: {
                ...entry,
                targetedContributionsByPluginId: {
                    'acme.browser': emptyTargetedContributionsFor('browser-generation-a'),
                },
            },
        });

        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-a' },
        })).toBeNull();
    });

    it('never lends one Account admission to another Account on the same server and machine', () => {
        savePluginUiProjectionAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            projection: projectionAtGeneration('browser-generation-a', 77),
        });
        savePluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            targetedContributions: targetedContributionsFor('browser-generation-a'),
        });

        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_B,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', immutableGenerationId: 'browser-generation-a' },
        })).toBeNull();
    });
});
