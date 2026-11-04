import { PluginProjectionV2Schema, type PluginSourceCustodyV1 } from '@happier-dev/protocol';
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
import * as projectionNormalizer from './projection';
import { resolvePluginUiTranslationText } from './i18n';

import {
    loadPluginUiProjectionWarmCacheEntries,
    preparePluginUiProjectionWarmCacheEntries,
    savePluginUiProjectionWarmCacheEntries,
} from '@/sync/domains/state/warmCachePersistence';

import {
    forgetPluginUiProjectionAdmissionSnapshots,
    pluginUiProjectionAdmissionTargetKey,
    readPluginUiProjectionTargetedAdmissionSnapshot,
    readPluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionTargetedAdmissionSnapshot,
} from './projectionWarmCache';

const ACCOUNT_A = { serverId: 'server-a', accountId: 'account-a' } as const;
const ACCOUNT_B = { serverId: 'server-a', accountId: 'account-b' } as const;
const MACHINE_ID = 'machine-1';
const TARGET_KEY = pluginUiProjectionAdmissionTargetKey({ serverId: 'server-1', machineId: MACHINE_ID });

it('serializes retained plugin UI state only when published content changes', async () => {
    await prepareWarmCacheEncryptionKey();
    store.clear();
    forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
    const entry = { machineId: MACHINE_ID, projection: projectionAtGeneration('unchanged-cache', 77) };
    savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, { [TARGET_KEY]: entry });
    const previous = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
    // Raw equal replacements still pass through native-JSON admission. Equality
    // must retain the publication before normalization and whole-fleet encoding.
    const replacements = Array.from({ length: 100 }, () => ({
        [TARGET_KEY]: { machineId: MACHINE_ID, projection: projectionAtGeneration('unchanged-cache', 77) },
    }));
    const normalize = vi.spyOn(projectionNormalizer, 'normalizePluginUiProjection');
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
        for (const replacement of replacements) {
            savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, replacement);
        }
        expect(stringify).not.toHaveBeenCalled();
        expect(normalize).not.toHaveBeenCalled();
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)).toBe(previous);
        const changed = { [TARGET_KEY]: { ...entry, projection: { ...entry.projection, generation: 78 } } };
        savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, changed);
        expect(normalize).toHaveBeenCalledTimes(1);
        expect(stringify.mock.calls.some(([value]) => value !== null && typeof value === 'object' && TARGET_KEY in value)).toBe(true);
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)[TARGET_KEY]?.projection.generation).toBe(78);
        const ownedEntries = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
        const callerEntries: typeof ownedEntries = { ...ownedEntries, other: ownedEntries[TARGET_KEY]! };
        savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, callerEntries);
        delete callerEntries.other;
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId).other).toBe(ownedEntries[TARGET_KEY]);
        savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, {});
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)).toEqual({});
    } finally {
        normalize.mockRestore();
        stringify.mockRestore();
    }
});

it('retains equal target admissions but snapshots caller-owned target data before comparing replacements', async () => {
    await prepareWarmCacheEncryptionKey();
    store.clear();
    forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
    const occurrenceId = 'target-cache';
    const projection = projectionAtGeneration(occurrenceId, 1);
    savePluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID, projection });
    const raw = targetedContributionsFor(occurrenceId);
    savePluginUiProjectionTargetedAdmissionSnapshot({ scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID,
        targetedContributions: raw });
    const previous = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
    const equal = targetedContributionsFor(occurrenceId);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
        for (let index = 0; index < 100; index += 1) {
            savePluginUiProjectionTargetedAdmissionSnapshot({ scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID,
                targetedContributions: equal });
        }
        expect(stringify).not.toHaveBeenCalled();
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)).toBe(previous);
        raw.points.length = 0;
        expect(previous[TARGET_KEY]?.targetedContributionsByPluginId?.['acme.browser']?.points).toHaveLength(1);
        savePluginUiProjectionTargetedAdmissionSnapshot({ scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID,
            targetedContributions: raw });
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)[TARGET_KEY]
            ?.targetedContributionsByPluginId?.['acme.browser']).toBeUndefined();
    } finally {
        stringify.mockRestore();
    }
});

