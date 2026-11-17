import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { useAutomationSubjectPicker } from './useAutomationSubjectPicker';

await initializeRealAppRuntimeForTests();
afterEach(standardCleanup);

it('demands one addressed App page at a time, preserves partial coverage and retries a failed continuation', async () => {
    let failContinuation = true;
    const reads: URL[] = [];
    const home = await serveActionHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://subject-picker-addressed.test', accountId: 'author' },
        { key: 'focused', serverUrl: 'https://subject-picker-focused.test', accountId: 'other' },
    ], route: request => {
        if (request.path !== '/v1/projects/sources') return undefined;
        expect(request.home).toBe('addressed');
        expect(request.accountId).toBe('author');
        reads.push(request.url);
        if (request.url.searchParams.has('cursor') && failContinuation) return Response.json({ error: 'offline' }, { status: 503 });
        const second = request.url.searchParams.has('cursor');
        return Response.json({ ok: true, sources: [{ id: second ? 'source-b' : 'source-a', revision: 1,
            name: second ? 'Second App' : 'First App', audience: [], createdByAccountId: 'author' }],
        coverage: { complete: false, nextCursor: second ? null : 'page-two' } });
    } });
    const account = await captureLazyActionAccountContext(home.homes.addressed!.id);
    try {
        const hook = await renderHook((props: { demanded: boolean }) => useAutomationSubjectPicker({
            kind: { kind: 'app' }, lifetime: account.accountLifetime, demanded: props.demanded,
            query: 'store', limit: 7,
        }), { initialProps: { demanded: false } });
        expect(hook.getCurrent().status).toBe('idle');
        expect(reads).toHaveLength(0);
        await hook.rerender({ demanded: true });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent()).toMatchObject({ coverage: 'partial', hasMore: true,
            items: [{ label: 'First App', subject: { kind: 'app', serverId: home.homes.addressed!.id, projectSourceId: 'source-a' } }] });
        expect(reads).toHaveLength(1);
        expect(reads[0]!.searchParams.get('query')).toBe('store');
        expect(reads[0]!.searchParams.get('limit')).toBe('7');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().error).toBeInstanceOf(Error);
        expect(hook.getCurrent().items).toHaveLength(1);
        failContinuation = false;
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', coverage: 'partial', hasMore: false });
        expect(hook.getCurrent().items.map(item => item.label)).toEqual(['First App', 'Second App']);
        expect(reads.map(url => url.searchParams.get('cursor'))).toEqual([null, 'page-two', 'page-two']);
        await hook.unmount();
    } finally { account.dispose(); await home.dispose(); }
});

it('withdraws a retired borrowed Account and ignores its in-flight answer without acquiring the focused Account', async () => {
    const pending = createDeferred<Response>();
    const reads: string[] = [];
    const home = await serveActionHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://subject-picker-retired.test', accountId: 'author' },
        { key: 'focused', serverUrl: 'https://subject-picker-other.test', accountId: 'other' },
    ], route: request => {
        if (request.path !== '/v1/projects/sources') return undefined;
        reads.push(request.home);
        return pending.promise;
    } });
    const account = await captureLazyActionAccountContext(home.homes.addressed!.id);
    try {
        const hook = await renderHook(() => useAutomationSubjectPicker({ kind: { kind: 'app' },
            lifetime: account.accountLifetime, demanded: true }));
        await vi.waitFor(() => expect(reads).toEqual(['addressed']));
        await act(async () => { await home.switchAccount('addressed', 'replacement'); });
        expect(hook.getCurrent()).toMatchObject({ status: 'idle', items: [], hasMore: false });
        await act(async () => { pending.resolve(Response.json({ ok: true,
            sources: [{ id: 'stale', revision: 1, name: 'Stale App', audience: [], createdByAccountId: 'author' }],
            coverage: { complete: true, nextCursor: null } })); });
        expect(hook.getCurrent()).toMatchObject({ status: 'idle', items: [] });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(reads).toEqual(['addressed']);
        await hook.unmount();
    } finally { account.dispose(); await home.dispose(); }
});
