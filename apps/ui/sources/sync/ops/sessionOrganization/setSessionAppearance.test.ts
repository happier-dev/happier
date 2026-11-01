import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import type { SessionOrganizationContentEnvelope } from '@happier-dev/protocol';

const http = vi.hoisted(() => ({ serverFetch: vi.fn(), runtimeFetchWithServerReachability: vi.fn() }));
// HTTP is the boundary; encryption, protocol parsing, operations and the real store run unchanged.
vi.mock('@/sync/http/client', () => ({ serverFetch: http.serverFetch }));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({ runtimeFetchWithServerReachability: http.runtimeFetchWithServerReachability }));

const credentials = { token: 'appearance-test', secret: Buffer.alloc(32, 7).toString('base64url') };
const context = { credentials, serverId: 'appearance-server', sessionId: 's1' };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('setSessionAppearance', () => {
    it('opens a snapshot containing only encrypted appearance displays and records server support', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        http.serverFetch.mockResolvedValueOnce(json({ mode: 'e2ee', updatedAt: 0 }));
        const color = { kind: 'custom', hex: '#123456' };
        const display = await prepareSessionOrganizationDisplayEnvelope({ credentials, value: { color } });
        http.serverFetch.mockResolvedValueOnce(json({ snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [], sessionAppearances: [{ sessionId: 's1', display, updatedAt: 9 }] } }));
        await fetchAndApplySessionOrganizationSnapshot({ credentials, serverId: context.serverId, request: { includeSessionAppearances: true } });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display).toEqual({ t: 'plain', v: { color } });
        expect(getStorage().getState().sessionOrganizationSessionAppearancesSupportedByServerId[context.serverId]).toBe(true);
    });
    beforeEach(async () => {
        http.serverFetch.mockReset();
        http.runtimeFetchWithServerReachability.mockReset();
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        invalidateAccountEncryptionModeCache();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer(context.serverId);
    });

    it('seals according to the destination server account mode when editing a row from another server', async () => {
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const serverUrl = 'https://appearance-server.example';
        http.serverFetch.mockImplementation(async (path: string) => json({ mode: path.startsWith(serverUrl) ? 'plain' : 'e2ee', updatedAt: 0 }));
        let sentDisplay: unknown;
        http.runtimeFetchWithServerReachability.mockImplementation(async ({ init }) => {
            const { display } = JSON.parse(String(init.body));
            sentDisplay = display;
            return json({ appearance: { sessionId: 's1', display, updatedAt: 10 } });
        });
        const color = { kind: 'accent', key: 'green' } as const;
        await setSessionAppearance({ ...context, serverUrl, color });
        expect(sentDisplay).toEqual({ t: 'plain', v: { color } });
    });

    it.each(['plain', 'e2ee'] as const)('optimistically applies, seals, reconciles and clears an override for %s accounts', async (mode) => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { openSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        let sentDisplay: SessionOrganizationContentEnvelope | null = null;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode, updatedAt: 0 });
            expect(path).toBe('/v2/session-organization/appearances/s1');
            const body = JSON.parse(String(init?.body));
            sentDisplay = body.display;
            return json({ appearance: body.display ? { sessionId: 's1', display: body.display, updatedAt: 99 } : null });
        });
        const color = { kind: 'custom', hex: '#AABBCC' } as const;
        const pending = setSessionAppearance({ ...context, color: { kind: 'custom', hex: '#abc' } });
        const optimisticDisplay = getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display;
        await pending;
        expect(optimisticDisplay).toEqual({ t: 'plain', v: { color } });
        expect(sentDisplay).toMatchObject({ t: mode === 'e2ee' ? 'encrypted' : 'plain' });
        await expect(openSessionOrganizationDisplayEnvelope({ credentials, envelope: sentDisplay })).resolves.toEqual({ t: 'plain', v: { color } });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']).toMatchObject({ updatedAt: 99, display: { t: 'plain', v: { color } } });
        await setSessionAppearance({ ...context, color: null });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']).toBeUndefined();
        expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
    });

    it('surfaces a write rejection and restores the previous override without touching a later confirmed write', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const firstResponse = createDeferred<Response>();
        const firstRequest = createDeferred<void>();
        let requests = 0;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode: 'plain', updatedAt: 0 });
            requests += 1;
            if (requests === 1) { firstRequest.resolve(); return firstResponse.promise; }
            const { display } = JSON.parse(String(init?.body));
            return json({ appearance: { sessionId: 's1', display, updatedAt: 101 } });
        });
        const first = setSessionAppearance({ ...context, color: { kind: 'accent', key: 'blue' } });
        const rejected = expect(first).rejects.toThrow('session-appearance-limit-exceeded');
        await firstRequest.promise;
        await setSessionAppearance({ ...context, color: { kind: 'accent', key: 'green' } });
        firstResponse.resolve(json({ error: 'session-appearance-limit-exceeded' }, 409));
        await rejected;
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display).toEqual({ t: 'plain', v: { color: { kind: 'accent', key: 'green' } } });
        expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
    });
});