it('builds translation pooling keys once per changed immutable bundle, not per generation', async () => {
    await prepareWarmCacheEncryptionKey();
    store.clear();
    forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
    savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, {
        [TARGET_KEY]: { machineId: MACHINE_ID, projection: projectionAtGeneration('bundle-cache', 1) },
        other: { machineId: 'machine-2', projection: projectionAtGeneration('bundle-cache', 1) },
    });
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
        for (let generation = 2; generation <= 101; generation += 1) {
            const entries = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
            const entry = entries[TARGET_KEY]!;
            savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, {
                ...entries, [TARGET_KEY]: { ...entry, projection: { ...entry.projection, generation } },
            });
        }
        const bundleKeyCalls = () => stringify.mock.calls.filter(([value]) => value !== null && typeof value === 'object' && 'en' in value).length;
        expect(bundleKeyCalls()).toBe(0);
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)[TARGET_KEY]?.projection.generation).toBe(101);
        const entries = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
        const replacement = projectionAtGeneration('bundle-cache', 102);
        const translations = replacement.familiesById.pluginUi!.entriesById['translations:acme.browser'];
        if (translations?.contributionKind !== 'translations') throw new Error('Expected translation fixture');
        if (!translations.bundles || typeof translations.bundles !== 'object') throw new Error('Expected translation bundles');
        Reflect.set(translations.bundles, 'en', { title: 'Changed title' });
        savePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId, {
            ...entries, [TARGET_KEY]: { machineId: MACHINE_ID, projection: replacement },
        });
        expect(bundleKeyCalls()).toBe(1);
    } finally { stringify.mockRestore(); }
});

it('publishes retained presentation before reads and observes replacement, platform and retirement', async () => {
    await prepareWarmCacheEncryptionKey();
    store.clear();
    forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
    savePluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID,
        projection: projectionAtGeneration('retained-perf-a', 77) });
    const normalize = vi.spyOn(projectionNormalizer, 'normalizePluginUiProjection');
    try {
        const input = { scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID, platform: projectionNormalizer.resolvePluginUiProjectionPlatform() };
        preparePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
        const first = readPluginUiProjectionAdmissionSnapshot(input);
        expect(first).not.toBeNull();
        const entries = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
        const repeated = Array.from({ length: 100 }, () => {
            // Every newly bound credential reader prepares this same exact scope before publication.
            preparePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
            expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)).toBe(entries);
            return readPluginUiProjectionAdmissionSnapshot(input);
        });
        expect(normalize).not.toHaveBeenCalled();
        expect(repeated.every(value => value === first)).toBe(true);
        expect(readPluginUiProjectionAdmissionSnapshot({ ...input, platform: input.platform === 'ios' ? 'web' : 'ios' })).toBeNull();
        expect(readPluginUiProjectionAdmissionSnapshot({ ...input, scope: ACCOUNT_B })).toBeNull();
        savePluginUiProjectionAdmissionSnapshot({ ...input, projection: projectionAtGeneration('retained-perf-b', 78) });
        expect(readPluginUiProjectionAdmissionSnapshot(input)).not.toBe(first);
        forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
        expect(readPluginUiProjectionAdmissionSnapshot(input)).toBeNull();
    } finally {
        normalize.mockRestore();
    }
});

function managedSourceCustody(immutableGenerationId: string): PluginSourceCustodyV1 {
    return { kind: 'managed', immutableGenerationId, installSource: 'archive' };
}

function immutableGenerationForOccurrence(occurrenceId: string): string {
    return `artifact-for:${occurrenceId}`;
}

