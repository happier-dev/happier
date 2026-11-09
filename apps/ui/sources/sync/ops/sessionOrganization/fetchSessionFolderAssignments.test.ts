import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization';

const assignmentKey = (sessionId: string) => buildSessionOrganizationSessionKey('server-a', sessionId);

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

function jsonErrorResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function snapshotResponse(assignments: readonly { sessionId: string; folderId: string }[]): Response {
    return jsonResponse({
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
    });
}

describe('fetchAndApplySessionFolderAssignments', () => {
    beforeEach(async () => {
        mocks.serverFetch.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionFolderAssignmentsForServer('server-a');
    });

    it('applies fetched assignments to the canonical session organization assignment store', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(snapshotResponse([{ sessionId: 's1', folderId: 'folder-a' }]));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
        });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[assignmentKey('s1')]?.folderId).toBe('folder-a');
    });

    it('marks requested sessions without returned assignments as unassigned', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(snapshotResponse([{ sessionId: 's2', folderId: 'folder-b' }]));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1', 's2', 's3'],
        });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey).toMatchObject({
            [assignmentKey('s1')]: { sessionId: 's1', folderId: null },
            [assignmentKey('s2')]: { sessionId: 's2', folderId: 'folder-b' },
            [assignmentKey('s3')]: { sessionId: 's3', folderId: null },
        });
    });

    it.each([
        { change: 'Account', serverId: 'server-a', accountId: 'account-current', currentFirst: false },
        { change: 'same Account reactivation', serverId: 'server-a', accountId: 'account-old', currentFirst: true },
        { change: 'Home', serverId: 'server-b', accountId: 'account-old', currentFirst: false },
    ])('keeps assignment reads inside their activation after $change changes', async ({ serverId, accountId, currentFirst }) => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        const {
            getAppliedActiveServerSnapshot,
            isAppliedActiveServerRuntimeAvailable,
            publishApplyingActiveServerId,
            publishAppliedActiveServerSnapshot,
        } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousSnapshot = getAppliedActiveServerSnapshot();
        const previousAvailability = isAppliedActiveServerRuntimeAvailable();
        const { profile, profileScope } = getStorage().getState();
        const oldResponse = createDeferred<Response>();
        const currentResponse = createDeferred<Response>();
        mocks.serverFetch.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise);
        const currentKey = buildSessionOrganizationSessionKey(serverId, 's1');

        try {
            publishApplyingActiveServerId('server-a', 1);
            publishAppliedActiveServerSnapshot({ serverId: 'server-a', serverUrl: 'https://old.example.test', generation: 1 });
            getStorage().getState().activateProfileScope({ serverId: 'server-a', accountId: 'account-old' });
            const oldFetch = fetchAndApplySessionFolderAssignments({
                credentials: { token: 'token-old' }, serverId: 'server-a', sessionIds: ['s1'],
            });

            // Exercise the real runtime/profile lifecycle, including leaving and
            // returning to the same Account rather than comparing only its ids.
            publishApplyingActiveServerId(serverId, 2);
            getStorage().getState().clearProfileScope();
            getStorage().getState().clearSessionFolderAssignmentsForServer('server-a');
            publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://current.example.test', generation: 2 });
            getStorage().getState().activateProfileScope({ serverId, accountId });
            const currentFetch = fetchAndApplySessionFolderAssignments({
                credentials: { token: 'token-current' }, serverId, sessionIds: ['s1'],
            });

            if (currentFirst) {
                currentResponse.resolve(snapshotResponse([{ sessionId: 's1', folderId: 'folder-current' }]));
                await currentFetch;
            }
            oldResponse.resolve(snapshotResponse([{ sessionId: 's1', folderId: 'folder-old' }]));
            await oldFetch;
            const stateAfterOldResponse = getStorage().getState();
            if (!currentFirst) {
                currentResponse.resolve(snapshotResponse([{ sessionId: 's1', folderId: 'folder-current' }]));
                await currentFetch;
                expect(stateAfterOldResponse.sessionOrganizationFolderAssignmentsBySessionKey[assignmentKey('s1')]).toBeUndefined();
            }
            expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[currentKey]?.folderId).toBe('folder-current');
        } finally {
            getStorage().getState().clearSessionFolderAssignmentsForServer(serverId);
            getStorage().getState().clearProfileScope();
            getStorage().setState({ profile, profileScope });
            publishApplyingActiveServerId(previousSnapshot.serverId, previousSnapshot.generation);
            publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailability);
        }
    });

    it('does not apply stale assignments after scope changes', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(snapshotResponse([{ sessionId: 's1', folderId: 'folder-a' }]));

        await fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
            shouldContinue: () => false,
        });

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[assignmentKey('s1')]).toBeUndefined();
    });

    it('treats a missing folder assignment route as requested sessions being unassigned', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionFolderAssignments } = await import('./fetchSessionFolderAssignments');
        mocks.serverFetch.mockResolvedValueOnce(jsonErrorResponse({
            error: 'Not found',
        }, 404));

        await expect(fetchAndApplySessionFolderAssignments({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            sessionIds: ['s1'],
        })).resolves.toBeUndefined();

        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[assignmentKey('s1')]?.folderId).toBeNull();
    });
});
