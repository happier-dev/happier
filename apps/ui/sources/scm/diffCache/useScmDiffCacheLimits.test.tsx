import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let maxEntriesSetting: number = 30;
let maxTotalBytesSetting: number = 20 * 1024 * 1024;

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'scmDiffCacheMaxEntries') return maxEntriesSetting;
        if (key === 'scmDiffCacheMaxTotalBytes') return maxTotalBytesSetting;
        return undefined;
    },
}));

describe('useScmDiffCacheLimits', () => {
    it('applies limits from settings and avoids redundant updates', async () => {
        const cache = { setLimits: vi.fn() } as any;
        const { useScmDiffCacheLimits } = await import('./useScmDiffCacheLimits');

        const Test = () => {
            useScmDiffCacheLimits(cache);
            return null;
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<Test />);
        });

        expect(cache.setLimits).toHaveBeenCalledTimes(1);
        expect(cache.setLimits).toHaveBeenCalledWith({ maxEntries: 30, maxTotalBytes: 20 * 1024 * 1024 });

        cache.setLimits.mockClear();

        // Re-render with identical settings does not reapply limits on the same component instance.
        await act(async () => {
            tree!.update(<Test />);
        });
        expect(cache.setLimits).toHaveBeenCalledTimes(0);

        // Settings change: should update.
        maxEntriesSetting = 10;
        maxTotalBytesSetting = 100;

        await act(async () => {
            tree!.update(<Test />);
        });

        expect(cache.setLimits).toHaveBeenCalledTimes(1);
        expect(cache.setLimits).toHaveBeenCalledWith({ maxEntries: 10, maxTotalBytes: 100 });
    });
});
