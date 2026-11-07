import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { getStorage } from '@/sync/domains/state/storage';
import { UserProfileSchema } from '@happier-dev/protocol/social/friends';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, params?: Record<string, unknown>) =>
        (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { resolveAnsweredByLabel, useAnsweredByLabel } from './workflowAnsweredBy';

afterEach(standardCleanup);

const NAMED = { name: 'Ada Chen', firstName: null, lastName: null, username: null, avatarUrl: null } as const;
const UNNAMED = { name: null, firstName: null, lastName: null, username: null, avatarUrl: null } as const;
const human = { kind: 'human', accountId: 'acct-ada' } as const;

describe('resolveAnsweredByLabel', () => {
    it('names the viewer as "you" and a known person by their Account name', () => {
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-ada', profile: NAMED }))
            .toBe('workflows.run.answeredByYou');
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-bo', profile: NAMED }))
            .toBe('workflows.run.answeredBy:{"name":"Ada Chen"}');
    });

    it('falls back to an anonymous person instead of guessing when no authorized profile is held', () => {
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-bo', profile: null }))
            .toBe('workflows.run.answeredByPerson');
        expect(resolveAnsweredByLabel({ resultSource: human, viewerAccountId: 'acct-bo', profile: UNNAMED }))
            .toBe('workflows.run.answeredByPerson');
    });

    it('says nothing for results that no person answered', () => {
        expect(resolveAnsweredByLabel({ resultSource: { kind: 'execution_input' }, viewerAccountId: 'acct-bo', profile: NAMED })).toBeNull();
        expect(resolveAnsweredByLabel({ resultSource: { kind: 'published', by: 'agent' }, viewerAccountId: 'acct-bo', profile: NAMED })).toBeNull();
        expect(resolveAnsweredByLabel({ resultSource: undefined, viewerAccountId: 'acct-bo', profile: NAMED })).toBeNull();
    });
});

describe('useAnsweredByLabel cold Account profiles', () => {
    it('resolves uncached teammates through one shared People batch, without anonymous labels while pending', async () => {
        let finish!: (response: Response) => void;
        const response = new Promise<Response>(resolve => { finish = resolve; });
        const home = await serveAccountHomes({ homes: [{ key: 'primary', serverUrl: 'https://workflow-answer-people.test', accountId: 'viewer' }],
            route: request => request.path === '/v1/user/profiles' ? response : undefined });
        try {
            expect(getStorage().getState().users['fin-teammate']).toBeUndefined();
            const hook = await renderHook(() => ({
                first: useAnsweredByLabel({ kind: 'human', accountId: 'fin-teammate' }),
                repeated: useAnsweredByLabel({ kind: 'human', accountId: 'fin-teammate' }),
                second: useAnsweredByLabel({ kind: 'human', accountId: 'other-teammate' }),
                self: useAnsweredByLabel({ kind: 'human', accountId: 'viewer' }),
                agent: useAnsweredByLabel({ kind: 'published', by: 'agent' }),
            }));
            expect(hook.getCurrent()).toEqual({ first: null, repeated: null, second: null,
                self: 'workflows.run.answeredByYou', agent: null });
            const users = ['fin-teammate', 'other-teammate'].map(id => UserProfileSchema.parse({ id,
                name: id === 'fin-teammate' ? 'FIN Teammate' : 'Other Teammate', firstName: '', lastName: null,
                username: '', avatar: null, bio: null, status: 'none', publicKey: null }));
            await act(async () => { finish(Response.json({ users })); });
            await vi.waitFor(() => expect(hook.getCurrent().first).toBe('workflows.run.answeredBy:{"name":"FIN Teammate"}'));
            expect(hook.getCurrent().repeated).toBe(hook.getCurrent().first);
            expect(hook.getCurrent().second).toBe('workflows.run.answeredBy:{"name":"Other Teammate"}');
            const reads = home.requests.filter(request => request.path.startsWith('/v1/user/'));
            expect(reads.map(request => request.path)).toEqual(['/v1/user/profiles']);
            expect(reads[0]?.body).toEqual({ ids: ['fin-teammate', 'other-teammate'] });
            await hook.rerender();
            expect(home.requests.filter(request => request.path.startsWith('/v1/user/'))).toHaveLength(1);
            await hook.unmount();
        } finally { finish(Response.json({ users: [] })); await home.dispose(); }
    });

    it.each([200, 403])('uses the anonymous fallback only after the People read settles unavailable (%s)', async status => {
        let finish!: (response: Response) => void;
        const response = new Promise<Response>(resolve => { finish = resolve; });
        const home = await serveAccountHomes({ homes: [{ key: 'primary', serverUrl: `https://workflow-answer-unavailable-${status}.test`, accountId: 'viewer' }],
            route: request => request.path === '/v1/user/profiles' ? response : undefined });
        try {
            const hook = await renderHook(() => useAnsweredByLabel({ kind: 'human', accountId: 'missing-teammate' }));
            expect(hook.getCurrent()).toBeNull();
            await act(async () => { finish(Response.json(status === 200 ? { users: [] } : { error: 'forbidden' }, { status })); });
            await vi.waitFor(() => expect(hook.getCurrent()).toBe('workflows.run.answeredByPerson'));
            expect(home.requests.filter(request => request.path === '/v1/user/profiles')).toHaveLength(1);
            await hook.unmount();
        } finally { finish(Response.json({ users: [] })); await home.dispose(); }
    });
});
