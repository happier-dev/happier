import { afterEach, describe, expect, it } from 'vitest';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

describe('session organization display scope', () => {
    afterEach(resetRuntimeFetch);
    it('uses the destination Home mode with token-only credentials instead of the active Home', async () => {
        setRuntimeFetch(async url => new Response(JSON.stringify({ mode: String(url).startsWith('https://plain.example') ? 'plain' : 'e2ee', updatedAt: 0 }), { status: 200 }));
        const { prepareSessionOrganizationDisplayEnvelopeForWrite } = await import('./sessionOrganizationDisplayEnvelope');
        await expect(prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: { token: 'plain-token' }, serverUrl: 'https://plain.example',
            envelope: { t: 'plain', v: { color: { kind: 'accent', key: 'green' } } },
        })).resolves.toEqual({ t: 'plain', v: { color: { kind: 'accent', key: 'green' } } });
    });

    it('keeps a captured Account request authoritative when a server URL is also supplied', async () => {
        setRuntimeFetch(async () => { throw new Error('ambient request must not run'); });
        const { prepareSessionOrganizationDisplayEnvelopeForWrite } = await import('./sessionOrganizationDisplayEnvelope');
        await expect(prepareSessionOrganizationDisplayEnvelopeForWrite({
            credentials: { token: 'plain-token' }, serverUrl: 'https://other.example',
            request: async () => Response.json({ mode: 'plain', updatedAt: 0 }),
            envelope: { t: 'plain', v: { label: 'Project' } },
        })).resolves.toEqual({ t: 'plain', v: { label: 'Project' } });
    });

    it('opens a snapshot containing only encrypted appearances and preserves retained ciphertext and unavailable state', async () => {
        const { prepareSessionOrganizationDisplayEnvelope, openSessionOrganizationSnapshotDisplayEnvelopes } = await import('./sessionOrganizationDisplayEnvelope');
        const credentials = { token: 'e2ee-token', secret: Buffer.alloc(32, 7).toString('base64url') };
        const value = { color: { kind: 'custom', hex: '#123456' } };
        const display = await prepareSessionOrganizationDisplayEnvelope({ credentials, accountMode: 'e2ee', value });
        const snapshot = { schemaVersion: 1 as const, version: 1, pins: [], folders: [], tags: [], labels: [],
            folderAssignments: [], tagAssignments: [], orderEntries: [], sessionAppearances: [
                { sessionId: 'encrypted', display, updatedAt: 1 },
                { sessionId: 'unavailable', display: null, displayState: { status: 'unavailable' as const, reason: 'storage_mode_mismatch' as const }, updatedAt: 2 },
            ] };
        const opened = await openSessionOrganizationSnapshotDisplayEnvelopes({ credentials, snapshot });
        expect(opened.sessionAppearances).toEqual([
            { ...snapshot.sessionAppearances[0], displayState: { status: 'available', value } },
            { ...snapshot.sessionAppearances[1], displayState: { status: 'locked', reason: 'storage_mode_mismatch' } },
        ]);
        const locked = await openSessionOrganizationSnapshotDisplayEnvelopes({ credentials: { token: 'only-token' }, snapshot });
        expect(locked.sessionAppearances?.[0]).toMatchObject({ display, displayState: { status: 'locked', reason: 'account_key_unavailable' } });
    });

    it('seals every folder, tag, label and legacy-import writer for the URL-selected keyless plain Account', async () => {
        const { upsertSessionFolder } = await import('./upsertSessionFolder');
        const { upsertSessionTag } = await import('./upsertSessionTag');
        const { upsertSessionLabel } = await import('./upsertSessionLabel');
        const { importLegacySessionOrganization } = await import('./importLegacySessionOrganization');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const serverId = 'display-write-scope';
        const params = { credentials: { token: 'plain-token' }, serverId, serverUrl: 'https://plain.example' };
        const display = { t: 'plain' as const, v: { label: 'Project' } };
        const folder = { folderId: 'folder', folderKey: 'folder', parentFolderId: null, parentFolderKey: null, sortKey: null, display };
        const tag = { tagId: 'tag', tagKey: 'tag', sortKey: null, display };
        const label = { labelKind: 'workspace' as const, scopeKey: 'workspace', display };
        const written: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: url.origin === params.serverUrl ? 'plain' : 'e2ee', updatedAt: 0 });
            expect(url.origin).toBe(params.serverUrl);
            if (!init?.body) return Response.json({ snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], tags: [], labels: [], folderAssignments: [], tagAssignments: [], orderEntries: [] } });
            written.push(url.pathname);
            const body = JSON.parse(String(init.body));
            if (url.pathname.endsWith('/import')) {
                for (const row of [...body.folders, ...body.tags, ...body.labels]) expect(row.display).toEqual(display);
                return Response.json({ imported: { pins: 0, folders: 1, tags: 1, orderEntries: 0, labels: 1 } });
            }
            expect(body.display).toEqual(display);
            const row = { ...body, archivedAt: null, createdAt: 1, updatedAt: 1 };
            return Response.json(url.pathname.endsWith('/folders') ? { folder: row }
                : url.pathname.endsWith('/tags') ? { tag: row } : { label: row });
        });
        try {
            await upsertSessionFolder({ ...params, request: folder });
            await upsertSessionTag({ ...params, request: tag });
            await upsertSessionLabel({ ...params, request: label });
            await importLegacySessionOrganization({ ...params, request: { pins: [], folders: [folder], tags: [tag], labels: [label], tagAssignments: [], orderEntries: [] } });
            expect(written).toEqual(['/v2/session-organization/folders', '/v2/session-organization/tags', '/v2/session-organization/labels', '/v2/session-organization/import']);
        } finally {
            getStorage().getState().clearSessionOrganizationForServer(serverId);
        }
    });

    it.each([false, true])('deletes labels through the captured Account and preserves scope currentness (retired: %s)', async (retire) => {
        const { deleteSessionLabel } = await import('./deleteSessionLabel');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { buildSessionOrganizationLabelKey } = await import('@/sync/domains/session/organization/keys');
        const serverId = 'label-delete-scope';
        const request = { labelKind: 'workspace' as const, scopeKey: 'workspace' };
        const key = buildSessionOrganizationLabelKey({ serverId, ...request });
        const label = { ...request, display: { t: 'plain' as const, v: { label: 'Project' } },
            displayState: { status: 'available' as const, value: { label: 'Project' } }, archivedAt: null, createdAt: 1, updatedAt: 1 };
        getStorage().getState().commitSessionOrganizationOptimistic(getStorage().getState().upsertSessionOrganizationLabelOptimistic(serverId, label));
        let current = true;
        setRuntimeFetch(async () => Response.json({ error: 'ambient request must not run' }, { status: 409 }));
        const operation = deleteSessionLabel({ credentials: { token: 'plain' }, serverId, serverUrl: 'https://plain.example', request,
            requestAtEndpoint: async (path, init) => {
                expect(path).toBe('/v2/session-organization/labels');
                expect(init?.method).toBe('DELETE');
                expect(JSON.parse(String(init?.body))).toEqual(request);
                current = !retire;
                return Response.json({ ...request, archived: true });
            },
            assertCurrent: () => { if (!current) throw new Error('action_account_scope_changed'); },
        });
        try {
            if (retire) {
                await expect(operation).rejects.toThrow('action_account_scope_changed');
                expect(getStorage().getState().sessionOrganizationLabelsByLabelKey[key]).toEqual(label);
            } else {
                await operation;
                expect(getStorage().getState().sessionOrganizationLabelsByLabelKey[key]).toBeUndefined();
            }
        } finally {
            getStorage().getState().clearSessionOrganizationForServer(serverId);
        }
    });
});
