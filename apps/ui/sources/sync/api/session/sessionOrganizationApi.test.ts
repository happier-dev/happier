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

function organizationSnapshotResponse() {
    return {
        snapshot: {
            schemaVersion: 1,
            version: 9,
            pins: [],
            folders: [],
            folderAssignments: [],
            tags: [],
            tagAssignments: [],
            orderEntries: [],
            labels: [],
        },
    };
}

describe('sessionOrganizationApi', () => {
    it('deletes a label through its captured Account endpoint', async () => {
        const { deleteSessionOrganizationLabel } = await import('./sessionOrganizationApi');
        mocks.runtimeFetchWithServerReachability.mockResolvedValue(jsonResponse({ error: 'wrong-account-endpoint' }, 409));
        const request = { labelKind: 'workspace' as const, scopeKey: 'workspace' };
        await expect(deleteSessionOrganizationLabel({ credentials, serverUrl: 'https://other.example', request,
            requestAtEndpoint: async (path, init) => {
                expect(path).toBe('/v2/session-organization/labels');
                expect(init?.method).toBe('DELETE');
                return jsonResponse({ ...request, archived: true });
            },
        })).resolves.toEqual({ ...request, archived: true });
    });
    it('writes and clears session appearances at the captured Account endpoint and requests them explicitly', async () => {
        const { setSessionAppearance, fetchSessionOrganizationSnapshot } = await import('./sessionOrganizationApi');
        const display = { t: 'plain' as const, v: { color: { kind: 'accent', key: 'green' } } };
        const requestAtEndpoint = vi.fn(async (path: string, init?: RequestInit) => {
            if (init?.method === 'PUT') {
                expect(path).toBe('/v2/session-organization/appearances/session%2Fone');
                const body = JSON.parse(String(init.body));
                return jsonResponse({ appearance: body.display ? { sessionId: 'session/one', display: body.display, updatedAt: 8 } : null });
            }
            expect(new URL(path, 'https://home.example').searchParams.get('includeSessionAppearances')).toBe('true');
            return jsonResponse({ snapshot: { ...organizationSnapshotResponse().snapshot, sessionAppearances: [] } });
        });
        await expect(setSessionAppearance({ credentials, requestAtEndpoint, sessionId: 'session/one', request: { display } }))
            .resolves.toEqual({ appearance: { sessionId: 'session/one', display, updatedAt: 8 } });
        await expect(setSessionAppearance({ credentials, requestAtEndpoint, sessionId: 'session/one', request: { display: null } }))
            .resolves.toEqual({ appearance: null });
        await fetchSessionOrganizationSnapshot({ credentials, requestAtEndpoint, request: { includeSessionAppearances: true } });
        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.runtimeFetchWithServerReachability.mockReset();
    });

    it('preserves only strict scope refusals before decoding organization mutation results', async () => {
        const { setSessionPin, setSessionAppearance, setSessionAttentionStanding, setSessionFolderAssignment, setSessionTagAssignments } = await import('./sessionOrganizationApi');
        const requestAtEndpoint = async () => jsonResponse({ error: 'credential_scope_denied' }, 403);
        for (const operation of [
            () => setSessionPin({ credentials, sessionId: 'same', request: { pinned: false }, requestAtEndpoint }),
            () => setSessionAppearance({ credentials, sessionId: 'same', request: { display: null }, requestAtEndpoint }),
            () => setSessionFolderAssignment({ credentials, sessionId: 'same', request: { folderId: null }, requestAtEndpoint }),
        ]) {
            await expect(operation()).rejects.toMatchObject({ code: 'credential_scope_denied', status: 403 });
        }
        mocks.serverFetch.mockImplementation(async () => jsonResponse({ error: 'credential_scope_denied' }, 403));
        await expect(setSessionTagAssignments({ credentials, sessionId: 'same', request: { tagIds: [] } }))
            .rejects.toMatchObject({ code: 'credential_scope_denied', status: 403 });
        await expect(setSessionAttentionStanding({ credentials, sessionId: 'same', request: { standing: null } }))
            .rejects.toMatchObject({ code: 'credential_scope_denied', status: 403 });
        mocks.serverFetch.mockResolvedValue(jsonResponse({ error: 'credential_scope_denied', details: {} }, 403));
        await expect(setSessionPin({ credentials, sessionId: 'same', request: { pinned: false } }))
            .rejects.not.toMatchObject({ code: 'credential_scope_denied' });
    });

    it('requires current pin memberships in an HTTP snapshot rather than adapting a predecessor server response', async () => {
        const { fetchSessionOrganizationSnapshot } = await import('./sessionOrganizationApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ snapshot: {
            ...organizationSnapshotResponse().snapshot,
            pins: [{ sessionId: 'retained', sortKey: 'a', pinnedAt: 1 }],
        } }));
        await expect(fetchSessionOrganizationSnapshot({ credentials })).rejects.toBeInstanceOf(
            (await import('@/utils/errors/errors')).HappyError,
        );
    });

    it('writes pin membership through the captured Account endpoint rather than the active Home transport', async () => {
        const { setSessionPin } = await import('./sessionOrganizationApi');
        const pin = { sessionId: 'pinned', sortKey: null, pinnedAt: 1, listPinned: false, railPinned: true };
        const dispatched: unknown[] = [];
        const requestAtEndpoint = async (path: string, init?: RequestInit) => {
            expect(path).toBe('/v2/session-organization/pins/pinned');
            dispatched.push(JSON.parse(String(init?.body)));
            return jsonResponse({ pin });
        };
        await expect(setSessionPin({ credentials, sessionId: 'pinned', requestAtEndpoint,
            request: { pinned: true, surface: 'rail' } })).resolves.toEqual({ pin });
        expect(dispatched).toEqual([{ pinned: true, surface: 'rail' }]);
        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });

    it('refuses unknown pin mutation fields before dispatching any write', async () => {
        const { setSessionPin } = await import('./sessionOrganizationApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ pin: null }));
        const request = { pinned: true, surface: 'rail' as const, wholeMetadata: { bot: { kind: 'bot' } } };
        await expect(setSessionPin({ credentials, sessionId: 'pinned', request })).rejects.toMatchObject({
            issues: [expect.objectContaining({ code: 'unrecognized_keys', keys: ['wholeMetadata'] })],
        });
        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).not.toHaveBeenCalled();
    });

    it('fetches a scoped organization snapshot through the canonical route', async () => {
        const { fetchSessionOrganizationSnapshot } = await import('./sessionOrganizationApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse()));

        const response = await fetchSessionOrganizationSnapshot({
            credentials,
            request: {
                includeFolders: true,
                includeTags: true,
                includeLabels: true,
                includeAllFolderAssignments: true,
                includeAllTagAssignments: true,
                assignmentSessionIds: ['s1', 's2'],
                folderIds: ['folder-a'],
                tagIds: ['tag-a'],
                orderScopes: [{ scopeKind: 'folder', scopeKey: 'folder-a' }],
            },
        });

        expect(response.snapshot.version).toBe(9);
        expect(mocks.serverFetch).toHaveBeenCalledWith(
            expect.stringContaining('/v2/session-organization?'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-a',
                    'Content-Type': 'application/json',
                }),
            }),
            { includeAuth: false },
        );
        const requestUrl = new URL(String(mocks.serverFetch.mock.calls[0]?.[0]), 'http://localhost');
        expect(requestUrl.searchParams.get('projectionVersion')).toBe('2');
        expect(requestUrl.searchParams.get('includeFolders')).toBe('true');
        expect(requestUrl.searchParams.get('includeTags')).toBe('true');
        expect(requestUrl.searchParams.get('includeLabels')).toBe('true');
        expect(requestUrl.searchParams.get('includeAllFolderAssignments')).toBe('true');
        expect(requestUrl.searchParams.get('includeAllTagAssignments')).toBe('true');
        expect(requestUrl.searchParams.get('assignmentSessionIds')).toBe('s1,s2');
        expect(requestUrl.searchParams.get('folderIds')).toBe('folder-a');
        expect(requestUrl.searchParams.get('tagIds')).toBe('tag-a');
        expect(JSON.parse(String(requestUrl.searchParams.get('orderScopes')))).toEqual([
            { scopeKind: 'folder', scopeKey: 'folder-a' },
        ]);
    });

    it('consumes every standing in a current snapshot without truncating the released-reader boundary', async () => {
        const { fetchSessionOrganizationSnapshot } = await import('./sessionOrganizationApi');
        const attentionStandings = Array.from({ length: 501 }, (_, index) => ({
            sessionId: `session-${index}`, standing: true, updatedAt: 1,
        }));
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ snapshot: {
            ...organizationSnapshotResponse().snapshot, attentionStandings,
        } }));
        const response = await fetchSessionOrganizationSnapshot({ credentials });
        expect(response.snapshot.attentionStandings).toEqual(attentionStandings);
        const requestUrl = new URL(String(mocks.serverFetch.mock.calls[0]?.[0]), 'http://localhost');
        expect(requestUrl.searchParams.get('projectionVersion')).toBe('2');
    });

    it('uses the row server URL when mutating tag assignments outside the active server', async () => {
        const { setSessionTagAssignments } = await import('./sessionOrganizationApi');
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(jsonResponse({
            sessionId: 's1',
            tagIds: ['tag-a', 'tag-b'],
        }));

        const response = await setSessionTagAssignments({
            credentials,
            serverUrl: 'https://row-server.example.test/api/',
            sessionId: 's1',
            request: { tagIds: ['tag-a', 'tag-b'] },
        });

        expect(response).toEqual({ sessionId: 's1', tagIds: ['tag-a', 'tag-b'] });
        expect(mocks.serverFetch).not.toHaveBeenCalled();
        expect(mocks.runtimeFetchWithServerReachability).toHaveBeenCalledWith({
            serverUrl: 'https://row-server.example.test/api',
            token: 'token-a',
            url: 'https://row-server.example.test/api/v2/session-organization/tag-assignments/s1',
            init: expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({ tagIds: ['tag-a', 'tag-b'] }),
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-a',
                    'Content-Type': 'application/json',
                }),
            }),
        });
    });

    it('writes the attention standing tri-state through the shared organization route', async () => {
        const { setSessionAttentionStanding } = await import('./sessionOrganizationApi');
        mocks.runtimeFetchWithServerReachability.mockResolvedValueOnce(jsonResponse({
            standing: { sessionId: 's1', standing: false, updatedAt: 12 },
        }));

        const response = await setSessionAttentionStanding({
            credentials,
            serverUrl: 'https://row-server.example.test/api/',
            sessionId: 's1',
            request: { standing: false },
        });

        expect(response).toEqual({ standing: { sessionId: 's1', standing: false, updatedAt: 12 } });
        expect(mocks.runtimeFetchWithServerReachability).toHaveBeenCalledWith({
            serverUrl: 'https://row-server.example.test/api',
            token: 'token-a',
            url: 'https://row-server.example.test/api/v2/session-organization/attention-standings/s1',
            init: expect.objectContaining({
                method: 'PUT',
                // `false` is a real value here, not an omission: the body must carry it verbatim so
                // the server can tell "removed from Needs attention" from "cleared the override".
                body: JSON.stringify({ standing: false }),
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-a',
                    'Content-Type': 'application/json',
                }),
            }),
        });
    });

    it('asks for attention standings in the session list snapshot query', async () => {
        const { fetchSessionOrganizationSnapshot } = await import('./sessionOrganizationApi');
        const { createSessionListOrganizationSnapshotRequest } = await import(
            '@/sync/engine/sessions/sessionListOrganizationSnapshotRequest'
        );
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse(organizationSnapshotResponse()));

        await fetchSessionOrganizationSnapshot({
            credentials,
            request: createSessionListOrganizationSnapshotRequest(),
        });

        const requestUrl = new URL(String(mocks.serverFetch.mock.calls[0]?.[0]), 'http://localhost');
        expect(requestUrl.searchParams.get('includeAttentionStandings')).toBe('true');
    });

    it('returns an empty compatibility snapshot when the organization route is missing', async () => {
        const { fetchSessionOrganizationSnapshot } = await import('./sessionOrganizationApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            error: 'Not found',
            path: '/v2/session-organization',
        }, 404));

        const response = await fetchSessionOrganizationSnapshot({ credentials });

        expect(response.snapshot.version).toBe(0);
        expect(response.snapshot.pins).toEqual([]);
        expect(response.snapshot.folderAssignments).toEqual([]);
        expect(response.snapshot.tagAssignments).toEqual([]);
    });

    it('rejects malformed snapshot responses at the API boundary', async () => {
        const { fetchSessionOrganizationSnapshot } = await import('./sessionOrganizationApi');
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({ snapshot: { version: 'not-a-number' } }));

        await expect(fetchSessionOrganizationSnapshot({ credentials }))
            .rejects.toThrow('Failed to fetch session organization snapshot');
    });
});
