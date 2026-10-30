import { describe, expect, it } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { ServerFetch } from '@/sync/http/client';
import { InitialChangesCursor } from './initialChangesCursor';

const credentials = { token: 'synthetic-account-token', secret: 'synthetic-account-material' } satisfies AuthCredentials;
const scope = { serverId: 'initial-home', serverUrl: 'https://initial.example.test', accountId: 'initial-account', credentials };
const cursorResponse = (cursor: number) => Response.json({ cursor, changesFloor: 0 });

describe('initial snapshot change base', () => {
    it('joins one pending physical read, retains its cut for the same authority and never replaces a current checkpoint', async () => {
        const owner = new InitialChangesCursor();
        const response = createDeferred<Response>();
        const paths: string[] = [];
        const request: ServerFetch = async path => { paths.push(path); return response.promise; };
        const params = { ...scope, currentCursor: null, request, isCurrent: () => true };
        const first = owner.capture(params);
        const second = owner.capture({ ...params, credentials: { ...credentials } });
        expect(paths).toEqual(['/v2/cursor']);
        response.resolve(cursorResponse(37));
        expect(await Promise.all([first, second])).toEqual(['37', '37']);
        expect(await owner.capture(params)).toBe('37');
        expect(await owner.capture({ ...params, currentCursor: '88' })).toBe('88');
        expect(paths).toEqual(['/v2/cursor']);
    });

    it.each([
        { serverId: 'different-home' },
        { serverUrl: 'https://different.example.test' },
        { accountId: 'different-account' },
        { credentials: { ...credentials, token: 'different-authority' } },
        { credentials: { ...credentials, secret: 'different-account-material' } },
        { sessionId: 'child-session' },
    ])('captures a new base after the scope changes: %j', async changed => {
        const owner = new InitialChangesCursor();
        let reads = 0;
        const request: ServerFetch = async () => cursorResponse(++reads === 1 ? 37 : 73);
        const params = { ...scope, currentCursor: null, request, isCurrent: () => true };
        expect(await owner.capture(params)).toBe('37');
        expect(await owner.capture({ ...params, ...changed })).toBe('73');
        expect(reads).toBe(2);
    });

    it('retains neither failed captures nor captures completed after their scope retires', async () => {
        const owner = new InitialChangesCursor();
        const held = createDeferred<Response>();
        let current = true;
        let reads = 0;
        const request: ServerFetch = async () => {
            reads += 1;
            return reads === 1 ? new Response(null, { status: 503 }) : reads === 2 ? held.promise : cursorResponse(73);
        };
        const params = { ...scope, currentCursor: null, request, isCurrent: () => current };
        expect(await owner.capture(params)).toBeNull();
        const pending = owner.capture(params);
        current = false;
        held.resolve(cursorResponse(37));
        expect(await pending).toBeNull();
        current = true;
        expect(await owner.capture(params)).toBe('73');
        expect(reads).toBe(3);
        owner.reset();
        expect(await owner.capture(params)).toBe('73');
        expect(reads).toBe(4);
    });

    it('does not let an old pending scope replace the new scope or survive explicit retirement', async () => {
        const owner = new InitialChangesCursor();
        const held = createDeferred<Response>();
        const old = owner.capture({ ...scope, currentCursor: null, request: async () => held.promise, isCurrent: () => true });
        const next = { ...scope, accountId: 'new-account', currentCursor: null,
            request: async () => cursorResponse(73), isCurrent: () => true };
        expect(await owner.capture(next)).toBe('73');
        held.resolve(cursorResponse(37));
        expect(await old).toBeNull();
        expect(await owner.capture(next)).toBe('73');
        const retired = new InitialChangesCursor();
        const response = createDeferred<Response>();
        const pending = retired.capture({ ...next, request: async () => response.promise });
        retired.reset();
        response.resolve(cursorResponse(99));
        expect(await pending).toBeNull();
    });
});
