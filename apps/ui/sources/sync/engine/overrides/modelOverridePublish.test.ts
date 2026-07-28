import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';

import { computeNextModelOverrideMetadata, publishModelOverrideToMetadata } from './modelOverridePublish';

function buildMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'h',
        ...overrides,
    };
}

describe('computeNextModelOverrideMetadata', () => {
    it('updates modelOverrideV1 when updatedAt is newer', () => {
        const base = buildMetadata();
        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 11,
        });

        expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 11, modelId: 'gemini-2.5-pro' });
    });

    it('applies a monotonic bump when model changes with an older updatedAt', () => {
        const base = buildMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-flash' },
        });

        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 9,
        });

        expect(next.modelOverrideV1?.modelId).toBe('gemini-2.5-pro');
        expect(next.modelOverrideV1?.updatedAt).toBe(11);
    });

    it('returns metadata unchanged when model and updatedAt are unchanged', () => {
        const base = buildMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-pro' },
        });

        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 10,
        });

        expect(next).toBe(base);
    });

    it('updates timestamp when updatedAt is newer even for the same model id', () => {
        const base = buildMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gemini-2.5-pro' },
        });

        const next = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-pro',
            updatedAt: 12,
        });

        expect(next.modelOverrideV1).toEqual({ v: 1, updatedAt: 12, modelId: 'gemini-2.5-pro' });
    });

    it('applies a deterministic sequence across newer + stale updates', () => {
        const base = buildMetadata();
        const first = computeNextModelOverrideMetadata({
            metadata: base,
            modelId: 'gemini-2.5-flash',
            updatedAt: 10,
        });
        const second = computeNextModelOverrideMetadata({
            metadata: first,
            modelId: 'gemini-2.5-pro',
            updatedAt: 9,
        });
        const third = computeNextModelOverrideMetadata({
            metadata: second,
            modelId: 'gemini-2.5-pro',
            updatedAt: 15,
        });

        expect(first.modelOverrideV1).toEqual({ v: 1, updatedAt: 10, modelId: 'gemini-2.5-flash' });
        expect(second.modelOverrideV1).toEqual({ v: 1, updatedAt: 11, modelId: 'gemini-2.5-pro' });
        expect(third.modelOverrideV1).toEqual({ v: 1, updatedAt: 15, modelId: 'gemini-2.5-pro' });
    });

    it('atomically clears prior-model option commands while preserving unrelated overrides', () => {
        const next = computeNextModelOverrideMetadata({
            metadata: buildMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'grok',
                    updatedAt: 5,
                    currentModelId: 'model-a',
                    availableModels: [{
                        id: 'model-a',
                        name: 'A',
                        modelOptions: [{
                            id: 'reasoning_effort',
                            name: 'Effort',
                            type: 'select',
                            currentValue: 'high',
                            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
                        }],
                    }, { id: 'model-b', name: 'B' }],
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 6,
                    overrides: {
                        reasoning_effort: { updatedAt: 7, value: 'high' },
                        telemetry: { updatedAt: 4, value: 'true' },
                    },
                },
            }),
            modelId: 'model-b',
            updatedAt: 7,
            retireModelScopedConfigOverrides: true,
        });

        expect(next.modelOverrideV1).toMatchObject({ modelId: 'model-b', updatedAt: 7 });
        expect(next.sessionConfigOptionOverridesV1?.overrides).toMatchObject({
            reasoning_effort: { updatedAt: 8, value: null },
            telemetry: { updatedAt: 4, value: 'true' },
        });
    });

    it('preserves a strictly newer option command during a model change', () => {
        const next = computeNextModelOverrideMetadata({
            metadata: buildMetadata({
                sessionModelsV1: {
                    v: 1,
                    provider: 'grok',
                    updatedAt: 5,
                    currentModelId: 'model-a',
                    availableModels: [{
                        id: 'model-a',
                        name: 'A',
                        modelOptions: [{
                            id: 'reasoning_effort',
                            name: 'Effort',
                            type: 'select',
                            currentValue: 'high',
                            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
                        }],
                    }],
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 9,
                    overrides: { reasoning_effort: { updatedAt: 9, value: 'low' } },
                },
            }),
            modelId: 'model-b',
            updatedAt: 8,
            retireModelScopedConfigOverrides: true,
        });

        expect(next.sessionConfigOptionOverridesV1?.overrides.reasoning_effort).toEqual({ updatedAt: 9, value: 'low' });
    });

    it('does not emit tombstones when the CLI support signal is absent', () => {
        const metadata = buildMetadata({
            sessionModelsV1: {
                v: 1,
                provider: 'grok',
                updatedAt: 5,
                currentModelId: 'model-a',
                availableModels: [{
                    id: 'model-a',
                    name: 'A',
                    modelOptions: [{
                        id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'high', options: [],
                    }],
                }],
            },
            sessionConfigOptionOverridesV1: {
                v: 1,
                updatedAt: 7,
                overrides: { reasoning_effort: { updatedAt: 7, value: 'high' } },
            },
        });
        const next = computeNextModelOverrideMetadata({ metadata, modelId: 'model-b', updatedAt: 7 });
        expect(next.sessionConfigOptionOverridesV1).toBe(metadata.sessionConfigOptionOverridesV1);
    });
});

describe('publishModelOverrideToMetadata', () => {
    it('publishes model override via updateSessionMetadataWithRetry updater', async () => {
        const updates: Metadata[] = [];
        const base = buildMetadata();

        await publishModelOverrideToMetadata({
            sessionId: 's1',
            modelId: 'gemini-2.5-pro',
            updatedAt: 12,
            updateSessionMetadataWithRetry: async (_sessionId, updater) => {
                updates.push(updater(base));
            },
        });

        expect(updates).toHaveLength(1);
        expect(updates[0]?.modelOverrideV1).toEqual({
            v: 1,
            updatedAt: 12,
            modelId: 'gemini-2.5-pro',
        });
    });
});