function projectionAtGeneration(occurrenceId: string, generation: number) {
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
                immutableGenerationId: immutableGenerationForOccurrence(occurrenceId),
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
                        occurrenceId,
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
function targetedContributionsFor(occurrenceId: string) {
    return PluginUiTargetedContributionsV1Schema.parse({
        target: {
            pluginId: 'acme.browser',
            occurrenceId,
            sourceCustody: managedSourceCustody(immutableGenerationForOccurrence(occurrenceId)),
        },
        points: [{
            pointId: 'review-detail',
            protocols: [{
                protocol: { id: 'review/detail', version: 1 },
                contributions: [{
                    contributor: {
                        pluginId: 'acme.review',
                        contributionId: 'detail',
                        occurrenceId: 'review-generation-a',
                        sourceCustody: managedSourceCustody('review-generation-a'),
                    },
                    protocol: { id: 'review/detail', version: 1 },
                    operations: [],
                    surfaces: [],
                }],
            }],
        }],
    });
}

function emptyTargetedContributionsFor(occurrenceId: string) {
    return PluginUiTargetedContributionsV1Schema.parse({
        target: {
            pluginId: 'acme.browser',
            occurrenceId,
            sourceCustody: managedSourceCustody(immutableGenerationForOccurrence(occurrenceId)),
        },
        points: [],
    });
}

it('only supplies retained presentation for the exact previously admitted mounted target', async () => {
    await prepareWarmCacheEncryptionKey();
    store.clear();
    forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
    savePluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID,
        projection: projectionAtGeneration('continuity-a', 91) });
    const admission = targetedContributionsFor('continuity-a');
    savePluginUiProjectionTargetedAdmissionSnapshot({ scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID,
        targetedContributions: admission });
    const input = { scope: ACCOUNT_A, targetKey: TARGET_KEY, machineId: MACHINE_ID, target: admission.target };
    const presentation = readPluginUiProjectionAdmissionSnapshot(input);
    expect(presentation?.generation).toBe(91);
    expect(readPluginUiProjectionAdmissionSnapshot({ ...input, target: { ...admission.target, occurrenceId: 'continuity-b' } })).toBeNull();
    expect(readPluginUiProjectionAdmissionSnapshot({ ...input, target: { ...admission.target,
        sourceCustody: managedSourceCustody('different-artifact') } })).toBeNull();
    expect(readPluginUiProjectionAdmissionSnapshot({ ...input, scope: ACCOUNT_B })).toBeNull();
    expect(readPluginUiProjectionAdmissionSnapshot(input)).toBe(presentation);
});

