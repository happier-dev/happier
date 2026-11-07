import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import type { SessionOrganizationContentEnvelope } from '@happier-dev/protocol';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { selectEffectiveSessionAppearanceColor } from '@/sync/store/selectors/sessionAppearance';

const http = vi.hoisted(() => ({ serverFetch: vi.fn(), runtimeFetchWithServerReachability: vi.fn() }));
// HTTP is the boundary; encryption, protocol parsing, operations and the real store run unchanged.
vi.mock('@/sync/http/client', () => ({ serverFetch: http.serverFetch }));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({ runtimeFetchWithServerReachability: http.runtimeFetchWithServerReachability }));

const credentials = { token: 'appearance-test', secret: Buffer.alloc(32, 7).toString('base64url') };
const context = { credentials, serverId: 'appearance-server', sessionId: 's1' };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

describe('setSessionAppearance', () => {
    it('restores the previous folder after a rejected project move, then clears it on success', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { upsertServerProfile, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { setSessionProjectAssignmentForServer } = await import('./setSessionProjectAssignment');
        const profile = upsertServerProfile({ serverUrl: 'https://project-move.example' });
        const serverId = resolveServerProfileScopeId(profile);
        const key = `${serverId}:s1`;
        const auth = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(credentials);
        const storage = getStorage();
        storage.getState().clearSessionOrganizationForServer(serverId);
        storage.setState({ sessionOrganizationSessionAppearancesSupportedByServerId: { [serverId]: true } });
        storage.getState().applySessionFolderAssignments(serverId, [{ sessionId: 's1', folderId: 'previous-folder' }]);
        let rejectProject = true;
        const folderWrites: Array<string | null> = [];
        http.serverFetch.mockResolvedValue(json({ mode: 'plain', updatedAt: 0 }));
        http.runtimeFetchWithServerReachability.mockImplementation(async ({ init }) => {
            const body = JSON.parse(String(init.body));
            if ('folderId' in body) {
                folderWrites.push(body.folderId);
                return json({ sessionId: 's1', folderId: body.folderId });
            }
            if (rejectProject) return json({ error: 'session-appearance-limit-exceeded' }, 409);
            return json({ appearance: body.display ? { sessionId: 's1', display: body.display, updatedAt: 99 } : null });
        });
        const project = { machineId: 'machine', rootPath: '/maxicam' };
        try {
            await expect(setSessionProjectAssignmentForServer({ serverId, sessionId: 's1', project })).rejects.toThrow('session-appearance-limit-exceeded');
            expect(folderWrites).toEqual([null, 'previous-folder']);
            expect(storage.getState().sessionOrganizationFolderAssignmentsBySessionKey[key]).toBe('previous-folder');
            expect(storage.getState().sessionOrganizationAppearancesBySessionKey[key]).toBeUndefined();
            rejectProject = false;
            await setSessionProjectAssignmentForServer({ serverId, sessionId: 's1', project });
            expect(storage.getState().sessionOrganizationFolderAssignmentsBySessionKey[key]).toBeNull();
            expect(storage.getState().sessionOrganizationAppearancesBySessionKey[key]?.display).toEqual({ t: 'plain', v: { project } });
            await setSessionProjectAssignmentForServer({ serverId, sessionId: 's1', project: null });
            expect(storage.getState().sessionOrganizationAppearancesBySessionKey[key]).toBeUndefined();
        } finally {
            auth.mockRestore();
            storage.getState().clearSessionOrganizationForServer(serverId);
        }
    });
    it.each(['plain', 'e2ee'] as const)('preserves independent project, color and unknown fields across %s writes', async (mode) => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { setSessionAppearance } = await import('./setSessionAppearance');
        const { openSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const project = { machineId: 'machine', rootPath: '/maxicam' };
        const color = { kind: 'accent', key: 'blue' } as const;
        const projectColor = { kind: 'accent', key: 'green' } as const;
        const workspaceKey = resolveSessionWorkspacePresentation({ metadata: null, machines: {}, target: { machineId: project.machineId, basePath: project.rootPath } }).workspaceKey;
        const effectiveColor = () => selectEffectiveSessionAppearanceColor({
            ...getStorage().getState(),
            sessionOrganizationLabelsByLabelKey: {
                [`${context.serverId}:workspace:${workspaceKey}`]: {
                    labelKind: 'workspace', scopeKey: workspaceKey,
                    display: { t: 'plain', v: { color: projectColor } },
                    archivedAt: null, createdAt: 1, updatedAt: 1,
                },
            },
        }, { ...context, metadata: null });
        const store = getStorage().getState();
        const record = store.setSessionAppearanceOptimistic(context.serverId, 's1', { sessionId: 's1', display: { t: 'plain', v: { color, future: 'keep' } }, updatedAt: 1 });
        store.commitSessionOrganizationOptimistic(record);
        let saved: SessionOrganizationContentEnvelope | null = null;
        http.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path.endsWith('/v1/account/encryption')) return json({ mode, updatedAt: 0 });
            saved = JSON.parse(String(init?.body)).display;
            return json({ appearance: saved ? { sessionId: 's1', display: saved, updatedAt: 99 } : null });
        });
        await setSessionAppearance({ ...context, project });
        expect(await openSessionOrganizationDisplayEnvelope({ credentials, envelope: saved })).toEqual({ t: 'plain', v: { color, project, future: 'keep' } });
        expect(effectiveColor()).toEqual(color);
        await setSessionAppearance({ ...context, color: null });
        expect(await openSessionOrganizationDisplayEnvelope({ credentials, envelope: saved })).toEqual({ t: 'plain', v: { project, future: 'keep' } });
        expect(effectiveColor()).toEqual(projectColor);
        const nextColor = { kind: 'custom', hex: '#123456' } as const;
        await setSessionAppearance({ ...context, color: nextColor });
        expect(effectiveColor()).toEqual(nextColor);
        expect(await openSessionOrganizationDisplayEnvelope({ credentials, envelope: saved })).toEqual({ t: 'plain', v: { color: nextColor, project, future: 'keep' } });
        await setSessionAppearance({ ...context, color: null });
        await setSessionAppearance({ ...context, project: null });
        expect(getStorage().getState().sessionOrganizationAppearancesBySessionKey['appearance-server:s1']?.display).toEqual({ t: 'plain', v: { future: 'keep' } });
    });
    it('opens a snapshot containing only encrypted appearance displays and records server support', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        http.serverFetch.mockResolvedValueOnce(json({ mode: 'e2ee', updatedAt: 0 }));
        const color = { kind: 'custom', hex: '#123456' };
        const display = await prepareSessionOrganizationDisplayEnvelope({ credentials, value: { color } });
        http.serverFetch.mockResolvedValueOnce(json({ snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [], sessionAppearances: [{ sessionId: 's1', display, updatedAt: 9 }] } }));
        await fetchAndApplySessionOrganizationSnapshot({ credentials, serverId: context.serverId, request: { includeSessionAppearances: true }, shouldContinue: () => true });
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
