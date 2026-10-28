import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function organizationSnapshotResponse(assignments: unknown[]) {
    return {
        snapshot: {
            schemaVersion: 1,
            version: 1,
            pins: [],
            folders: [],
            folderAssignments: assignments,
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        },
    };
}

describe('fetchAndApplySessionFolderAssignments', () => {
    beforeEach(async () => {
        mocks.serverFetch.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
        getStorage().setState({ profileScope: null });
    });

    it('applies fetched assignments to the organization assignment cache', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([
            { sessionId: 's1', folderId: 'folder-a' },
        ])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
        });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-a');
        expect(getStorage().getState().sessionOrganizationLoadingByServerId['server-a']).toBe(false);
    });

    it('ignores legacy-only cached assignments when fetching missing organization assignments', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        getStorage().setState({
            sessionFolderAssignmentsBySessionKey: { 'server-a:s1': 'legacy-folder' },
            sessionOrganizationFolderAssignmentsBySessionKey: {},
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([
            { sessionId: 's1', folderId: 'folder-a' },
        ])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            fetchPolicy: 'missing',
        });

        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v2/session-organization?includeFolders=false&includeTags=false&includeLabels=false&assignmentSessionIds=s1',
            expect.anything(),
            expect.anything(),
        );
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-a');
    });

    it('marks requested sessions without returned assignments as unassigned', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([
            { sessionId: 's2', folderId: 'folder-b' },
        ])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2', 's3'],
            fetchPolicy: 'missing',
        });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': null,
            'server-a:s2': 'folder-b',
            'server-a:s3': null,
        });
    });

    it('does not overwrite organization assignments that become known while a missing-only fetch is in flight', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        let resolveResponse: ((response: Response) => void) | undefined;
        mocks.serverFetch.mockReturnValueOnce(new Promise((resolve) => {
            resolveResponse = resolve;
        }));

        const fetchPromise = fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            fetchPolicy: 'missing',
        });
        getStorage().getState().applySessionFolderAssignments('server-a', [
            { sessionId: 's1', folderId: 'folder-local' },
        ]);
        resolveResponse?.(jsonResponse(organizationSnapshotResponse([])));
        await fetchPromise;

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-local');
    });

    it('does not duplicate missing-only assignment requests already in flight', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        let releaseResponses: (() => void) | undefined;
        const responseGate = new Promise<void>((resolve) => {
            releaseResponses = resolve;
        });
        mocks.serverFetch.mockImplementation(async () => {
            await responseGate;
            return jsonResponse(organizationSnapshotResponse([{ sessionId: 's1', folderId: 'folder-a' }]));
        });

        const firstFetch = fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2'],
            fetchPolicy: 'missing',
        });
        const secondFetch = fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2'],
            fetchPolicy: 'missing',
        });

        releaseResponses?.();
        await Promise.all([firstFetch, secondFetch]);

        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': 'folder-a',
            'server-a:s2': null,
        });
    });

    it('retains successful missing-assignment learning after the visible-list effect is replaced', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const response = createDeferred<Response>();
        mocks.serverFetch.mockReturnValueOnce(response.promise);
        let cancelled = false;
        const params = {
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2'],
            fetchPolicy: 'missing' as const,
        };

        const firstFetch = fetchAndApplySessionFolderAssignments({ ...params, shouldContinue: () => !cancelled });
        // A source update cleans up the old effect and starts its replacement while
        // the same account/server request is still pending.
        cancelled = true;
        await fetchAndApplySessionFolderAssignments(params);
        response.resolve(jsonResponse(organizationSnapshotResponse([{ sessionId: 's1', folderId: 'folder-a' }])));
        await firstFetch;

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': 'folder-a',
            'server-a:s2': null,
        });
        expect(getStorage().getState().sessionOrganizationLoadingByServerId['server-a']).toBe(false);
        await fetchAndApplySessionFolderAssignments(params);
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps loading until overlapping missing-assignment batches finish', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const firstResponse = createDeferred<Response>();
        const secondResponse = createDeferred<Response>();
        mocks.serverFetch.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise);
        const params = {
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            fetchPolicy: 'missing' as const,
        };
        const first = fetchAndApplySessionFolderAssignments({ ...params, sessionIds: ['s1', 's2'] });
        const second = fetchAndApplySessionFolderAssignments({ ...params, sessionIds: ['s2', 's3'] });
        firstResponse.resolve(jsonResponse(organizationSnapshotResponse([])));
        await first;
        const loadingWhilePending = getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a'];
        secondResponse.resolve(jsonResponse(organizationSnapshotResponse([{ sessionId: 's3', folderId: 'folder-a' }])));
        await second;

        expect(loadingWhilePending).toBe(true);
        expect(getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a']).toBe(false);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': null, 'server-a:s2': null, 'server-a:s3': 'folder-a',
        });
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toContain('assignmentSessionIds=s3');
    });

    it.each([
        { accountId: 'account-current', token: 'token-current' },
        { accountId: 'account-old', token: 'token-old' },
    ])('does not share or apply an old request after activating $accountId with a cleared organization scope', async ({ accountId, token }) => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const oldResponse = createDeferred<Response>();
        const currentResponse = createDeferred<Response>();
        mocks.serverFetch.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise);
        const params = { serverId: 'server-a', sessionIds: ['s1'], fetchPolicy: 'missing' as const };
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-old' } });
        const oldFetch = fetchAndApplySessionFolderAssignments({ ...params, credentials: { token: 'token-old' } });
        getStorage().getState().clearSessionOrganizationForServer('server-a');
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId } });
        const currentFetch = fetchAndApplySessionFolderAssignments({ ...params, credentials: { token } });
        oldResponse.resolve(jsonResponse(organizationSnapshotResponse([{ sessionId: 's1', folderId: 'folder-old' }])));
        await oldFetch;
        const stateAfterOldResponse = getStorage().getState();
        currentResponse.resolve(jsonResponse(organizationSnapshotResponse([{ sessionId: 's1', folderId: 'folder-current' }])));
        await currentFetch;

        expect(stateAfterOldResponse.sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBeUndefined();
        expect(stateAfterOldResponse.sessionFolderAssignmentsLoadingByServerId['server-a']).toBe(true);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-current');
        expect(getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a']).toBe(false);
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
    });

    it('clears loading and retries unknown assignments after a cancelled effect request fails', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const response = createDeferred<Response>();
        mocks.serverFetch.mockReturnValueOnce(response.promise);
        let cancelled = false;
        const params = {
            credentials: { token: 'token-a' }, serverId: 'server-a', sessionIds: ['s1'], fetchPolicy: 'missing' as const,
        };
        const pending = fetchAndApplySessionFolderAssignments({ ...params, shouldContinue: () => !cancelled });
        cancelled = true;
        const rejection = expect(pending).rejects.toThrow('offline');
        response.reject(new Error('offline'));
        await rejection;
        expect(getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a']).toBe(false);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBeUndefined();
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([])));
        await fetchAndApplySessionFolderAssignments(params);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBeNull();
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
    });

    it('does not apply a response after the active server changes and its organization state is cleared', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const { getActiveServerSnapshot, setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const originalServer = getActiveServerSnapshot();
        const otherServer = upsertServerProfile({ serverUrl: 'https://assignment-other.example.test', name: 'Other' });
        const response = createDeferred<Response>();
        mocks.serverFetch.mockReturnValueOnce(response.promise);
        const pending = fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a' }, serverId: 'server-a', sessionIds: ['s1'], fetchPolicy: 'missing',
        });
        try {
            setActiveServer({ serverId: otherServer.id });
            getStorage().getState().clearSessionOrganizationForServer('server-a');
            response.resolve(jsonResponse(organizationSnapshotResponse([{ sessionId: 's1', folderId: 'folder-old' }])));
            await pending;

            expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBeUndefined();
            expect(getStorage().getState().sessionFolderAssignmentsLoadingByServerId['server-a']).toBeUndefined();
        } finally {
            setActiveServer({ serverId: originalServer.serverId });
        }
    });

    it('does not start an assignment request after its caller is cancelled', async () => {
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse([])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a' }, serverId: 'server-a', sessionIds: ['s1'], fetchPolicy: 'missing',
            shouldContinue: () => false,
        });

        expect(mocks.serverFetch).not.toHaveBeenCalled();
    });

    it('keeps missing-only assignment requests O(batches) across a full organization snapshot', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const credentials = { token: 'token-a', secret: 'secret-a' };
        const sessionIds = Array.from({ length: 12 }, (_, index) => `s${index + 1}`);
        mocks.serverFetch.mockImplementation(async () => jsonResponse(organizationSnapshotResponse([
            { sessionId: 's1', folderId: 'folder-a' },
        ])));

        // Arm the known set the way the visible session list does: one batched request
        // covering every visible row.
        await fetchAndApplySessionFolderAssignments({
            credentials,
            serverId: 'server-a',
            sessionIds,
            fetchPolicy: 'missing',
        });
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);

        // A session-list refresh applies the authoritative full snapshot, which lists
        // only the assigned sessions.
        getStorage().getState().applySessionOrganizationSnapshot('server-a', {
            schemaVersion: 1,
            version: 2,
            pins: [],
            folders: [],
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-a' }],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        }, {
            includeFolders: true,
            includeTags: true,
            includeLabels: true,
            includeAllFolderAssignments: true,
            includeAllTagAssignments: true,
        });

        // Rows re-entering the visible source one at a time (per-session shell hydration)
        // must not each cost a request.
        for (const sessionId of sessionIds) {
            await fetchAndApplySessionFolderAssignments({
                credentials,
                serverId: 'server-a',
                sessionIds: [sessionId],
                fetchPolicy: 'missing',
            });
        }

        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            'server-a:s1': 'folder-a',
            'server-a:s7': null,
            'server-a:s12': null,
        });
    });

    it('still fetches sessions a full organization snapshot never covered', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const credentials = { token: 'token-a', secret: 'secret-a' };
        mocks.serverFetch.mockImplementation(async () => jsonResponse(organizationSnapshotResponse([])));

        await fetchAndApplySessionFolderAssignments({
            credentials,
            serverId: 'server-a',
            sessionIds: ['s1'],
            fetchPolicy: 'missing',
        });
        getStorage().getState().applySessionOrganizationSnapshot('server-a', {
            schemaVersion: 1,
            version: 2,
            pins: [],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        }, { includeAllFolderAssignments: true, includeAllTagAssignments: true });
        mocks.serverFetch.mockClear();

        await fetchAndApplySessionFolderAssignments({
            credentials,
            serverId: 'server-a',
            sessionIds: ['s1', 's-new'],
            fetchPolicy: 'missing',
        });

        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch).toHaveBeenCalledWith(
            '/v2/session-organization?includeFolders=false&includeTags=false&includeLabels=false&assignmentSessionIds=s-new',
            expect.anything(),
            expect.anything(),
        );
    });

    it('adopts an assignment a later full organization snapshot reports for a known-unassigned session', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockImplementation(async () => jsonResponse(organizationSnapshotResponse([])));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            fetchPolicy: 'missing',
        });
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBeNull();

        getStorage().getState().applySessionOrganizationSnapshot('server-a', {
            schemaVersion: 1,
            version: 2,
            pins: [],
            folders: [],
            folderAssignments: [{ sessionId: 's1', folderId: 'folder-later' }],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        }, { includeAllFolderAssignments: true, includeAllTagAssignments: true });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey['server-a:s1']).toBe('folder-later');
    });
});
