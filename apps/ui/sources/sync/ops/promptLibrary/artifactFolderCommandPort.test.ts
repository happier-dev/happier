import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { writePromptLibraryRecord } from '@/sync/api/account/apiPromptLibraryCatalog';
import { getPromptLibraryCatalogValue, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { refreshPromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { executeArtifactFolderActionV1, readArtifactOrganizationV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { createUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

afterEach(() => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
});

describe('folder command Account port', () => {
    it('deletes a selected folder without reading the Account-wide Artifact inventory', async () => {
        const boundary = createPromptLibraryCatalogBoundary({ revision: 4, records: [{ key: 'folders', value: {
            v: 1, folders: [{ id: 'selected', name: 'Selected' }, { id: 'child', name: 'Child', parentId: 'selected' },
                { id: 'other', name: 'Other' }], artifactHeadersById: {
                member: { folderId: 'selected', tags: ['private'] }, unrelated: { folderId: 'other', tags: ['keep'] },
            },
        } }] });
        const fixture = await createPlainArtifactHomeFixture('https://folder-delete-cost.test', { handleRequest: boundary.handle });
        const account = await captureLazyActionAccountContext(fixture.home.id);
        const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
        try {
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.delete', input: {
                folderId: 'selected', expectedRevision: 4,
            } })).toEqual({ status: 'updated', revision: 5 });
            expect(boundary.read('folders')).toMatchObject({ value: {
                folders: [{ id: 'child', name: 'Child', parentId: null }, { id: 'other', name: 'Other' }],
                artifactHeadersById: { member: { folderId: null, tags: ['private'] }, unrelated: { folderId: 'other', tags: ['keep'] } },
            },
            });
            // Reject the global query even with an empty response: its cost otherwise scales with every unrelated Artifact.
            expect(fixture.requests.filter(request => request.path.startsWith('/v1/artifacts'))).toEqual([]);
        } finally { account.dispose(); await fixture.dispose(); }
    });

    it('keeps a legacy member unfiled after deleting and recreating the same folder id without losing tags', async () => {
        const boundary = createPromptLibraryCatalogBoundary({ revision: 4, records: [{ key: 'folders', value: {
            v: 1, folders: [{ id: 'legacy', name: 'Original' }],
        } }] });
        const fixture = await createPlainArtifactHomeFixture('https://folder-delete-legacy.test', { handleRequest: boundary.handle });
        await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'legacy-member', header: encodePlainArtifactStoredContent({ v: 1, kind: 'role.v1', folderId: 'legacy', tags: ['legacy-tag'] }),
            body: encodePlainArtifactStoredContent({ body: 'unchanged' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        const account = await captureLazyActionAccountContext(fixture.home.id);
        const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
        try {
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.delete', input: {
                folderId: 'legacy', expectedRevision: 4,
            } })).toEqual({ status: 'updated', revision: 5 });
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.create', input: {
                id: 'legacy', name: 'Recreated', expectedRevision: 5,
            } })).toEqual({ status: 'updated', revision: 6 });
            expect(await readArtifactOrganizationV1({ port, artifactId: 'legacy-member' })).toMatchObject({
                status: 'ready', header: { folderId: null, tags: ['legacy-tag'] },
            });
            expect(boundary.read('folders')).toMatchObject({ value: { deletedLegacyFolderIds: ['legacy'] } });
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folder.set', input: {
                artifactId: 'legacy-member', folderId: 'legacy', expectedRevision: 6,
            } })).toEqual({ status: 'updated', revision: 7 });
            expect(await readArtifactOrganizationV1({ port, artifactId: 'legacy-member' })).toMatchObject({
                status: 'ready', header: { folderId: 'legacy', tags: ['legacy-tag'] },
            });
            expect(fixture.requests.filter(request => request.method !== 'GET' && request.path.startsWith('/v1/artifacts')
                && request.projection !== 'headers')).toEqual([]);
        } finally { account.dispose(); await fixture.dispose(); }
    });

    it('reads empty folders from the captured Home catalog without loading document bodies', async () => {
        const boundary = createPromptLibraryCatalogBoundary({ revision: 4, records: [{ key: 'folders', value: {
            v: 1, folders: [{ id: 'parent', name: 'Parent' }, { id: 'empty', name: 'Empty', parentId: 'parent' }],
        } }] });
        const fixture = await createPlainArtifactHomeFixture('https://folder-read.test', { handleRequest: boundary.handle });
        const account = await captureLazyActionAccountContext(fixture.home.id);
        const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
        try {
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.list', input: {} })).toEqual({
                status: 'ready', items: [{ id: 'parent', name: 'Parent', parentId: null }, { id: 'empty', name: 'Empty', parentId: 'parent' }],
                revision: 4, coverage: 'complete', nextCursor: null,
            });
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.read', input: { folderId: 'empty' } }))
                .toEqual({ status: 'ready', item: { id: 'empty', name: 'Empty', parentId: 'parent' }, revision: 4, coverage: 'complete' });
            expect(boundary.requests).toHaveLength(0);
        } finally { account.dispose(); await fixture.dispose(); }
    });

    it('creates then renames without activating retained Settings history maintenance', async () => {
        const history = createDeferred<Response>();
        const boundary = createPromptLibraryCatalogBoundary({ revision: 4 });
        let historyStarted = false;
        const fixture = await createPlainArtifactHomeFixture('https://folder-pending-maintenance.test', { accountSettingsVersion: 2, handleRequest: async (path, init) => {
            if (path === PROFILE_TRANSFER_ROUTE_V1) return Response.json({ status: 'absent' });
            if (path === '/v2/account/settings/history') { historyStarted = true; return history.promise; }
            return boundary.handle(path, init);
        } });
        const account = await captureLazyActionAccountContext(fixture.home.id);
        const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
        let created: Awaited<ReturnType<typeof executeArtifactFolderActionV1>> | undefined;
        const create = executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.create', input: {
            id: 'r2-folder', name: 'Created', parentId: null, expectedRevision: 4,
        } }).then(result => { created = result; return result; });
        try {
            // A held HTTP boundary detects accidental maintenance without adding a production deadline.
            await vi.waitFor(() => expect(created).toEqual({ status: 'updated', revision: 5 }));
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.rename', input: {
                folderId: 'r2-folder', name: 'Renamed', expectedRevision: 5,
            } })).toEqual({ status: 'updated', revision: 6 });
            expect(boundary.read('folders')).toMatchObject({ value: { folders: [{ id: 'r2-folder', name: 'Renamed' }] } });
            await vi.waitFor(() => expect(getPromptLibraryCatalogValue({ serverId: fixture.home.id, accountId: 'artifact-account' }, 'folders'))
                .toMatchObject({ status: 'ready', revision: 6, value: { folders: [{ id: 'r2-folder', name: 'Renamed' }] } }));
            expect(historyStarted).toBe(false);
        } finally {
            history.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
            await create;
            account.dispose();
            await fixture.dispose();
        }
    });

    it('refreshes the current folder row after a CAS conflict', async () => {
        const boundary = createPromptLibraryCatalogBoundary({ revision: 4 });
        const fixture = await createPlainArtifactHomeFixture('https://folder-conflict-refresh.test', { handleRequest: boundary.handle });
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        try {
            await refreshPromptLibraryCatalog(scope);
            const record = { key: 'folders', value: { v: 1, folders: [{ id: 'neighbor', name: 'Neighbor', parentId: null }] } } satisfies PromptLibraryRecordV1;
            await boundary.handle('/v1/account/entity-rows/prompt-library/folders', { method: 'POST', body: JSON.stringify({
                expectedRevision: 4, content: { t: 'plain', v: record },
            }) });
            expect(await writePromptLibraryRecord(scope, { record: { key: 'folders', value: { v: 1, folders: [] } }, expectedRevision: 4 }))
                .toEqual({ status: 'conflict', revision: 5 });
            await vi.waitFor(() => expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', revision: 5,
                value: { folders: [{ id: 'neighbor', name: 'Neighbor' }] }, stale: false }));
        } finally { await fixture.dispose(); }
    });

    it('publishes a stale command revision refusal and accepts an explicit retry', async () => {
        const boundary = createPromptLibraryCatalogBoundary({ revision: 4, records: [{ key: 'folders', value: {
            v: 1, folders: [{ id: 'r2-folder', name: 'Original', parentId: null }],
        } }] });
        const fixture = await createPlainArtifactHomeFixture('https://folder-command-retry.test', { handleRequest: boundary.handle });
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        const account = await captureLazyActionAccountContext(fixture.home.id);
        const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
        try {
            await refreshPromptLibraryCatalog(scope);
            await boundary.handle('/v1/account/entity-rows/prompt-library/folders', { method: 'POST', body: JSON.stringify({
                expectedRevision: 4, content: { t: 'plain', v: { key: 'folders', value: { v: 1, folders: [
                    { id: 'r2-folder', name: 'Original', parentId: null }, { id: 'neighbor', name: 'Neighbor', parentId: null },
                ] } } },
            }) });
            const rename = (expectedRevision: number) => executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.rename',
                input: { folderId: 'r2-folder', name: 'Renamed', expectedRevision } });
            expect(await rename(4)).toEqual({ status: 'conflict', revision: 5 });
            expect(boundary.read('folders')).toMatchObject({ value: { folders: [
                { id: 'r2-folder', name: 'Original' }, { id: 'neighbor', name: 'Neighbor' },
            ] } });
            await vi.waitFor(() => expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', revision: 5, stale: false }));
            expect(await rename(5)).toEqual({ status: 'updated', revision: 6 });
            expect(boundary.read('folders')).toMatchObject({ value: { folders: [
                { id: 'r2-folder', name: 'Renamed' }, { id: 'neighbor', name: 'Neighbor' },
            ] } });
        } finally { account.dispose(); await fixture.dispose(); }
    });
});
