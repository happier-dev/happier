import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { useTeamPagedList, type TeamPageOutcome } from './useTeamPagedList';

function ok(items: readonly string[], nextCursor: string | null): TeamPageOutcome<string> {
    return { kind: 'succeeded', value: { items, nextCursor } };
}

const UNREACHABLE: HomeDomainFailure = { kind: 'unreachable', retryable: true, code: null };
const FORBIDDEN: HomeDomainFailure = { kind: 'forbidden', retryable: false, code: null };

function fail(): TeamPageOutcome<string> {
    return { kind: 'failed', failure: UNREACHABLE };
}

describe('useTeamPagedList', () => {
    it.each([
        { failure: UNREACHABLE, rows: ['a', 'b'], hasMore: true },
        { failure: FORBIDDEN, rows: [], hasMore: false },
    ])('handles $failure.kind during continuation revalidation without publishing a partial refresh', async ({ failure, rows, hasMore }) => {
        const loadPage = vi.fn()
            .mockResolvedValueOnce(ok(['a'], 'c1'))
            .mockResolvedValueOnce(ok(['b'], 'c2'))
            .mockResolvedValueOnce(ok(['changed-a'], 'fresh-c1'))
            .mockResolvedValueOnce({ kind: 'failed', failure });
        const rendered = await renderHook(() => useTeamPagedList<string>({ key: 'k', enabled: true, loadPage }));
        await vi.waitFor(() => expect(rendered.getCurrent().status).toBe('ready'));
        await rendered.getCurrent().loadMore();
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a', 'b']));
        await rendered.getCurrent().reload();
        await vi.waitFor(() => expect(rendered.getCurrent().status).toBe('error'));
        expect(rendered.getCurrent().rows).toEqual(rows);
        expect(rendered.getCurrent().hasMore).toBe(hasMore);
        expect(rendered.getCurrent().error).toEqual(failure);
        await rendered.unmount();
    });

    it('revalidates loaded continuation rows on AccountChange and withdraws removed rows', async () => {
        const loadPage = vi.fn()
            .mockResolvedValueOnce(ok(['a', 'revoked'], 'c1'))
            .mockResolvedValueOnce(ok(['c', 'd'], 'c2'))
            .mockResolvedValueOnce(ok(['a', 'c'], 'fresh-c1'))
            .mockResolvedValueOnce(ok(['d', 'e'], 'fresh-c2'));
        const rendered = await renderHook(() => useTeamPagedList<string>({
            key: 'k', enabled: true, loadPage,
            accountChange: { serverId: 'home-a', entityId: 'teams' },
        }));
        await vi.waitFor(() => expect(rendered.getCurrent().status).toBe('ready'));
        await rendered.getCurrent().loadMore();
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a', 'revoked', 'c', 'd']));
        publishHomeAccountChange('home-a', ['teams']);
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a', 'c', 'd', 'e']));
        expect(rendered.getCurrent().hasMore).toBe(true);
        expect(loadPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'c1', null, 'fresh-c1']);
        await rendered.unmount();
    });

    it('accumulates pages in the Home order and stops when no cursor remains', async () => {
        const loadPage = vi.fn()
            .mockResolvedValueOnce(ok(['a', 'b'], 'c1'))
            .mockResolvedValueOnce(ok(['c'], null));

        const rendered = await renderHook(() => useTeamPagedList<string>({
            key: 'k',
            enabled: true,
            loadPage,
        }));
        await vi.waitFor(() => expect(rendered.getCurrent().status).toBe('ready'));
        expect(rendered.getCurrent().rows).toEqual(['a', 'b']);
        expect(rendered.getCurrent().hasMore).toBe(true);

        await rendered.getCurrent().loadMore();
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a', 'b', 'c']));
        expect(rendered.getCurrent().hasMore).toBe(false);
        expect(loadPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'c1']);
        await rendered.unmount();
    });

    it('accepts a continuation fired as soon as the ready page is committed', async () => {
        // A ready row can become pressable in the same commit that publishes
        // the first page. Its handler must not observe the completed request as
        // still in flight and silently discard the continuation.
        const loadPage = vi.fn()
            .mockResolvedValueOnce(ok(['a'], 'c1'))
            .mockResolvedValueOnce(ok(['b'], null));
        let continued = false;

        const rendered = await renderHook(() => {
            const list = useTeamPagedList<string>({ key: 'k', enabled: true, loadPage });
            React.useLayoutEffect(() => {
                if (continued || list.status !== 'ready' || !list.hasMore) return;
                continued = true;
                void list.loadMore();
            }, [list]);
            return list;
        });

        await vi.waitFor(() => {
            expect(loadPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'c1']);
        });
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a', 'b']));
        await rendered.unmount();
    });

    it('keeps the pages already read on screen when a later page fails', async () => {
        const loadPage = vi.fn()
            .mockResolvedValueOnce(ok(['a'], 'c1'))
            .mockResolvedValueOnce(fail());

        const rendered = await renderHook(() => useTeamPagedList<string>({
            key: 'k',
            enabled: true,
            loadPage,
        }));
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a']));

        await rendered.getCurrent().loadMore();
        await vi.waitFor(() => expect(rendered.getCurrent().status).toBe('error'));
        // An empty roster would be a worse answer than a partial one plus a retry.
        expect(rendered.getCurrent().rows).toEqual(['a']);
        expect(rendered.getCurrent().error).toEqual(UNREACHABLE);
        await rendered.unmount();
    });

    it('withdraws authority-bearing rows when the current Home refuses access', async () => {
        const loadPage = vi.fn()
            .mockResolvedValueOnce(ok(['member-a'], 'c1'))
            .mockResolvedValueOnce({ kind: 'failed', failure: FORBIDDEN });

        const rendered = await renderHook(() => useTeamPagedList<string>({
            key: 'k',
            enabled: true,
            loadPage,
        }));
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['member-a']));

        await rendered.getCurrent().reload();
        await vi.waitFor(() => expect(rendered.getCurrent().status).toBe('error'));
        expect(rendered.getCurrent().rows).toEqual([]);
        expect(rendered.getCurrent().hasMore).toBe(false);
        expect(rendered.getCurrent().error).toEqual(FORBIDDEN);
        await rendered.unmount();
    });

    it('reloads a mounted Team page for its exact Home on Team AccountChange only', async () => {
        const loadPage = vi.fn().mockResolvedValue(ok(['member-a'], null));
        const rendered = await renderHook(() => useTeamPagedList<string>({
            key: 'k',
            enabled: true,
            loadPage,
            accountChange: { serverId: 'home-a', entityId: 'teams' },
        }));
        await vi.waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));

        publishHomeAccountChange('home-b');
        publishHomeAccountChange('home-a', ['home-governance']);
        await Promise.resolve();
        expect(loadPage).toHaveBeenCalledTimes(1);

        publishHomeAccountChange('home-a', ['teams']);
        await vi.waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
        await rendered.unmount();
    });

    it('starts a new sequence when the key changes and ignores the superseded answer', async () => {
        let releaseFirst: (value: TeamPageOutcome<string>) => void = () => {};
        const first = new Promise<TeamPageOutcome<string>>((resolve) => { releaseFirst = resolve; });
        const loadPage = vi.fn()
            .mockReturnValueOnce(first)
            .mockResolvedValueOnce(ok(['fresh'], null));

        const rendered = await renderHook(
            (props: Readonly<{ key: string }>) => useTeamPagedList<string>({
                key: props.key,
                enabled: true,
                loadPage,
            }),
            { initialProps: { key: 'first' } },
        );
        const firstSignal = loadPage.mock.calls[0]?.[1] as AbortSignal | undefined;

        await rendered.rerender({ key: 'second' });
        expect(firstSignal?.aborted).toBe(true);
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['fresh']));

        // The first sequence's answer arrives after it was superseded.
        releaseFirst(ok(['stale'], 'c1'));
        await Promise.resolve();
        expect(rendered.getCurrent().rows).toEqual(['fresh']);
        expect(rendered.getCurrent().hasMore).toBe(false);
        const currentSignal = loadPage.mock.calls[1]?.[1] as AbortSignal | undefined;
        await rendered.unmount();
        expect(currentSignal?.aborted).toBe(true);
    });

    it('claims nothing and asks nothing while disabled', async () => {
        const loadPage = vi.fn();
        const rendered = await renderHook(() => useTeamPagedList<string>({
            key: 'k',
            enabled: false,
            loadPage,
        }));

        expect(loadPage).not.toHaveBeenCalled();
        expect(rendered.getCurrent().rows).toEqual([]);
        expect(rendered.getCurrent().status).toBe('loading');
        await rendered.unmount();
    });

    it('does not start a second continuation while one is in flight', async () => {
        let releaseSecond: (value: TeamPageOutcome<string>) => void = () => {};
        const second = new Promise<TeamPageOutcome<string>>((resolve) => { releaseSecond = resolve; });
        const loadPage = vi.fn()
            .mockResolvedValueOnce(ok(['a'], 'c1'))
            .mockReturnValueOnce(second);

        const rendered = await renderHook(() => useTeamPagedList<string>({
            key: 'k',
            enabled: true,
            loadPage,
        }));
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a']));

        void rendered.getCurrent().loadMore();
        void rendered.getCurrent().loadMore();
        releaseSecond(ok(['b'], null));
        await vi.waitFor(() => expect(rendered.getCurrent().rows).toEqual(['a', 'b']));

        expect(loadPage).toHaveBeenCalledTimes(2);
        await rendered.unmount();
    });
});
