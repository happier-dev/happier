import { describe, expect, it, vi } from 'vitest';

import { getUserProfiles } from './apiFriends';

describe('exact People profile batch', () => {
    it('degrades to unnamed people on a released Home without the batch route, without singleton fallback', async () => {
        const request = vi.fn(async () => new Response('{}', { status: 404 }));
        expect(await getUserProfiles({ token: 'test-token', secret: 'test-secret' }, ['editor-a', 'editor-b'],
            { request, retry: 'none' })).toEqual([]);
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('reads the requested people in one request without a per-person fallback', async () => {
        const people = ['editor-a', 'editor-b'].map(id => ({ id, name: id === 'editor-a' ? 'Ada Chen' : 'Bo Lindqvist',
            firstName: '', lastName: null, avatar: null, username: '', bio: null, badges: [], status: 'none', publicKey: null }));
        // HTTP is the system boundary. Both current singleton and batch responses are valid,
        // so RED distinguishes the request cost rather than a fixture/response mismatch.
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            const id = path.split('/').at(-1);
            const person = people.find(row => row.id === id);
            const payload = init?.method === 'POST' ? { users: people } : person ? { user: person } : { error: 'User not found' };
            return new Response(JSON.stringify(payload), { status: init?.method === 'POST' || person ? 200 : 404,
                headers: { 'Content-Type': 'application/json' } });
        });
        const result = await getUserProfiles({ token: 'test-token', secret: 'test-secret' },
            ['editor-a', 'editor-b', 'editor-a'], { request, retry: 'none' });
        expect(request).toHaveBeenCalledTimes(1);
        expect(result).toEqual(people);
        expect(request.mock.calls[0]?.[0]).toBe('/v1/user/profiles');
        expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
        expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ ids: ['editor-a', 'editor-b'] });
    });
});
