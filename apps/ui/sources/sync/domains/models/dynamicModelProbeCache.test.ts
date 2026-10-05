import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';

import type { PreflightModelList } from './modelOptions';

import {
    readDynamicModelProbeCache,
    resetDynamicModelProbeCacheForTests,
    writeDynamicModelProbeCacheSuccess,
    writeDynamicModelProbeCacheUnavailable,
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

});
