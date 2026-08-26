import { describe, expect, it } from 'vitest';

import {
    createEmptyTerminalPreviewState,
    appendTerminalPreviewText,
    resolveTerminalReplayPlan,
} from './replay';

describe('terminal stream replay', () => {
    it('keeps cached preview visible while daemon replay starts for a reused terminal', () => {
        const plan = resolveTerminalReplayPlan({
            cachedTerminalId: 'term-1',
            ensuredTerminalId: 'term-1',
            reused: true,
            cachedOutput: 'existing output',
            cachedCursor: { mode: 'byte-offset', value: 12 },
            replayMode: 'byte-offset',
        });

        expect(plan).toEqual({
            initialCursor: { mode: 'byte-offset', value: 12 },
            renderPreview: true,
            clearRenderer: false,
            replacePreviewOnReplay: true,
        });
    });

    it('resets a byte cursor before replaying a cached preview through the legacy event carrier', () => {
        const plan = resolveTerminalReplayPlan({
            cachedTerminalId: 'term-1',
            ensuredTerminalId: 'term-1',
            reused: true,
            cachedOutput: 'existing output',
            cachedCursor: { mode: 'byte-offset', value: 12 },
            replayMode: 'legacy-event-cursor',
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
            cachedCursor: { mode: 'byte-offset', value: 12 },
            replayMode: 'byte-offset',
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
