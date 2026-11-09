import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountEncryptionModeModuleMock } from '@/dev/testkit';

const mocks = vi.hoisted(() => ({
    createEncryptionFromAuthCredentials: vi.fn(),
    fetchAccountEncryptionMode: vi.fn(),
    serverFetch: vi.fn(),
}));

vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: mocks.createEncryptionFromAuthCredentials,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) =>
    await createAccountEncryptionModeModuleMock({
        importOriginal,
        overrides: { fetchAccountEncryptionMode: mocks.fetchAccountEncryptionMode },
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

describe('fetchAndApplySessionOrganizationSnapshot', () => {
    beforeEach(async () => {
        mocks.createEncryptionFromAuthCredentials.mockReset();
        mocks.createEncryptionFromAuthCredentials.mockResolvedValue({
            getContentPrivateKey: () => new Uint8Array(32).fill(9),
        });
        mocks.fetchAccountEncryptionMode.mockReset();
        mocks.fetchAccountEncryptionMode.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
        mocks.serverFetch.mockReset();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        getStorage().getState().clearSessionOrganizationForServer('server-a');
    });

    it('does not treat a missing-route compatibility snapshot as complete assignment evidence', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        getStorage().getState().applySessionFolderAssignments('server-a', [{ sessionId: 'retained', folderId: 'prior' }]);
        mocks.serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404, headers: { 'Content-Type': 'application/json' },
        }));
        await fetchAndApplySessionOrganizationSnapshot({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', request: { includeAllFolderAssignments: true, assignmentSessionIds: ['retained', 'unknown'] } });
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsCompleteByServerId['server-a']).not.toBe(true);
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[
            buildSessionOrganizationSessionKey('server-a', 'retained')]).toEqual({ sessionId: 'retained', folderId: 'prior' });
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[
            buildSessionOrganizationSessionKey('server-a', 'unknown')]).toBeUndefined();
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ snapshot: {
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        } }));
        await fetchAndApplySessionOrganizationSnapshot({ credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a', request: { includeAllFolderAssignments: true } });
        expect(getStorage().getState().sessionOrganizationFolderAssignmentsCompleteByServerId['server-a']).toBe(true);
    });

    it('publishes the store only for snapshot content, not around each fetch', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { countStoreNotifications } = await import('@/dev/testkit/performance/counts');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const snapshot = { schemaVersion: 1, version: 7, pins: [], folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [] };
        const credentials = { token: 'token-a', secret: 'secret-a' };
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ snapshot }));
        await fetchAndApplySessionOrganizationSnapshot({ credentials, serverId: 'server-a' });
        const notifications = countStoreNotifications(getStorage());
        try {
            mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ snapshot }));
            await fetchAndApplySessionOrganizationSnapshot({ credentials, serverId: 'server-a' });
            mocks.serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), {
                status: 500, headers: { 'Content-Type': 'application/json' },
            }));
            await expect(fetchAndApplySessionOrganizationSnapshot({ credentials, serverId: 'server-a' })).rejects.toThrow();
            expect(notifications.read()).toEqual([]);
        } finally {
            notifications.stop();
        }
    });

    it('opens encrypted display envelopes before applying snapshots', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const display = await prepareSessionOrganizationDisplayEnvelope({
            credentials: { token: 'token-a', secret: 'secret-a' },
            value: { name: 'Encrypted folder' },
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            snapshot: {
                schemaVersion: 1,
                version: 43,
                pins: [],
                folders: [{
                    folderId: 'folder-a',
                    folderKey: 'folder-a',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: null,
                    display,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        }));

        await fetchAndApplySessionOrganizationSnapshot({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            request: { includeFolders: true },
        });

        const { buildSessionOrganizationServerKey } = await import('@/sync/domains/session/organization');
        const folderKey = buildSessionOrganizationServerKey('server-a', 'folder-a');
        const folder = getStorage().getState().sessionOrganizationFoldersByFolderKey[folderKey];
        expect(folder?.display).toEqual(display);
        expect(folder?.displayState).toEqual({
            status: 'available',
            value: { name: 'Encrypted folder' },
        });
    });

    it('does not apply a snapshot if the scope is cancelled after display envelopes are opened', async () => {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { prepareSessionOrganizationDisplayEnvelope } = await import('./sessionOrganizationDisplayEnvelope');
        const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
        const display = await prepareSessionOrganizationDisplayEnvelope({
            credentials: { token: 'token-a', secret: 'secret-a' },
            value: { name: 'Stale folder' },
        });
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            snapshot: {
                schemaVersion: 1,
                version: 44,
                pins: [],
                folders: [{
                    folderId: 'folder-stale',
                    folderKey: 'folder-stale',
                    parentFolderId: null,
                    parentFolderKey: null,
                    sortKey: null,
                    display,
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                }],
                folderAssignments: [],
                tags: [],
                tagAssignments: [],
                orderEntries: [],
                labels: [],
            },
        }));
        let checks = 0;

        await fetchAndApplySessionOrganizationSnapshot({
            credentials: { token: 'token-a', secret: 'secret-a' },
            serverId: 'server-a',
            request: { includeFolders: true },
            shouldContinue: () => {
                checks += 1;
                return checks === 1;
            },
        });

        expect(checks).toBeGreaterThanOrEqual(2);
        const { buildSessionOrganizationServerKey } = await import('@/sync/domains/session/organization');
        const folderKey = buildSessionOrganizationServerKey('server-a', 'folder-stale');
        expect(getStorage().getState().sessionOrganizationFoldersByFolderKey[folderKey]).toBeUndefined();
    });

    it.each([
        { blockedKind: 'session', tail: 'short' },
        { blockedKind: 'future-kind', tail: 'short' },
        { blockedKind: 'future-kind', tail: 'budget' },
        { blockedKind: 'future-kind', tail: 'cursor-gone' },
    ] as const)(
        'refreshes later pin changes past a blocked $blockedKind page with a $tail tail without checkpointing over the gap',
        async ({ blockedKind, tail }) => {
            const { SessionOrganizationSnapshotResponseSchema } = await import('@happier-dev/protocol/sessions/organization/snapshot');
            const { createEmbedEncryption } = await import('@/embed/encryption/createEmbedEncryption');
            const { fetchChanges, fetchCurrentChangesCursor } = await import('@/sync/api/session/apiChanges');
            const { fetchAndApplySessionById } = await import('@/sync/engine/sessions/sessionById');
            const { applyPlannedChangeActions } = await import('@/sync/runtime/orchestration/changesApplier');
            const { runSocketReconnectCatchUpViaChanges } = await import('@/sync/runtime/orchestration/socketReconnectViaChanges');
            const { getStorage } = await import('@/sync/domains/state/storageStore');
            const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization');
            const { fetchAndApplySessionOrganizationSnapshot } = await import('./fetchSessionOrganizationSnapshot');
            const credentials = { token: 'token-a', secret: 'secret-a' };
            const frame = await createEmbedEncryption();
            const baseline = SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
                schemaVersion: 1, version: 1,
                pins: [
                    { sessionId: 'garden', sortKey: 'a', pinnedAt: 1, listPinned: false, railPinned: true },
                    { sessionId: 'reading', sortKey: 'b', pinnedAt: 2, listPinned: true, railPinned: true },
                ],
                folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
            } });
            getStorage().getState().applySessionOrganizationSnapshot('server-a', baseline.snapshot);
            const pageCursors: string[] = [];
            const checkpoints: string[] = [];
            const request = async (path: string): Promise<Response> => {
                const url = new URL(path, 'http://server-a.test');
                if (url.pathname === '/v2/changes') {
                    const after = url.searchParams.get('after') ?? '';
                    pageCursors.push(after);
                    if (after === '0') return jsonResponse({ nextCursor: 2, changes: [
                        { cursor: 1, kind: 'account', entityId: 'self', changedAt: 1, hint: { settingsVersion: 1 } },
                        { cursor: 2, kind: blockedKind, entityId: 'unavailable-session', changedAt: 2 },
                    ] });
                    if (after === '2' && tail === 'cursor-gone') return new Response(JSON.stringify({
                        error: 'cursor-gone', currentCursor: 4,
                    }), { status: 410 });
                    if (after === '2') return jsonResponse({ nextCursor: 3, changes: [{
                        cursor: 3, kind: 'account', entityId: 'session-organization', changedAt: 3,
                        hint: { sessionOrganization: true, scope: 'pins', sessionIds: ['garden', 'reading'] },
                    }] });
                    if (after === '4') return jsonResponse({ nextCursor: 4, changes: [] });
                }
                if (url.pathname === '/v2/cursor') return jsonResponse({ cursor: 4, changesFloor: 0 });
                if (url.pathname === '/v2/sessions/unavailable-session') {
                    // The real by-ID reader and change applier interpret this retryable HTTP failure.
                    return new Response('Unavailable', { status: 503 });
                }
                if (url.pathname === '/v2/session-organization') return jsonResponse({ snapshot: {
                    ...baseline.snapshot, version: 2,
                    pins: baseline.snapshot.pins.map(pin => ({ ...pin, sortKey: pin.sessionId === 'reading' ? 'a' : 'b' })),
                } });
                throw new Error(`Unexpected HTTP request: ${path}`);
            };
            try {
                const result = await runSocketReconnectCatchUpViaChanges({
                    credentials, accountId: 'account-a', afterCursor: '0', changesPageLimit: 2,
                    maxChangesPagesPerResume: tail === 'budget' ? 1 : undefined,
                    forceSnapshotRefresh: false,
                    planContext: { isSessionListMember: () => true },
                    fetchChanges: params => fetchChanges({ ...params, request }),
                    fetchCurrentCursor: params => fetchCurrentChangesCursor({ ...params, request }),
                    checkpointCursor: cursor => { checkpoints.push(cursor); return true; },
                    applyPlanned: planned => applyPlannedChangeActions({
                        planned, credentials, isSessionMessagesLoaded: () => false,
                        invalidate: { sessionRows: async sessionIds => {
                            for (const sessionId of sessionIds) {
                                const refreshed = await fetchAndApplySessionById({
                                    sessionId, credentials, request, encryption: frame.encryption,
                                    sessionDataKeys: new Map(), applySessions: () => {}, log: { log: () => {} },
                                });
                                if (!refreshed.ok) throw new Error(refreshed.errorCode);
                            }
                        } },
                        refreshSessionOrganization: async plan => {
                            await fetchAndApplySessionOrganizationSnapshot({
                                credentials, serverId: 'server-a', requestAtEndpoint: request,
                                request: {
                                    includeFolders: plan.includeFolders, includeTags: plan.includeTags,
                                    includeLabels: plan.includeLabels, assignmentSessionIds: plan.assignmentSessionIds,
                                    folderIds: plan.folderIds, tagIds: plan.tagIds, orderScopes: plan.orderScopes,
                                },
                            });
                        },
                        invalidateMessagesForSession: async () => {}, invalidateScmStatusForSession: () => {},
                        applyTodoSocketUpdates: async () => {}, kvBulkGet: async () => ({ values: [] }),
                    }),
                    snapshotRefresh: async () => {
                        if (tail === 'short') throw new Error('A short tail needs no snapshot repair');
                        // Even a completed known-domain read cannot acknowledge the unknown change.
                        await fetchAndApplySessionOrganizationSnapshot({
                            credentials, serverId: 'server-a', requestAtEndpoint: request,
                        });
                        return { status: 'complete' };
                    },
                });

                const pins = getStorage().getState().sessionOrganizationPinsBySessionKey;
                expect(pins[buildSessionOrganizationSessionKey('server-a', 'reading')]).toMatchObject({
                    sortKey: 'a', listPinned: true, railPinned: true,
                });
                expect(pins[buildSessionOrganizationSessionKey('server-a', 'garden')]).toMatchObject({
                    sortKey: 'b', listPinned: false, railPinned: true,
                });
                expect(pageCursors).toEqual(tail === 'budget' ? ['0'] : ['0', '2']);
                expect(checkpoints).toEqual(['1']);
                expect(result).toEqual({ status: 'ok', nextCursor: '1', shouldPersistCursor: false });
            } finally {
                frame.dispose();
            }
        },
    );
});
