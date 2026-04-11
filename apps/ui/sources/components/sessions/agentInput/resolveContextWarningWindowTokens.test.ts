import { describe, expect, it } from 'vitest';

import { MetadataSchema } from '@/sync/domains/state/storageTypes';

import { resolveContextWarningWindowTokens } from './resolveContextWarningWindowTokens';

describe('resolveContextWarningWindowTokens', () => {
    it('prefers live usage telemetry over metadata when resolving the warning window', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModelId: 'gpt-5',
                availableModels: [
                    {
                        id: 'gpt-5',
                        name: 'GPT 5',
                        contextWindowTokens: 400000,
                    },
                ],
            },
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'codex',
            metadata,
            usageData: {
                contextWindowTokens: 258400,
            },
        } as any)).toBe(245480);
    });

    it('reads the current model context window from parsed session model metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModelId: 'gpt-5',
                availableModels: [
                    {
                        id: 'gpt-5',
                        name: 'GPT 5',
                        contextWindowTokens: 258000,
                    },
                ],
            },
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'codex',
            metadata,
        } as any)).toBe(245100);
    });

    it('falls back to Claude default warning windows when no live or metadata value exists', () => {
        expect(resolveContextWarningWindowTokens({
            agentId: 'claude',
            metadata: null,
        } as any)).toBe(190000);
    });

    it('returns null when the provider metadata does not expose a valid context window', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'localhost',
            sessionModelsV1: {
                v: 1,
                provider: 'claude',
                updatedAt: 1,
                currentModelId: 'sonnet',
                availableModels: [
                    {
                        id: 'sonnet',
                        name: 'Claude Sonnet',
                    },
                ],
            },
        } as any);

        expect(resolveContextWarningWindowTokens({
            agentId: 'codex',
            metadata,
        } as any)).toBeNull();
    });
});
