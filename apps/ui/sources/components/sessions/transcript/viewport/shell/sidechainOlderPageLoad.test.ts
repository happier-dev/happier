import { describe, expect, it, vi } from 'vitest';

import {
    applySidechainOlderPageLoad,
    applySidechainPaginationOlderPageLoad,
    type SidechainOlderPageLoadResult,
} from './sidechainOlderPageLoad';

function createResult(result: Partial<SidechainOlderPageLoadResult> = {}): SidechainOlderPageLoadResult {
    return {
        loaded: result.loaded ?? 1,
        hasMore: result.hasMore ?? true,
        status: result.status ?? 'loaded',
    };
}

describe('applySidechainOlderPageLoad', () => {
    it.each([
        { name: 'no loader', hasMoreOlder: true, isLoadingOlder: false, loadOlder: null },
        { name: 'in flight', hasMoreOlder: true, isLoadingOlder: true, loadOlder: vi.fn(async () => createResult()) },
        { name: 'no more', hasMoreOlder: false, isLoadingOlder: false, loadOlder: vi.fn(async () => createResult()) },
    ])('returns null without loading for guarded state: $name', async (state) => {
        const setLoadingOlder = vi.fn();

        await expect(applySidechainOlderPageLoad({
            hasMoreOlder: state.hasMoreOlder,
            isLoadingOlder: state.isLoadingOlder,
            loadOlder: state.loadOlder,
            setHasMoreOlder: vi.fn(),
            setLoadingOlder,
        })).resolves.toBeNull();

        expect(setLoadingOlder).not.toHaveBeenCalled();
        if (state.loadOlder) {
            expect(state.loadOlder).not.toHaveBeenCalled();
        }
    });

    it('sets and clears the loading flag around the loader', async () => {
        const events: string[] = [];

        await expect(applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: vi.fn(async () => {
                events.push('load');
                return createResult();
            }),
            setHasMoreOlder: vi.fn(),
            setLoadingOlder: (loading) => {
                events.push(`loading:${loading}`);
            },
        })).resolves.toEqual(createResult());

        expect(events).toEqual(['loading:true', 'load', 'loading:false']);
    });

    it('clears the loading flag and rethrows loader failures', async () => {
        const events: string[] = [];

        await expect(applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: vi.fn(async () => {
                events.push('load');
                throw new Error('load failed');
            }),
            setHasMoreOlder: vi.fn(),
            setLoadingOlder: (loading) => {
                events.push(`loading:${loading}`);
            },
        })).rejects.toThrow('load failed');

        expect(events).toEqual(['loading:true', 'load', 'loading:false']);
    });

    it.each([
        createResult({ status: 'no_more' }),
        createResult({ hasMore: false }),
    ])('clears has-more state from load result %j', async (loadResult) => {
        const setHasMoreOlder = vi.fn();

        await expect(applySidechainOlderPageLoad({
            hasMoreOlder: true,
            isLoadingOlder: false,
            loadOlder: vi.fn(async () => loadResult),
            setHasMoreOlder,
            setLoadingOlder: vi.fn(),
        })).resolves.toEqual(loadResult);

        expect(setHasMoreOlder).toHaveBeenCalledOnce();
        expect(setHasMoreOlder).toHaveBeenCalledWith(false);
    });
});

describe('applySidechainPaginationOlderPageLoad', () => {
    it('returns no-more without calling the older-page loader when pagination is exhausted', async () => {
        const loadOlder = vi.fn(async () => createResult());

        await expect(applySidechainPaginationOlderPageLoad({
            hasMoreOlder: false,
            loadOlder,
        })).resolves.toEqual({
            loaded: 0,
            hasMore: false,
            status: 'no_more',
        });

        expect(loadOlder).not.toHaveBeenCalled();
    });

    it('delegates to the older-page operation while more pages remain', async () => {
        const loadOlder = vi.fn(async () => createResult({ loaded: 3 }));

        await expect(applySidechainPaginationOlderPageLoad({
            hasMoreOlder: true,
            loadOlder,
        })).resolves.toEqual(createResult({ loaded: 3 }));

        expect(loadOlder).toHaveBeenCalledOnce();
    });
});
