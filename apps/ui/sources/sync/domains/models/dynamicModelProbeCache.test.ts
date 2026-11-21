import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';

import { getModelOptionsForAgentTypeOrPreflight, type PreflightModelList } from './modelOptions';

import {
    readDynamicModelProbeCache,
    resetDynamicModelProbeCacheForTests,
    writeDynamicModelProbeCacheSuccess,
    writeDynamicModelProbeCacheUnavailable,
    writeDynamicModelProbeCacheError,
    dynamicModelProbeRetryAt,
    isDynamicModelProbeCacheFresh,
} from './dynamicModelProbeCache';

// Native MMKV data survives new instances and module reloads; only this persistence boundary is mocked.
const persistedValues = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return persistedValues.get(key); }
        set(key: string, value: string) { persistedValues.set(key, value); }
        delete(key: string) { persistedValues.delete(key); }
    },
}));

describe('dynamic model probe cache', () => {
    afterEach(() => {
        vi.useRealTimers();
        persistedValues.clear();
    });

    it.each([
        [false, { reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' }],
        [true, { reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' }],
        [false, { reason: 'error', errorCode: 'agent_isolation_unavailable', retryable: false }],
        [true, { reason: 'error', errorCode: 'agent_isolation_unavailable', retryable: false }],
    ] as const)('never schedules unknown or nonretryable outcomes after cooldown (retained: %s, failure: %j)', (retainGood, failure) => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicModelProbeCacheForTests();
        if (retainGood) writeDynamicModelProbeCacheSuccess('unknown', {
            availableModels: [{ id: 'native', name: 'Native' }], supportsFreeform: false,
        }, 1_000);
        writeDynamicModelProbeCacheError('unknown', 2_000, undefined, failure);
        vi.setSystemTime(100_000_000);
        const entry = readDynamicModelProbeCache('unknown');
        expect(entry).toMatchObject(failure);
        expect(dynamicModelProbeRetryAt(entry)).toBeNull();
        expect(isDynamicModelProbeCacheFresh(entry)).toBe(true);
        if (retainGood) expect(entry).toMatchObject({ updatedAt: 1_000, value: { availableModels: [{ id: 'native' }] } });
    });

    it('keeps a previous successful model list visible during a transient unavailable cooldown', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicModelProbeCacheForTests();

        writeDynamicModelProbeCacheSuccess('key-1', {
            availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
            supportsFreeform: false,
        }, 1_000);

        writeDynamicModelProbeCacheUnavailable('key-1', 2_000);

        expect(readDynamicModelProbeCache('key-1')).toEqual({
            kind: 'success',
            updatedAt: 1_000,
            expiresAt: 86_401_000,
            value: {
                availableModels: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
                supportsFreeform: false,
            },
            cacheable: true,
            errorUpdatedAt: 2_000,
        });
    });

    it('shows unavailable during cooldown when no successful model list exists', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_500);
        resetDynamicModelProbeCacheForTests();

        writeDynamicModelProbeCacheUnavailable('key-1', 2_000);

        expect(readDynamicModelProbeCache('key-1')).toEqual({
            kind: 'success',
            updatedAt: 2_000,
            expiresAt: 62_000,
            value: {
                availableModels: [],
                supportsFreeform: false,
                unavailable: true,
            },
            cacheable: false,
            errorUpdatedAt: 2_000,
        });
    });

    it('honors a caller-owned shorter success max age without creating a second cache', () => {
        resetDynamicModelProbeCacheForTests();
        writeDynamicModelProbeCacheSuccess('selected-account', {
            availableModels: [{ id: 'claude-account-model', name: 'Account model' }],
            supportsFreeform: true,
        }, 1_000);

        expect(readDynamicModelProbeCache('selected-account', 5 * 60_000)).toMatchObject({
            kind: 'success', updatedAt: 1_000, expiresAt: 301_000,
        });
    });
    it('hydrates an authoritative empty catalog from persisted storage after reload', async () => {
        resetDynamicModelProbeCacheForTests();
        writeDynamicModelProbeCacheSuccess('empty-catalog', { availableModels: [], supportsFreeform: false });
        vi.resetModules();
        const reloaded = await import('./dynamicModelProbeCache');
        expect(reloaded.readDynamicModelProbeCache('empty-catalog')).toMatchObject({
            kind: 'success', value: { availableModels: [], supportsFreeform: false },
        });
    });

    it('offers the six probed Muse models for the selected connected account after reload', async () => {
        resetDynamicModelProbeCacheForTests();
        const targetKey = 'muse-connected-account';
        const modelIds = [
            'default',
            'meta/muse-wonder-1.0',
            'meta/muse-wonder-full-1.0',
            'meta/muse-ember-1.0',
            'meta/muse-spark-1.3',
            'meta/muse-spark-1.2',
        ];
        writeDynamicModelProbeCacheSuccess(targetKey, {
            availableModels: modelIds.map(id => ({ id, name: id })),
            supportsFreeform: false,
            source: 'dynamic',
        });

        vi.resetModules();
        const reloaded = await import('./dynamicModelProbeCache');
        const entry = reloaded.readDynamicModelProbeCache(targetKey);
        const options = getModelOptionsForAgentTypeOrPreflight({
            agentType: 'muse',
            connectedAccountSelected: true,
            preflight: entry?.kind === 'success' ? entry.value : null,
            preflightTargetKey: targetKey,
            currentTargetKey: targetKey,
        });
        expect(options.map(option => option.value)).toEqual(modelIds);
    });

    it('preserves explicit capabilities and keeps legacy cached rows unknown for Summary after reload', async () => {
        resetDynamicModelProbeCacheForTests();
        const value = {
            availableModels: [
                { id: 'unsupported-model', name: 'Unsupported', capabilities: { structuredOutput: 'unsupported', toolRoundTrips: 'supported', reasoningControls: 'unknown' } },
                { id: 'supported-model', name: 'Supported', capabilities: { structuredOutput: 'supported' } },
                { id: 'unknown-model', name: 'Unknown', capabilities: { structuredOutput: 'unknown' } },
                // Retained v7 probes include a capability-free default sentinel and named chat models.
                { id: 'default', name: 'Default' },
                { id: 'legacy-model', name: 'Legacy' },
                { id: 'partial-capabilities', name: 'Partial', capabilities: { toolRoundTrips: 'supported' } },
            ],
            supportsFreeform: false,
        } satisfies PreflightModelList;
        writeDynamicModelProbeCacheSuccess('capability-catalog', value);

        vi.resetModules();
        const reloaded = await import('./dynamicModelProbeCache');
        const entry = reloaded.readDynamicModelProbeCache('capability-catalog');

        expect(entry?.kind).toBe('success');
        if (entry?.kind !== 'success') throw new Error('Expected the persisted chat catalog to remain readable');
        expect(entry.value.availableModels.map(model => model.id)).toEqual(value.availableModels.map(model => model.id));
        const profiles = buildScmDiffSummaryModelProfiles({
            backendTarget: { kind: 'backend', backendId: 'codex' },
            models: entry.value.availableModels,
            agentFormats: ['json'],
        });
        expect(profiles.map(profile => profile.structuredOutput)).toEqual([
            'unsupported', 'supported', 'unknown', 'unknown', 'unknown', 'unknown',
        ]);
        expect(entry.value.availableModels[0]?.capabilities).toEqual(value.availableModels[0].capabilities);
        expect(entry.value.availableModels[5]?.capabilities).toEqual({ toolRoundTrips: 'supported', structuredOutput: 'unknown' });
    });

    it('rejects malformed persisted capability evidence instead of retaining catalog membership', async () => {
        resetDynamicModelProbeCacheForTests();
        persistedValues.set('dynamic-model-probe-cache-v1', JSON.stringify({
            version: 7,
            entries: {
                'malformed-catalog': {
                    updatedAt: Date.now(),
                    value: {
                        availableModels: [{ id: 'malformed-model', name: 'Malformed', capabilities: { structuredOutput: 'yes' } }],
                        supportsFreeform: false,
                    },
                },
            },
        }));

        vi.resetModules();
        const reloaded = await import('./dynamicModelProbeCache');
        expect(reloaded.readDynamicModelProbeCache('malformed-catalog')).toBeNull();
    });

    it('hydrates known capabilities from retained catalogs with unknown nested fields', async () => {
        resetDynamicModelProbeCacheForTests();
        persistedValues.set('dynamic-model-probe-cache-v1', JSON.stringify({
            version: 7,
            retired: true,
            entries: {
                'retained-catalog': {
                    updatedAt: Date.now(),
                    value: {
                        retired: { enabled: true },
                        availableModels: [{
                            id: 'retained-model', name: 'Retained', retired: true,
                            capabilities: { structuredOutput: 'supported', toolRoundTrips: 'unsupported', retired: true },
                        }],
                        supportsFreeform: false,
                    },
                },
            },
        }));

        vi.resetModules();
        const reloaded = await import('./dynamicModelProbeCache');
        expect(reloaded.readDynamicModelProbeCache('retained-catalog')).toMatchObject({
            kind: 'success',
            value: { availableModels: [{ id: 'retained-model', name: 'Retained',
                capabilities: { structuredOutput: 'supported', toolRoundTrips: 'unsupported' } }], supportsFreeform: false },
        });
        const entry = reloaded.readDynamicModelProbeCache('retained-catalog');
        if (entry?.kind !== 'success') throw new Error('Expected the retained catalog to remain readable');
        expect(entry.value.availableModels[0]?.capabilities).not.toHaveProperty('retired');
    });

});