describe('plugin UI projection admission custody', () => {
    beforeEach(async () => {
        // Nothing reads or writes device custody until its at-rest key resolves,
        // exactly as on a device.
        await prepareWarmCacheEncryptionKey();
        store.clear();
        forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_A);
        forgetPluginUiProjectionAdmissionSnapshots(ACCOUNT_B);
    });

    it('stores shared translation bytes once and restores every Machine and locale in a fresh process', async () => {
        const base = projectionAtGeneration('browser-generation-a', 77);
        const projection = PluginProjectionV2Schema.parse({ ...base, familiesById: { pluginUi: {
            ...base.familiesById.pluginUi,
            entriesById: { 'translations:acme.browser': { ...base.familiesById.pluginUi?.entriesById['translations:acme.browser'],
                locales: ['en', 'fr', 'de'], bundles: { en: { title: 'English', fallback: 'Fallback', description: 'Warm presentation data '.repeat(1000) }, fr: { title: 'Français' }, de: { title: 'Deutsch' } },
            } },
        } } });
        const machines = ['one', 'two', 'three'];
        for (const machineId of machines) {
            const targetKey = pluginUiProjectionAdmissionTargetKey({ serverId: ACCOUNT_A.serverId, machineId });
            savePluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A, targetKey, machineId, projection });
        }
        const uncompressed = loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
        const key = `plugin-ui-projection-warm-cache-v1:${ACCOUNT_A.serverId}:${ACCOUNT_A.accountId}`;
        const serialized = store.get(key)!;
        const translations = projection.familiesById.pluginUi?.entriesById['translations:acme.browser'];
        if (translations?.contributionKind !== 'translations') throw new Error('Expected translation projection');
        // Saving one complete duplicate bundle's bytes is material to browser storage, not formatting.
        expect(serialized.length).toBeLessThan(JSON.stringify(uncompressed).length - JSON.stringify(translations.bundles).length);
        vi.resetModules();
        const fresh = await import('./projectionWarmCache');
        await (await import('@/sync/domains/state/warmCacheEncryptionKey')).prepareWarmCacheEncryptionKey();
        const persistence = await import('@/sync/domains/state/warmCachePersistence');
        const { createStoredReadSchema } = await import('@happier-dev/protocol/json/storedReadSchema');
        // Observe the real canonical admission, including its nested checks. The compact storage
        // envelope must be unpacked first, so each complete Machine entry is admitted only once.
        const admit = vi.spyOn(createStoredReadSchema(persistence.PluginUiProjectionCacheEntryV1Schema)._zod, 'run');
        try {
            persistence.preparePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
            expect(admit).toHaveBeenCalledTimes(machines.length);
            persistence.preparePluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId);
            expect(admit).toHaveBeenCalledTimes(machines.length);
        } finally {
            admit.mockRestore();
        }
        for (const machineId of machines) {
            const targetKey = fresh.pluginUiProjectionAdmissionTargetKey({ serverId: ACCOUNT_A.serverId, machineId });
            const restored = fresh.readPluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A, targetKey, machineId });
            expect(resolvePluginUiTranslationText({ projection: restored, pluginId: 'acme.browser', key: 'title', locale: 'fr' })).toBe('Français');
            expect(resolvePluginUiTranslationText({ projection: restored, pluginId: 'acme.browser', key: 'title', locale: 'de' })).toBe('Deutsch');
            expect(resolvePluginUiTranslationText({ projection: restored, pluginId: 'acme.browser', key: 'fallback', locale: 'fr' })).toBe('Fallback');
        }
        for (const machineId of machines) {
            const targetKey = fresh.pluginUiProjectionAdmissionTargetKey({ serverId: ACCOUNT_A.serverId, machineId });
            fresh.savePluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A, targetKey, machineId,
                projection: projectionAtGeneration('browser-generation-b', 78) });
        }
        expect(store.get(key)).not.toContain('Warm presentation data '.repeat(1000));
        const replacedSize = store.get(key)!.length;
        fresh.savePluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A,
            targetKey: fresh.pluginUiProjectionAdmissionTargetKey({ serverId: ACCOUNT_A.serverId, machineId: 'one' }), machineId: 'one',
            projection: projectionAtGeneration('browser-generation-b', 78) });
        expect(store.get(key)!.length).toBe(replacedSize);
        const corrupt = JSON.parse(serialized);
        corrupt.translationBundleRefs[Object.keys(corrupt.entries)[0]]['translations:acme.browser'] = corrupt.translationBundles.length;
        store.set(key, JSON.stringify(corrupt));
        expect(fresh.readPluginUiProjectionAdmissionSnapshot({ scope: ACCOUNT_A,
            targetKey: fresh.pluginUiProjectionAdmissionTargetKey({ serverId: ACCOUNT_A.serverId, machineId: 'one' }), machineId: 'one', platform: 'web' })).toBeNull();
        expect(store.has(key)).toBe(false);
        const invalidProjection = JSON.parse(serialized);
        invalidProjection.entries[Object.keys(invalidProjection.entries)[0]].projection.generation = 'invalid';
        store.set(key, JSON.stringify(invalidProjection));
        // Envelope reconstruction is not admission: malformed known projection fields
        // still fail the canonical schema before any presentation is published.
        expect(persistence.loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)).toEqual({});
        expect(store.has(key)).toBe(false);
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
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-unadmitted' },
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
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-a' },
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
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-a' },
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
        expect(loadPluginUiProjectionWarmCacheEntries(ACCOUNT_A.serverId, ACCOUNT_A.accountId)[TARGET_KEY]?.targetedContributionsByPluginId?.['acme.browser']).toBeUndefined();
        expect(readPluginUiProjectionTargetedAdmissionSnapshot({
            scope: ACCOUNT_A,
            targetKey: TARGET_KEY,
            machineId: MACHINE_ID,
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-b' },
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
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-a' },
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
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-a' },
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
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-a' },
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
            target: { pluginId: 'acme.browser', occurrenceId: 'browser-generation-a' },
        })).toBeNull();
    });
});
