import { describe, expect, it } from 'vitest';

import {
    createEmptyTerminalPreviewState,
    appendTerminalPreviewText,
    resolveTerminalReplayPlan,
} from './replay';

describe('terminal stream replay', () => {
    it('resumes a restored parsed buffer at its completed cursor without replacing its history', () => {
        const plan = resolveTerminalReplayPlan({ cachedTerminalId: 'term-1', ensuredTerminalId: 'term-1',
            reused: true, cachedOutput: 'preview tail', replayMode: 'byte-offset',
            restoredCursor: { mode: 'byte-offset', value: 100_000 } });
        expect(plan).toEqual({ initialCursor: { mode: 'byte-offset', value: 100_000 },
            renderPreview: false, clearRenderer: false, replacePreviewOnReplay: false });
    });

    it('keeps cached preview visible while daemon replay starts for a reused terminal', () => {
        const plan = resolveTerminalReplayPlan({
            cachedTerminalId: 'term-1',
            ensuredTerminalId: 'term-1',
            reused: true,
            cachedOutput: 'existing output',
            replayMode: 'byte-offset',
        });

        expect(plan).toEqual({
            initialCursor: { mode: 'byte-offset', value: 0 },
            renderPreview: true,
            clearRenderer: false,
            replacePreviewOnReplay: true,
        });
    });

    it('replays retained output through the legacy event carrier behind a cached preview', () => {
        const plan = resolveTerminalReplayPlan({
            cachedTerminalId: 'term-1',
            ensuredTerminalId: 'term-1',
            reused: true,
            cachedOutput: 'existing output',
            replayMode: 'legacy-event-cursor',
            restoredCursor: { mode: 'byte-offset', value: 100 },
        });

        expect(plan.initialCursor).toEqual({ mode: 'legacy-event-cursor', value: 0 });
        expect(plan.renderPreview).toBe(true);
        expect(plan.replacePreviewOnReplay).toBe(true);
    });

    it('clears stale preview when the daemon returns a different terminal id', () => {
        const plan = resolveTerminalReplayPlan({
            cachedTerminalId: 'term-1',
            ensuredTerminalId: 'term-2',
            reused: false,
            cachedOutput: 'old output',
            replayMode: 'byte-offset',
            restoredCursor: { mode: 'byte-offset', value: 100 },
        });

        expect(plan.renderPreview).toBe(false);
        expect(plan.clearRenderer).toBe(true);
        expect(plan.initialCursor).toEqual({ mode: 'byte-offset', value: 0 });
    });

    it('bounds preview text so it cannot become an unbounded transcript source of truth', () => {
        const initial = createEmptyTerminalPreviewState();
        const updated = appendTerminalPreviewText(initial, 'a'.repeat(70_000));

        expect(updated.output.length).toBeLessThanOrEqual(64_000);
        expect(updated.output).toBe('a'.repeat(64_000));
    });
});
