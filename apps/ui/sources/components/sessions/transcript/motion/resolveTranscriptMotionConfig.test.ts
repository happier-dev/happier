import { describe, expect, it } from 'vitest';

import { resolveTranscriptMotionConfig } from './resolveTranscriptMotionConfig';

describe('resolveTranscriptMotionConfig', () => {
    it('forces preset off when reduced motion is preferred', () => {
        const cfg = resolveTranscriptMotionConfig({
            transcriptMotionPreset: 'full',
            reducedMotionPreferred: true,
        });
        expect(cfg.preset).toBe('off');
        expect(cfg.animateNewItemsEnabled).toBe(false);
        expect(cfg.animateToolExpandCollapseEnabled).toBe(false);
        expect(cfg.animateThinkingEnabled).toBe(false);
    });

    it('defaults preset to subtle for unknown values', () => {
        expect(resolveTranscriptMotionConfig({ transcriptMotionPreset: 'weird' }).preset).toBe('subtle');
    });

    it('keeps preset off/full as-is', () => {
        expect(resolveTranscriptMotionConfig({ transcriptMotionPreset: 'off' }).preset).toBe('off');
        expect(resolveTranscriptMotionConfig({ transcriptMotionPreset: 'full' }).preset).toBe('full');
    });

    it('defaults freshnessMs to 60s and clamps to 0', () => {
        expect(resolveTranscriptMotionConfig({ transcriptMotionFreshnessMs: 'nope' }).freshnessMs).toBe(60_000);
        expect(resolveTranscriptMotionConfig({ transcriptMotionFreshnessMs: -10 }).freshnessMs).toBe(0);
    });

    it('treats motion toggles as enabled unless explicitly false', () => {
        expect(resolveTranscriptMotionConfig({}).animateNewItemsEnabled).toBe(true);
        expect(resolveTranscriptMotionConfig({ transcriptAnimateNewItemsEnabled: false }).animateNewItemsEnabled).toBe(false);
        expect(resolveTranscriptMotionConfig({ transcriptAnimateToolExpandCollapseEnabled: false }).animateToolExpandCollapseEnabled).toBe(false);
        expect(resolveTranscriptMotionConfig({ transcriptAnimateThinkingEnabled: false }).animateThinkingEnabled).toBe(false);
    });
});
