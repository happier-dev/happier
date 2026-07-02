import { describe, expect, it, vi } from 'vitest';

import { createClaudeStatuslineApplier } from './apply.js';
import type { ClaudeStatuslinePayload } from './payload.js';

type MetadataRecord = Record<string, unknown>;

function createHarness(identity?: Readonly<{ providerSessionId?: string | null; transcriptPath?: string | null }>) {
    let metadata: MetadataRecord = {};
    const writeMetadata = vi.fn(async (request: Readonly<{
        kind: 'update';
        handler: (current: Readonly<MetadataRecord>) => Readonly<MetadataRecord>;
        reason?: string;
    }>) => {
        metadata = { ...request.handler(metadata) };
    });
    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const onRuntimeTruth = vi.fn();
    const applier = createClaudeStatuslineApplier({
        logger,
        writeMetadata,
        readIdentity: () => ({
            providerSessionId: identity?.providerSessionId ?? null,
            transcriptPath: identity?.transcriptPath ?? null,
        }),
        onRuntimeTruth,
    });
    return {
        applier,
        writeMetadata,
        logger,
        onRuntimeTruth,
        readMetadata: () => metadata,
        seedMetadata: (value: MetadataRecord) => {
            metadata = value;
        },
    };
}

const basePayload: ClaudeStatuslinePayload = {
    session_id: 'claude-session-1',
    transcript_path: '/projects/demo/transcript.jsonl',
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    context_window: { context_window_size: 1_000_000, used_percentage: 12 },
    version: '2.1.170',
};

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createClaudeStatuslineApplier', () => {
    it('adopts model id, display name, and the direct context window into sessionModelsV1', async () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        await flush();

        expect(harness.writeMetadata).toHaveBeenCalledTimes(1);
        const state = harness.readMetadata().sessionModelsV1 as {
            v: number;
            provider: string;
            currentModelId: string;
            availableModels: Array<{ id: string; name: string; contextWindowTokens?: number }>;
        };
        expect(state.v).toBe(1);
        expect(state.provider).toBe('claude');
        expect(state.currentModelId).toBe('claude-fable-5');
        const entry = state.availableModels.find((model) => model.id === 'claude-fable-5');
        expect(entry).toMatchObject({ name: 'Fable 5', contextWindowTokens: 1_000_000 });
    });

    it('dedupes identical payloads to a single metadata write', async () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        harness.applier.apply(basePayload);
        harness.applier.apply(basePayload);
        await flush();

        expect(harness.writeMetadata).toHaveBeenCalledTimes(1);
    });

    it('writes again when the model or window changes', async () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        harness.applier.apply({
            ...basePayload,
            model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet 4.6' },
            context_window: { context_window_size: 200_000 },
        });
        await flush();

        expect(harness.writeMetadata).toHaveBeenCalledTimes(2);
        const state = harness.readMetadata().sessionModelsV1 as {
            currentModelId: string;
            availableModels: Array<{ id: string; contextWindowTokens?: number }>;
        };
        expect(state.currentModelId).toBe('claude-sonnet-4-6');
        expect(state.availableModels.map((model) => model.id)).toEqual(
            expect.arrayContaining(['claude-fable-5', 'claude-sonnet-4-6']),
        );
    });

    it('preserves existing availableModels entry facts when upserting the window', async () => {
        const harness = createHarness();
        harness.seedMetadata({
            sessionModelsV1: {
                v: 1,
                provider: 'claude',
                updatedAt: 1,
                currentModelId: 'claude-fable-5',
                availableModels: [{
                    id: 'claude-fable-5',
                    name: 'Fable 5',
                    description: 'Most capable model',
                }],
            },
        });

        harness.applier.apply(basePayload);
        await flush();

        const state = harness.readMetadata().sessionModelsV1 as {
            availableModels: Array<{ id: string; description?: string; contextWindowTokens?: number }>;
        };
        const entry = state.availableModels.find((model) => model.id === 'claude-fable-5');
        expect(entry).toMatchObject({ description: 'Most capable model', contextWindowTokens: 1_000_000 });
    });

    it('ignores payloads from a foreign Claude session when identity is known', async () => {
        const harness = createHarness({ providerSessionId: 'other-session', transcriptPath: '/other/transcript.jsonl' });

        harness.applier.apply(basePayload);
        await flush();

        expect(harness.writeMetadata).not.toHaveBeenCalled();
    });

    it('accepts payloads before session identity is adopted (statusline fires at TUI start)', async () => {
        const harness = createHarness({ providerSessionId: null, transcriptPath: null });

        harness.applier.apply(basePayload);
        await flush();

        expect(harness.writeMetadata).toHaveBeenCalledTimes(1);
    });

    it('matches on the transcript path when the Claude session id rotated (fork/compact)', async () => {
        const harness = createHarness({
            providerSessionId: 'pre-rotation-id',
            transcriptPath: '/projects/demo/transcript.jsonl',
        });

        harness.applier.apply(basePayload);
        await flush();

        expect(harness.writeMetadata).toHaveBeenCalledTimes(1);
    });

    it('tolerates payloads without model facts and never throws', async () => {
        const harness = createHarness();

        expect(() => harness.applier.apply({ version: '2.1.170' })).not.toThrow();
        await flush();

        expect(harness.writeMetadata).not.toHaveBeenCalled();
    });

    it('feeds verified model/effort runtime truth with its own model|effort dedup key (Y)', async () => {
        const harness = createHarness();

        // The metadata dedup key is model|window and cannot see effort changes; the runtime-truth
        // feed must have its OWN model|effort key so an effort-only change still reconciles.
        harness.applier.apply({ ...basePayload, effort: { level: 'high' } });
        harness.applier.apply({ ...basePayload, effort: { level: 'high' } });
        expect(harness.onRuntimeTruth).toHaveBeenCalledTimes(1);
        expect(harness.onRuntimeTruth).toHaveBeenCalledWith({ modelId: 'claude-fable-5', effortLevel: 'high' });

        harness.applier.apply({ ...basePayload, effort: { level: 'medium' } });
        expect(harness.onRuntimeTruth).toHaveBeenCalledTimes(2);
        expect(harness.onRuntimeTruth).toHaveBeenLastCalledWith({ modelId: 'claude-fable-5', effortLevel: 'medium' });
        await flush();

        // The truth feed never adds metadata writes beyond the model|window dedup.
        expect(harness.writeMetadata).toHaveBeenCalledTimes(1);
    });

    it('never feeds runtime truth from a foreign Claude session (Y)', async () => {
        const harness = createHarness({ providerSessionId: 'other-session', transcriptPath: '/other/transcript.jsonl' });

        harness.applier.apply({ ...basePayload, effort: { level: 'high' } });
        await flush();

        expect(harness.onRuntimeTruth).not.toHaveBeenCalled();
    });

    it('logs a change-only runtime canary line', async () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        harness.applier.apply(basePayload);
        harness.applier.apply({ ...basePayload, fast_mode: true });
        await flush();

        const canaryCalls = harness.logger.debug.mock.calls.filter(
            (call) => typeof call[0] === 'string' && call[0].includes('statusline runtime state'),
        );
        expect(canaryCalls).toHaveLength(2);
    });
});