describe('dynamic model probe cache across an Account change on one Home', () => {
    afterEach(() => { persistedValues.clear(); });

    it('withdraws a list probed for the previous Account from memory and device storage', async () => {
        // One module graph: earlier reload cases leave this file's static imports on a previous one.
        vi.resetModules();
        const { readDynamicModelProbeCache, resetDynamicModelProbeCacheForTests, writeDynamicModelProbeCacheSuccess } = await import('./dynamicModelProbeCache');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const home = { serverUrl: 'https://account-change-models', serverId: 'account-change-models' };
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId },
            { token: createAccountTokenForTests('models-account-a') })).toBe(true);
        resetDynamicModelProbeCacheForTests();
        writeDynamicModelProbeCacheSuccess('shared-machine-key', { availableModels: [{ id: 'a-private', name: 'A private' }], supportsFreeform: false }, Date.now());
        const before = readDynamicModelProbeCache('shared-machine-key');
        expect(before?.kind === 'success' ? before.value.availableModels[0]?.id : null).toBe('a-private');

        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.serverId },
            { token: createAccountTokenForTests('models-account-b') })).toBe(true);

        const after = readDynamicModelProbeCache('shared-machine-key');
        expect(after?.kind === 'success' ? after.value : null).toBeNull();
        expect([...persistedValues.values()].join('')).not.toContain('a-private');
    });
});
