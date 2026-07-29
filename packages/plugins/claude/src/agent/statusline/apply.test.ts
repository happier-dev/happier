import { describe, expect, it, vi } from 'vitest';

import { createClaudeStatuslineApplier } from './apply.js';
import type { ClaudeStatuslinePayload } from './payload.js';

function createHarness(identity?: Readonly<{
    providerSessionId?: string | null;
    transcriptPath?: string | null;
}>) {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const onRuntimeTruth = vi.fn();
    const onEffectiveModel = vi.fn();
    const onModelChanged = vi.fn();
    const applier = createClaudeStatuslineApplier({
        logger,
        readIdentity: () => ({
            providerSessionId: identity?.providerSessionId ?? null,
            transcriptPath: identity?.transcriptPath ?? null,
        }),
        onRuntimeTruth,
        onEffectiveModel,
        onModelChanged,
    });
    return { applier, logger, onRuntimeTruth, onEffectiveModel, onModelChanged };
}

const basePayload: ClaudeStatuslinePayload = {
    session_id: 'claude-session-1',
    transcript_path: '/projects/demo/transcript.jsonl',
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    context_window: { context_window_size: 1_000_000, used_percentage: 12 },
    version: '2.1.170',
};

describe('createClaudeStatuslineApplier', () => {
    it('publishes effective model identity and the direct context window once', () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        harness.applier.apply(basePayload);

        expect(harness.onEffectiveModel).toHaveBeenCalledTimes(1);
        expect(harness.onEffectiveModel).toHaveBeenCalledWith({
            modelId: 'claude-fable-5',
            displayName: 'Fable 5',
            contextWindowTokens: 1_000_000,
        });
    });

    it('emits model changes through the semantic sink without a metadata writer', () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        harness.applier.apply({
            ...basePayload,
            model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
        });

        expect(harness.onModelChanged).toHaveBeenCalledWith(expect.objectContaining({
            previousModelId: 'claude-fable-5',
            modelId: 'claude-opus-4-8',
        }));
    });

    it('publishes new effective evidence when the model or window changes', () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        harness.applier.apply({
            ...basePayload,
            context_window: { context_window_size: 200_000 },
        });

        expect(harness.onEffectiveModel).toHaveBeenCalledTimes(2);
        expect(harness.onEffectiveModel).toHaveBeenLastCalledWith(expect.objectContaining({
            modelId: 'claude-fable-5',
            contextWindowTokens: 200_000,
        }));
    });

    it('ignores payloads from a foreign Claude session when identity is known', () => {
        const harness = createHarness({
            providerSessionId: 'other-session',
            transcriptPath: '/other/transcript.jsonl',
        });

        harness.applier.apply(basePayload);

        expect(harness.onEffectiveModel).not.toHaveBeenCalled();
        expect(harness.onRuntimeTruth).not.toHaveBeenCalled();
    });

    it('accepts payloads before session identity is adopted', () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);

        expect(harness.onEffectiveModel).toHaveBeenCalledTimes(1);
    });

    it('matches on transcript path after provider identity rotates', () => {
        const harness = createHarness({
            providerSessionId: 'pre-rotation-id',
            transcriptPath: '/projects/demo/transcript.jsonl',
        });

        harness.applier.apply(basePayload);

        expect(harness.onEffectiveModel).toHaveBeenCalledTimes(1);
    });

    it('tolerates payloads without model facts', () => {
        const harness = createHarness();

        expect(() => harness.applier.apply({ version: '2.1.170' })).not.toThrow();
        expect(harness.onEffectiveModel).not.toHaveBeenCalled();
    });

    it('feeds verified model and effort truth with a separate dedupe key', () => {
        const harness = createHarness();

        harness.applier.apply({ ...basePayload, effort: { level: 'high' } });
        harness.applier.apply({ ...basePayload, effort: { level: 'high' } });
        harness.applier.apply({ ...basePayload, effort: { level: 'medium' } });

        expect(harness.onRuntimeTruth).toHaveBeenCalledTimes(2);
        expect(harness.onRuntimeTruth).toHaveBeenLastCalledWith({
            modelId: 'claude-fable-5',
            effortLevel: 'medium',
        });
    });

    it('logs a change-only runtime canary line', () => {
        const harness = createHarness();

        harness.applier.apply(basePayload);
        harness.applier.apply(basePayload);
        harness.applier.apply({ ...basePayload, fast_mode: true });

        const canaryCalls = harness.logger.debug.mock.calls.filter(
            (call) => typeof call[0] === 'string' && call[0].includes('statusline runtime state'),
        );
        expect(canaryCalls).toHaveLength(2);
    });
});
