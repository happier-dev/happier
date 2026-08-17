import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useJourneyProgress } from './useJourneyProgress';

afterEach(() => {
    standardCleanup();
});

describe('useJourneyProgress', () => {
    it('advances, goes back, and skips to setup with history preserved', async () => {
        const onComplete = vi.fn();
        const hook = await renderHook(() => useJourneyProgress({ surface: 'desktop', onComplete }));

        expect(hook.getCurrent().currentBeat.id).toBe('A1');

        await act(async () => {
            hook.getCurrent().advance();
        });
        expect(hook.getCurrent().currentBeat.id).toBe('A2');

        await act(async () => {
            hook.getCurrent().skipToSetup();
        });
        expect(hook.getCurrent().currentBeat.id).toBe('S1');

        await act(async () => {
            hook.getCurrent().back();
        });
        expect(hook.getCurrent().currentBeat.id).toBe('A2');

        await hook.unmount();
    });

    it('carries the A7 attention choice to completion without applying settings in the hook', async () => {
        const onComplete = vi.fn();
        const hook = await renderHook(() => useJourneyProgress({
            surface: 'desktop',
            initialBeatId: 'S5',
            initialAttentionChoice: 'keep_current',
            onComplete,
        }));

        await act(async () => {
            hook.getCurrent().setAttentionChoice('promote_attention_and_working');
        });
        await act(async () => {
            hook.getCurrent().advance();
        });

        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith({
            attentionChoice: 'promote_attention_and_working',
            completedBeatId: 'S5',
        });

        await hook.unmount();
    });

    it('moves to the nearest visible beat when a beat hidden on the surface is requested', async () => {
        // A8 (review) is not part of the curated native subset, so requesting it
        // on native lands on the nearest beat that cut kept rather than restarting.
        const hook = await renderHook(() => useJourneyProgress({
            surface: 'native',
            initialBeatId: 'A8',
            onComplete: vi.fn(),
        }));

        expect(hook.getCurrent().currentBeat.id).toBe('A7');
        await hook.unmount();
    });
});
