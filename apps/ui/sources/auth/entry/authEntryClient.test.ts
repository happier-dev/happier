import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol';

const serverFetch = vi.hoisted(() => vi.fn());
const endpointFetch = vi.hoisted(() => vi.fn());
const authorityFetch = vi.hoisted(() => vi.fn());
const runWithServerRequestAuthorityForServerAccountScope = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch,
    createServerFetchAtEndpoint: vi.fn(() => endpointFetch),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    runWithServerRequestAuthorityForServerAccountScope,
}));

import { fetchAuthEntry, fetchHomeAuthEntry } from './authEntryClient';

describe('fetchHomeAuthEntry', () => {
    beforeEach(() => {
        serverFetch.mockReset();
        endpointFetch.mockReset();
        authorityFetch.mockReset();
        runWithServerRequestAuthorityForServerAccountScope.mockReset();
        runWithServerRequestAuthorityForServerAccountScope.mockImplementation(
            async (_params: unknown, operation: (authority: unknown) => Promise<unknown>) =>
                await operation({ request: authorityFetch }),
        );
    });

    it('parses the current projection and rejects malformed new shapes', async () => {
        serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [{
                kind: 'authenticate',
                methodId: 'acme',
                action: 'login',
                mode: 'keyless',
                origin: 'home',
                presentation: { displayName: 'Acme' },
            }],
            autoRedirect: null,
        }), { status: 200 }));
        await expect(fetchHomeAuthEntry()).resolves.toMatchObject({ kind: 'ready' });
        expect(serverFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ v: 1, scope: { kind: 'home' } }),
        }), { includeAuth: false, retry: 'none' });

        serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 2,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [],
            autoRedirect: null,
        }), { status: 200 }));
        await expect(fetchHomeAuthEntry()).resolves.toEqual({ kind: 'incompatible' });
    });

    it('reports endpoint absence separately so released Home fallback stays bounded', async () => {
        serverFetch.mockResolvedValueOnce(new Response('', { status: 404 }));
        await expect(fetchHomeAuthEntry()).resolves.toEqual({ kind: 'unsupported' });
    });

    it('forwards a Home email hint to the existing entry authority without choosing a provider locally', async () => {
        serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'home' },
            reason: 'entry_not_available',
            autoRedirect: null,
        }), { status: 200 }));

        await expect(fetchHomeAuthEntry({ email: 'person@acme.example' })).resolves.toMatchObject({
            kind: 'ready', projection: { state: 'unavailable' },
        });
        expect(serverFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.objectContaining({
            body: JSON.stringify({ v: 1, scope: { kind: 'home' }, email: 'person@acme.example' }),
        }), { includeAuth: false, retry: 'none' });
    });

    it('posts an immutable Team scope only to the supplied explicit Home endpoint', async () => {
        endpointFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'entry_not_available',
            autoRedirect: null,
        }), { status: 200 }));

        await expect(fetchAuthEntry({
            scope: { kind: 'team', teamId: 'team_1' },
            endpointUrl: 'https://home.example.test',
            serverId: 'home_1',
        })).resolves.toMatchObject({ kind: 'ready' });
        expect(serverFetch).not.toHaveBeenCalled();
        expect(endpointFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ v: 1, scope: { kind: 'team', teamId: 'team_1' } }),
        }), { includeAuth: false, retry: 'none' });
    });

    it('posts the exact native verification bearer only as the strict auth-entry request scope', async () => {
        const verificationToken = 'v'.repeat(43);
        endpointFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'invitation' },
            reason: 'entry_not_available',
            autoRedirect: null,
        }), { status: 200 }));

        await expect(fetchAuthEntry({
            scope: { kind: 'native_email_verification', token: verificationToken },
            endpointUrl: 'https://home.example.test',
            serverId: 'home_1',
        })).resolves.toMatchObject({ kind: 'ready' });
        expect(endpointFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                v: 1,
                scope: { kind: 'native_email_verification', token: verificationToken },
            }),
        }), { includeAuth: false, retry: 'none' });
    });

    it('asks as the exact authenticated Account when a caller supplies its scope', async () => {
        authorityFetch.mockResolvedValueOnce(new Response(JSON.stringify({
            v: 1,
            state: 'already_member',
            scope: { kind: 'team' },
            home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
            account: { firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: null },
            team: { teamId: 'team_1', name: 'Acme', logo: null },
            actions: [{ kind: 'continue' }],
            autoRedirect: null,
        }), { status: 200 }));

        await expect(fetchAuthEntry({
            scope: { kind: 'team', teamId: 'team_1' },
            endpointUrl: 'https://home.example.test',
            serverId: 'home_1',
            accountScope: { serverId: 'home_1', accountId: 'account_1' },
        })).resolves.toMatchObject({ kind: 'ready', projection: { state: 'already_member' } });

        // The credential comes from the canonical request-authority owner for
        // that exact Home and Account, never from ambient focused-Home state.
        expect(runWithServerRequestAuthorityForServerAccountScope).toHaveBeenCalledWith(
            expect.objectContaining({ scope: { serverId: 'home_1', accountId: 'account_1' } }),
            expect.any(Function),
        );
        expect(authorityFetch).toHaveBeenCalledWith('/v1/auth/entry', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ v: 1, scope: { kind: 'team', teamId: 'team_1' } }),
        }));
        expect(endpointFetch).not.toHaveBeenCalled();
        expect(serverFetch).not.toHaveBeenCalled();
    });

    it('does not fall back to an anonymous projection when exact authority fails', async () => {
        runWithServerRequestAuthorityForServerAccountScope.mockRejectedValueOnce(
            new Error('Account-scoped request authenticated account does not match requested scope'),
        );
        await expect(fetchAuthEntry({
            scope: { kind: 'team', teamId: 'team_1' },
            endpointUrl: 'https://home.example.test',
            serverId: 'home_1',
            accountScope: { serverId: 'home_1', accountId: 'account_1' },
        })).resolves.toEqual({ kind: 'unavailable' });
        expect(endpointFetch).not.toHaveBeenCalled();
    });

    it('rejects a declared oversized response before reading its JSON', async () => {
        const cancel = vi.fn(async () => undefined);
        const json = vi.fn(async () => ({
            v: 1,
            state: 'ready',
            scope: { kind: 'home' },
            actions: [],
            autoRedirect: null,
        }));
        serverFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 + 1) }),
            body: { cancel },
            json,
        });

        await expect(fetchHomeAuthEntry()).resolves.toEqual({ kind: 'incompatible' });
        expect(cancel).toHaveBeenCalledOnce();
        expect(json).not.toHaveBeenCalled();
    });

    it('cancels a streamed response once it exceeds the pre-auth metadata byte budget', async () => {
        const cancel = vi.fn(async () => undefined);
        const releaseLock = vi.fn();
        const read = vi.fn()
            .mockResolvedValueOnce({ done: false, value: new Uint8Array(FEATURES_RESPONSE_MAX_UTF8_BYTES_V1) })
            .mockResolvedValueOnce({ done: false, value: new Uint8Array([0x20]) });
        serverFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
            body: { getReader: () => ({ read, cancel, releaseLock }) },
        });

        await expect(fetchHomeAuthEntry()).resolves.toEqual({ kind: 'incompatible' });
        expect(cancel).toHaveBeenCalledOnce();
        expect(releaseLock).toHaveBeenCalledOnce();
    });
});
