import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import { getModelOptionsForSession, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import { readSessionModelsState } from '@/sync/domains/sessionControl/readSessionControlMetadata';

import {
    computeNextSessionModelsSeedMetadata,
    publishSessionModelsSeedToMetadata,
} from './sessionModelsSeedPublish';

const PROBED_MODELS = [
    { id: 'default', name: 'Default' },
    { id: 'zai/glm-5.3', name: 'GLM-5.3', description: 'Z.ai GLM' },
    { id: 'lmstudio/hadees/lfm2.5-2.6b@q8_0', name: 'LFM 2.5 2.6B' },
] as const;

function buildSpawnMetadata(): Metadata {
    return {
        flavor: 'pi',
        path: '/tmp/project',
    } as unknown as Metadata;
}

describe('computeNextSessionModelsSeedMetadata', () => {
    it('seeds sessionModelsV1 and its legacy alias when the session has no model list', () => {
        const next = computeNextSessionModelsSeedMetadata({
            metadata: buildSpawnMetadata(),
            provider: 'pi',
            currentModelId: 'lmstudio/hadees/lfm2.5-2.6b@q8_0',
            availableModels: PROBED_MODELS,
            updatedAt: 1234,
        });

        expect(next.sessionModelsV1).toEqual({
            v: 1,
            provider: 'pi',
            updatedAt: 1234,
            currentModelId: 'lmstudio/hadees/lfm2.5-2.6b@q8_0',
            availableModels: PROBED_MODELS,
        });
        expect(next.acpSessionModelsV1).toEqual(next.sessionModelsV1);
        // Spawn-time metadata the runner owns must survive the seed.
        expect(next.flavor).toBe('pi');
        expect(next.path).toBe('/tmp/project');
    });

    it('never replaces a runtime-published model list', () => {
        const runtimePublished = buildSpawnMetadata();
        (runtimePublished as Record<string, unknown>).sessionModelsV1 = {
            v: 1,
            provider: 'pi',
            updatedAt: 9999,
            currentModelId: 'zai/glm-5.3',
            availableModels: [{ id: 'zai/glm-5.3', name: 'GLM-5.3' }],
        };

        const next = computeNextSessionModelsSeedMetadata({
            metadata: runtimePublished,
            provider: 'pi',
            currentModelId: 'default',
            availableModels: PROBED_MODELS,
            updatedAt: 1234,
        });

        expect(next).toBe(runtimePublished);
    });

    it('returns the metadata unchanged when there is nothing to seed', () => {
        const metadata = buildSpawnMetadata();

        const next = computeNextSessionModelsSeedMetadata({
            metadata,
            provider: 'pi',
            currentModelId: 'default',
            availableModels: [],
            updatedAt: 1234,
        });

        expect(next).toBe(metadata);
    });

    it('drops rows the session-models schema would reject', () => {
        const next = computeNextSessionModelsSeedMetadata({
            metadata: buildSpawnMetadata(),
            provider: 'pi',
            currentModelId: 'default',
            availableModels: [
                { id: 'zai/glm-5.3', name: 'GLM-5.3', description: '' },
                { id: '', name: 'Missing id' },
                // A model-scoped option row that fails the id/name requirement must be dropped.
                { id: 'missing-name' } as unknown as PreflightModelList['availableModels'][number],
                {
                    id: 'zai/glm-5.3-air',
                    name: 'GLM-5.3 Air',
                    description: 'Fast variant',
                    extendedContextModelId: '  zai/glm-5.3-air-long  ',
                },
            ],
            updatedAt: 1234,
        });

        expect(next.sessionModelsV1?.availableModels).toEqual([
            // Blank descriptions are omitted: the reader schema requires min(1) when present.
            { id: 'zai/glm-5.3', name: 'GLM-5.3' },
            {
                id: 'zai/glm-5.3-air',
                name: 'GLM-5.3 Air',
                description: 'Fast variant',
                extendedContextModelId: 'zai/glm-5.3-air-long',
            },
        ]);
    });
});

describe('publishSessionModelsSeedToMetadata', () => {
    it('writes through the session metadata CAS path with the seed updater', async () => {
        const updateSessionMetadataWithRetry = vi.fn(async (
            _sessionId: string,
            updater: (metadata: Metadata) => Metadata,
            _options?: Readonly<{ serverId?: string | null }>,
        ) => {
            const seeded = updater(buildSpawnMetadata());
            expect(readSessionModelsState(seeded)?.provider).toBe('pi');
        });

        await publishSessionModelsSeedToMetadata({
            sessionId: 'session-1',
            provider: 'pi',
            currentModelId: 'default',
            availableModels: PROBED_MODELS,
            updatedAt: 1234,
            serverId: 'server-b',
            updateSessionMetadataWithRetry,
        });

        expect(updateSessionMetadataWithRetry).toHaveBeenCalledTimes(1);
        expect(updateSessionMetadataWithRetry.mock.calls[0][0]).toBe('session-1');
        expect(updateSessionMetadataWithRetry.mock.calls[0][2]).toEqual({ serverId: 'server-b' });
    });
});

describe('seeded metadata resolves through the in-session model options reader', () => {
    it('surfaces the probed models in getModelOptionsForSession', () => {
        const seeded = computeNextSessionModelsSeedMetadata({
            metadata: buildSpawnMetadata(),
            provider: 'pi',
            currentModelId: 'default',
            availableModels: PROBED_MODELS,
            updatedAt: 1234,
        });

        const options = getModelOptionsForSession('pi', seeded);
        const values = options.map((option) => option.value);

        // The picker's localized "Use CLI settings" default plus every probed model.
        expect(values).toContain('default');
        expect(values).toContain('zai/glm-5.3');
        expect(values).toContain('lmstudio/hadees/lfm2.5-2.6b@q8_0');
        expect(options.find((option) => option.value === 'zai/glm-5.3')?.label).toBe('GLM-5.3');
    });
});
