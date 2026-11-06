import { afterEach, describe, expect, it } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';

const serverId = 'appearance-transport-test';
const sessionId = 'session/one';
const color = { kind: 'accent', key: 'green' } as const;
const sessionKey = buildSessionOrganizationSessionKey(serverId, sessionId);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('setSessionAppearance', () => {
    afterEach(async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer(serverId);
    });

    it('optimistically sets, confirms and clears a keyless plain Account override through its captured endpoint', async () => {
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const response = createDeferred<Response>();
        const started = createDeferred<void>();
        const requestAtEndpoint = async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            expect(path).toBe('/v2/session-organization/appearances/session%2Fone');
            const body = JSON.parse(String(init?.body));
            if (!body.display) return json({ appearance: null });
            expect(body.display).toEqual({ t: 'plain', v: { color } });
            started.resolve();
            return response.promise;
        };
        const params = { credentials: { token: 'plain-only' }, serverId, sessionId, requestAtEndpoint };
        const pending = setSessionAppearance({ ...params, color });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey[sessionKey]?.displayState)
            .toEqual({ status: 'available', value: { color } });
        await started.promise;
        response.resolve(json({ appearance: { sessionId, display: { t: 'plain', v: { color } }, updatedAt: 99 } }));
        await pending;
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey[sessionKey]).toMatchObject({ updatedAt: 99 });
        await setSessionAppearance({ ...params, color: null });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey[sessionKey]).toBeUndefined();
        expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
    });

    it('rolls back a failed older override without replacing a later confirmed override', async () => {
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const response = createDeferred<Response>();
        const started = createDeferred<void>();
        let writes = 0;
        const requestAtEndpoint = async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (++writes === 1) { started.resolve(); return response.promise; }
            return json({ appearance: { sessionId, display: JSON.parse(String(init?.body)).display, updatedAt: 11 } });
        };
        const params = { credentials: { token: 'plain-only' }, serverId, sessionId, requestAtEndpoint };
        const first = setSessionAppearance({ ...params, color: { kind: 'accent', key: 'blue' } });
        const rejection = expect(first).rejects.toThrow('write-rejected');
        await started.promise;
        await setSessionAppearance({ ...params, color });
        response.resolve(json({ error: 'write-rejected' }, 409));
        await rejection;
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey[sessionKey]?.displayState)
            .toEqual({ status: 'available', value: { color } });
        expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
    });

    it('seals an E2EE override and retains ciphertext alongside its opened display state', async () => {
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        let storedDisplay: unknown;
        const requestAtEndpoint = async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return json({ mode: 'e2ee', updatedAt: 0 });
            storedDisplay = JSON.parse(String(init?.body)).display;
            expect(storedDisplay).toMatchObject({ t: 'encrypted' });
            expect(storedDisplay).not.toHaveProperty('v');
            return json({ appearance: { sessionId, display: storedDisplay, updatedAt: 20 } });
        };
        await setSessionAppearance({ credentials: { token: 'e2ee', secret: Buffer.alloc(32, 7).toString('base64url') },
            serverId, sessionId, requestAtEndpoint, color });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey[sessionKey]).toEqual({
            sessionId, display: storedDisplay, updatedAt: 20, displayState: { status: 'available', value: { color } },
        });
    });

    it('refuses a response from a retired Account binding and rolls back its optimistic state', async () => {
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        let current = true;
        const requestAtEndpoint = async (path: string, init?: RequestInit) => {
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            current = false;
            return json({ appearance: { sessionId, display: JSON.parse(String(init?.body)).display, updatedAt: 30 } });
        };
        await expect(setSessionAppearance({ credentials: { token: 'plain' }, serverId, sessionId, color,
            requestAtEndpoint, assertCurrent: () => { if (!current) throw new Error('action_account_scope_changed'); },
        })).rejects.toThrow('action_account_scope_changed');
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey[sessionKey]).toBeUndefined();
        expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
    });
});
