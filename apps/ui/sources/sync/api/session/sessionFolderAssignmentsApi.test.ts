import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    runtimeFetchWithServerReachability: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: mocks.runtimeFetchWithServerReachability,
}));

const credentials = { token: 'token-a', secret: 'secret-a' };

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('sessionFolderAssignmentsApi', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.runtimeFetchWithServerReachability.mockReset();
    });

    it('fetches and mutates assignments through canonical routes', async () => {
        const { fetchSessionFolderAssignmentsForSessions, setSessionFolderAssignment } = await import('./sessionFolderAssignmentsApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            assignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ sessionId: 's1', folderId: null }));

        await expect(fetchSessionFolderAssignmentsForSessions({
            credentials,
            sessionIds: ['s1', 's2'],
        })).resolves.toEqual({
            assignments: [{ sessionId: 's1', folderId: 'folder-a' }],
        });
        await expect(setSessionFolderAssignment({ credentials, sessionId: 's1', folderId: null }))
            .resolves.toEqual({ sessionId: 's1', folderId: null });

        expect(mocks.serverFetch).toHaveBeenNthCalledWith(
            1,
            '/v2/session-folder-assignments?sessionIds=s1%2Cs2',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer token-a' }),
            }),
            { includeAuth: false },
        );
        expect(mocks.serverFetch).toHaveBeenNthCalledWith(
            2,
            '/v2/session-folder-assignments/s1',
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ folderId: null }),
            }),
            { includeAuth: false },
        );
    });

    it('targets the row server URL when setting assignments outside the active server', async () => {
        const { setSessionFolderAssignment } = await import('./sessionFolderAssignmentsApi');
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(jsonResponse({ sessionId: 's1', folderId: 'folder-a' }));

        await setSessionFolderAssignment({
            credentials,
            serverUrl: 'https://row-server.example.test/api',
            sessionId: 's1',
            folderId: 'folder-a',
        });

        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).toHaveBeenCalledWith({
            serverUrl: 'https://row-server.example.test/api',
            token: 'token-a',
            url: 'https://row-server.example.test/api/v2/session-folder-assignments/s1',
            init: expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ folderId: 'folder-a' }),
            }),
        });
    });
});
