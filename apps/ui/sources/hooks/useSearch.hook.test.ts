import React from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useSearch (hook)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns a stable error code when search fails after retries', async () => {
        const searchFn = vi.fn().mockRejectedValue(new Error('boom'));
        const { useSearch } = await import('./useSearch');

        let latest: any = null;
        function Test({ query }: { query: string }) {
            latest = useSearch(query, searchFn);
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test, { query: 'abc' }));
        });

        // Debounce delay
        await act(async () => {
            vi.advanceTimersByTime(300);
        });

        // Retry delay (first attempt fails -> waits 750ms -> second attempt fails)
        await act(async () => {
            vi.advanceTimersByTime(750);
        });

        expect(searchFn).toHaveBeenCalledTimes(2);
        expect(latest?.error).toBe('searchFailed');
    });

    it('returns search results after debounce when search succeeds', async () => {
        const searchFn = vi.fn().mockResolvedValue(['alpha']);
        const { useSearch } = await import('./useSearch');

        let latest: any = null;
        function Test({ query }: { query: string }) {
            latest = useSearch(query, searchFn);
            return React.createElement('View');
        }

        await act(async () => {
            renderer.create(React.createElement(Test, { query: 'a' }));
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(searchFn).toHaveBeenCalledTimes(1);
        expect(latest?.results).toEqual(['alpha']);
        expect(latest?.error).toBeNull();
        expect(latest?.isSearching).toBe(false);
    });

    it('reuses cached results for repeated queries without calling search again', async () => {
        const searchFn = vi.fn().mockResolvedValue(['alpha']);
        const { useSearch } = await import('./useSearch');

        let latest: any = null;
        function Test({ query }: { query: string }) {
            latest = useSearch(query, searchFn);
            return React.createElement('View');
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(React.createElement(Test, { query: 'alpha' }));
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });
        expect(searchFn).toHaveBeenCalledTimes(1);
        expect(latest?.results).toEqual(['alpha']);

        await act(async () => {
            tree!.update(React.createElement(Test, { query: '' }));
        });
        expect(latest?.results).toEqual([]);

        await act(async () => {
            tree!.update(React.createElement(Test, { query: 'alpha' }));
        });
        expect(searchFn).toHaveBeenCalledTimes(1);
        expect(latest?.results).toEqual(['alpha']);
    });
});
