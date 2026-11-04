import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { RecordingControlBar } from './RecordingControlBar';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const snapshot = (phase: 'recording' | 'paused' | 'finalizing') => ({
    phase, timing: { durationMs: 42_000, activeSinceMs: null }, sourceRef: 'capture-1', result: null, error: null,
});
const render = (phase: 'recording' | 'paused' | 'finalizing') => {
    const handlers = { onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onDiscard: vi.fn() };
    return { handlers, screen: renderScreen(<RecordingControlBar snapshot={snapshot(phase)} {...handlers} />) };
};

describe('RecordingControlBar', () => {
    it('holds the time while paused, and its one toggle resumes', async () => {
        const { handlers, screen } = render('paused');
        const shown = await screen;
        expect(shown.getTextContent()).toContain('0:42');
        await shown.pressByTestIdAsync('recording-control-pause');
        expect(handlers.onResume).toHaveBeenCalledOnce();
        expect(handlers.onPause).not.toHaveBeenCalled();
    });

    it('offers Stop and Discard while recording', async () => {
        const { handlers, screen } = render('recording');
        const shown = await screen;
        await shown.pressByTestIdAsync('recording-control-stop');
        await shown.pressByTestIdAsync('recording-control-discard');
        expect(handlers.onStop).toHaveBeenCalledOnce();
        expect(handlers.onDiscard).toHaveBeenCalledOnce();
    });

    it('hides itself without stopping the recording when it can be hidden', async () => {
        const onHide = vi.fn();
        const handlers = { onPause: vi.fn(), onResume: vi.fn(), onStop: vi.fn(), onDiscard: vi.fn() };
        const shown = await renderScreen(<RecordingControlBar snapshot={snapshot('recording')} {...handlers} onHide={onHide} />);
        await shown.pressByTestIdAsync('recording-control-hide');
        expect(onHide).toHaveBeenCalledOnce();
        expect(handlers.onStop).not.toHaveBeenCalled();
        expect(handlers.onDiscard).not.toHaveBeenCalled();
    });

    it('accepts nothing while the movie is being finalized', async () => {
        const { handlers, screen } = render('finalizing');
        const shown = await screen;
        await shown.pressByTestIdAsync('recording-control-stop');
        await shown.pressByTestIdAsync('recording-control-discard');
        expect(handlers.onStop).not.toHaveBeenCalled();
        expect(handlers.onDiscard).not.toHaveBeenCalled();
    });
});
