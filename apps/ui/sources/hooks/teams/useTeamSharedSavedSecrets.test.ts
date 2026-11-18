import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLayoutEffect } from 'react';
import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretListOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useTeamSharedSavedSecrets } = await import('./useTeamSharedSavedSecrets');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const PATH = '/v1/account/saved-secrets/resources';
const row = (id: string) => SavedSecretCatalogEntryV1Schema.parse({
    ref: `happier:shared-secret:v1:${id}`, source: 'shared_resource', relationship: 'recipient', name: id,
    kind: 'token', revision: 1, materialStatus: 'ready',
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
});

beforeEach(async () => { await homes.reset(); resetTeamActionClientForTests(); });
afterEach(() => { resetTeamActionClientForTests(); standardCleanup(); });

describe('useTeamSharedSavedSecrets', () => {
    it('renders both observed pages on the first return and revalidates the range', async () => {
        const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://saved-secrets-return.test', accountId: 'member' });
        const scope = createServerAccountScope(serverId, 'member')!;
        const first = row('first');
        const second = row('second');
        const returnedFirst = row('updated-first');
        const pending = createDeferred<void>();
        let returning = false;
        homes.answer(serverId, PATH, { select: (_input, request) => {
            const cursor = new URL(request.url).searchParams.get('cursor');
            return {
                body: SharedSavedSecretListOutputV1Schema.parse({
                    resources: cursor ? [second] : [returning ? returnedFirst : first], nextCursor: cursor ? null : 'first',
                }),
                ...(returning ? { respondAfter: pending.promise } : {}),
            };
        } });
        const useList = () => useTeamSharedSavedSecrets({
            scope, address: { serverId, teamId: 'team-a' }, enabled: true, pageSize: 1,
        });
        const initial = await renderHook(useList);
        await waitForHomeGovernance(() => expect(initial.getCurrent().rows).toEqual([first]));
        await act(async () => initial.getCurrent().loadMore());
        expect(initial.getCurrent().rows).toEqual([first, second]);
        await initial.unmount();

        returning = true;
        const commits: Array<ReturnType<typeof useList>> = [];
        const remounted = await renderHook(() => {
            const result = useList();
            useLayoutEffect(() => { commits.push(result); }, [result]);
            return result;
        });
        expect(commits[0]).toMatchObject({ rows: [first, second], status: 'refreshing', hasMore: false });
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(remounted.getCurrent()).toMatchObject({
            rows: [returnedFirst, second], status: 'ready', hasMore: false,
        }));
        expect(homes.requests.filter(request => request.path.split('?')[0] === PATH)).toHaveLength(4);
        await remounted.unmount();
    });

    it('requests only demanded Team metadata pages and releases demand while hidden', async () => {
        const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://saved-secrets.test', accountId: 'member' });
        const scope = createServerAccountScope(serverId, 'member')!;
        const first = row('first');
        const second = row('second');
        let currentFirst = first;
        const queries: URLSearchParams[] = [];
        homes.answer(serverId, PATH, { select: (_input, request) => {
            const query = new URL(request.url).searchParams;
            queries.push(query);
            return { body: SharedSavedSecretListOutputV1Schema.parse({
                resources: query.has('cursor') ? [second] : [currentFirst], nextCursor: query.has('cursor') ? null : 'first',
            }) };
        } });
        const hook = await renderHook((props: { enabled: boolean; teamId: string }) => useTeamSharedSavedSecrets({
            scope, address: { serverId, teamId: props.teamId }, enabled: props.enabled, pageSize: 1,
        }), { initialProps: { enabled: false, teamId: 'team-a' } });
        expect(queries).toHaveLength(0);
        await hook.rerender({ enabled: true, teamId: 'team-a' });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().rows).toEqual([first]);
        expect(queries.map(query => Object.fromEntries(query))).toEqual([{ sharedWithTeamId: 'team-a', limit: '1' }]);
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().rows).toEqual([first, second]);
        expect(hook.getCurrent().hasMore).toBe(false);
        expect(Object.fromEntries(queries[1]!)).toEqual({ sharedWithTeamId: 'team-a', cursor: 'first', limit: '1' });
        expect(homes.requests.filter(request => request.path.split('?')[0] === `${PATH}/materials`)).toHaveLength(0);
        const loadedReads = queries.length;
        await act(async () => {
            publishHomeAccountChange(serverId, ['session'], { changeKinds: ['session'], savedSecretCatalogAffects: false });
        });
        await flushHookEffects();
        expect(queries).toHaveLength(loadedReads);
        currentFirst = { ...first, name: 'Updated metadata' };
        await act(async () => {
            publishHomeAccountChange(serverId, ['first'], { changeKinds: ['savedSecretResource'] });
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([currentFirst, second]));
        expect(queries).toHaveLength(loadedReads + 2);
        await hook.rerender({ enabled: false, teamId: 'team-a' });
        expect(hook.getCurrent().rows).toEqual([]);
        const reads = queries.length;
        publishHomeAccountChange(serverId, ['secret'], { changeKinds: ['savedSecretResource'] });
        await hook.getCurrent().reload();
        expect(queries).toHaveLength(reads);
        await hook.rerender({ enabled: true, teamId: 'team-b' });
        await waitForHomeGovernance(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(Object.fromEntries(queries.at(-1)!)).toEqual({ sharedWithTeamId: 'team-b', limit: '1' });
        const readsBeforeAccountSwitch = queries.length;
        await act(async () => { await homes.switchAccount(serverId, 'different-member'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([]));
        expect(queries).toHaveLength(readsBeforeAccountSwitch);
        await hook.unmount();
    });

    it('retains metadata on transport failure and withdraws it on access loss', async () => {
        const serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://saved-secrets-access.test', accountId: 'member' });
        const scope = createServerAccountScope(serverId, 'member')!;
        const pending = createDeferred<void>();
        const first = row('first');
        homes.answer(serverId, PATH, { body: SharedSavedSecretListOutputV1Schema.parse({ resources: [first], nextCursor: null }), respondAfter: pending.promise });
        const hook = await renderHook(() => useTeamSharedSavedSecrets({ scope, address: { serverId, teamId: 'team-a' }, enabled: true, pageSize: 1 }));
        expect(hook.getCurrent().status).toBe('loading');
        await act(async () => { pending.resolve(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().rows).toEqual([first]));
        homes.answer(serverId, PATH, { status: 503, body: { error: 'unavailable' } });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().rows).toEqual([first]);
        homes.answer(serverId, PATH, { status: 403, body: { error: 'forbidden' } });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().rows).toEqual([]);
        expect(hook.getCurrent().error?.kind).toBe('forbidden');
        homes.answer(serverId, PATH, { body: SharedSavedSecretListOutputV1Schema.parse({ resources: [], nextCursor: null }) });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', rows: [], error: null, hasMore: false });
        await hook.unmount();
    });
});
