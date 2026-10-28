import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveStreamingTextRevealConfig } from './streamingTextRevealConfig';

afterEach(() => {
    vi.unstubAllGlobals();
});

function stubCapableNavigator(): void {
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
}

describe('resolveStreamingTextRevealConfig host gating', () => {
    it('disables the reveal when the shared store reports reduced motion', () => {
        stubCapableNavigator();

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle', reducedMotion: true })).toBeNull();
        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'full', reducedMotion: true })).toBeNull();
    });

    it('disables the reveal on low-core hosts', () => {
        vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 4 });

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle', reducedMotion: false })).toBeNull();
    });

    it('disables the reveal on low-memory hosts', () => {
        vi.stubGlobal('navigator', { deviceMemory: 4, hardwareConcurrency: 8 });

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle', reducedMotion: false })).toBeNull();
    });

    it('keeps the preset configs unchanged on capable hosts', () => {
        stubCapableNavigator();

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle', reducedMotion: false })).toEqual({
            durationMs: 150,
            easing: 'ease-out',
            translateYPx: 2,
        });
        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'full', reducedMotion: false })).toEqual({
            durationMs: 180,
            easing: 'ease-out',
            translateYPx: 3,
        });
    });

    it('stays disabled when animation is not requested regardless of host capability reads', () => {
        expect(resolveStreamingTextRevealConfig({ animated: false, reducedMotion: false })).toBeNull();
        expect(resolveStreamingTextRevealConfig({ reducedMotion: false })).toBeNull();
    });
});
