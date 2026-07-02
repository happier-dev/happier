import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({ OS: 'web' as 'web' | 'ios' }));
const preloadMarkdownRuntimeMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock('react-native', () => ({
    Platform: platformMock,
}));

vi.mock('react-native-enriched-markdown', () => ({
    preloadMarkdownRuntime: preloadMarkdownRuntimeMock,
}));

describe('preloadEnrichedMarkdownRuntime', () => {
    beforeEach(() => {
        vi.resetModules();
        platformMock.OS = 'web';
        preloadMarkdownRuntimeMock.mockReset();
        vi.useRealTimers();
    });

    it('does not immediately retry the web runtime fetch after a preload failure', async () => {
        const preloadFailure = new Error('runtime unavailable');
        preloadMarkdownRuntimeMock.mockRejectedValue(preloadFailure);
        const { isEnrichedMarkdownRuntimePreloaded, preloadEnrichedMarkdownRuntime } = await import(
            './preloadEnrichedMarkdownRuntime'
        );

        await expect(preloadEnrichedMarkdownRuntime()).rejects.toBe(preloadFailure);
        await expect(preloadEnrichedMarkdownRuntime()).rejects.toBe(preloadFailure);

        expect(preloadMarkdownRuntimeMock).toHaveBeenCalledTimes(1);
        expect(isEnrichedMarkdownRuntimePreloaded()).toBe(false);
    });
});
