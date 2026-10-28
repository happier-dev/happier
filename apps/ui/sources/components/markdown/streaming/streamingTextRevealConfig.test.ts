import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveStreamingTextRevealConfig } from './streamingTextRevealConfig';

afterEach(() => {
    vi.unstubAllGlobals();
});

function stubCapableHost(): void {
    vi.stubGlobal('window', {
        matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
}

describe('resolveStreamingTextRevealConfig host gating', () => {
    it('disables the reveal when the OS requests reduced motion', () => {
        vi.stubGlobal('window', {
            matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }),
        });
        vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle' })).toBeNull();
        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'full' })).toBeNull();
    });

    it('disables the reveal on low-core hosts', () => {
        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
        });
        vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 4 });

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle' })).toBeNull();
    });

    it('disables the reveal on low-memory hosts', () => {
        vi.stubGlobal('window', {
            matchMedia: () => ({ matches: false }),
        });
        vi.stubGlobal('navigator', { deviceMemory: 4, hardwareConcurrency: 8 });

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle' })).toBeNull();
    });

    it('keeps the preset configs unchanged on capable hosts', () => {
        stubCapableHost();

        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'subtle' })).toEqual({
            durationMs: 150,
            easing: 'ease-out',
            translateYPx: 2,
        });
        expect(resolveStreamingTextRevealConfig({ animated: true, preset: 'full' })).toEqual({
            durationMs: 180,
            easing: 'ease-out',
            translateYPx: 3,
        });
    });

    it('stays disabled when animation is not requested regardless of host capability reads', () => {
        expect(resolveStreamingTextRevealConfig({ animated: false })).toBeNull();
        expect(resolveStreamingTextRevealConfig({})).toBeNull();
    });
});
