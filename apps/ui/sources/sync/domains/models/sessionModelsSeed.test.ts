import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/sync/domains/state/storageTypes';
import {
    buildSessionModelsSeedRequest,
    computeNextSessionModelsSeedMetadata,
    publishSessionModelsSeedToMetadata,
} from './sessionModelsSeed';

const preflightModels = {
    availableModels: [{
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o mini',
        description: 'openai',
    }],
    supportsFreeform: true,
} as const;

describe('sessionModelsSeed', () => {
    it('builds a seed only for the preflight catalog belonging to the spawned dynamic target', () => {
        expect(buildSessionModelsSeedRequest({
            agentId: 'pi',
            currentTargetKey: 'backend:pi',
            preflightTargetKey: 'backend:pi',
            preflightModels,
            currentModelId: 'openai/gpt-4o-mini',
            hasCuratedStaticModels: false,
            updatedAt: 123,
        })).toEqual({
            agentId: 'pi',
            currentModelId: 'openai/gpt-4o-mini',
            availableModels: preflightModels.availableModels,
            updatedAt: 123,
        });

        expect(buildSessionModelsSeedRequest({
            agentId: 'pi',
            currentTargetKey: 'backend:pi',
            preflightTargetKey: 'backend:codex',
            preflightModels,
            currentModelId: 'openai/gpt-4o-mini',
            hasCuratedStaticModels: false,
            updatedAt: 123,
        })).toBeNull();

        expect(buildSessionModelsSeedRequest({
            agentId: 'pi',
            currentTargetKey: 'backend:pi',
            preflightTargetKey: 'backend:pi',
            preflightModels,
            currentModelId: 'openai/gpt-4o-mini',
            hasCuratedStaticModels: true,
            updatedAt: 123,
        })).toBeNull();
    });

    it('seeds both metadata aliases without replacing runtime-owned model state', () => {
        const metadata = { path: '/repo', host: 'host' } as Metadata;
        const seed = {
            agentId: 'pi',
            currentModelId: 'openai/gpt-4o-mini',
            availableModels: preflightModels.availableModels,
            updatedAt: 123,
        } as const;
        const seeded = computeNextSessionModelsSeedMetadata({ metadata, seed });

        expect(seeded.sessionModelsV1).toEqual({ v: 1, ...seed });
        expect(seeded.acpSessionModelsV1).toEqual({ v: 1, ...seed });
        expect(computeNextSessionModelsSeedMetadata({ metadata: seeded, seed })).toBe(seeded);
    });

    it('publishes through the selected server metadata authority', async () => {
        const updateSessionMetadataWithRetry = vi.fn(async (
            _sessionId: string,
            updater: (metadata: Metadata) => Metadata,
            _options?: Readonly<{ serverId?: string | null }>,
        ) => {
            expect(updater({ path: '/repo', host: 'host' } as Metadata).sessionModelsV1?.agentId).toBe('pi');
        });

        await publishSessionModelsSeedToMetadata({
            sessionId: 'session-1',
            serverId: 'server-b',
            seed: {
                agentId: 'pi',
                currentModelId: 'openai/gpt-4o-mini',
                availableModels: preflightModels.availableModels,
                updatedAt: 123,
            },
            updateSessionMetadataWithRetry,
        });

        expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(
            'session-1',
            expect.any(Function),
            { serverId: 'server-b' },
        );
    });
});
