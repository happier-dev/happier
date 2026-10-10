import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { writePromptLibraryRecord } from '@/sync/api/account/apiPromptLibraryCatalog';
import { getPromptLibraryCatalogValue, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { refreshPromptLibraryCatalog, resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { executeArtifactFolderActionV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import type { PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { createUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

afterEach(() => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
});

describe('folder command Account port', () => {
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
        } finally { account.dispose(); fixture.dispose(); }
    });

    it('creates then renames while history maintenance is pending', async () => {
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
            await vi.waitFor(() => expect(historyStarted).toBe(true));
            // A held HTTP request, not a production deadline, discriminates demand from maintenance.
            await vi.waitFor(() => expect(created).toEqual({ status: 'updated', revision: 5 }));
            expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.rename', input: {
                folderId: 'r2-folder', name: 'Renamed', expectedRevision: 5,
            } })).toEqual({ status: 'updated', revision: 6 });
            expect(boundary.read('folders')).toMatchObject({ value: { folders: [{ id: 'r2-folder', name: 'Renamed' }] } });
            expect(getPromptLibraryCatalogValue({ serverId: fixture.home.id, accountId: 'artifact-account' }, 'folders'))
                .toMatchObject({ status: 'ready', revision: 6, value: { folders: [{ id: 'r2-folder', name: 'Renamed' }] } });
        } finally {
            history.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
            await create;
            account.dispose();
            fixture.dispose();
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
            expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', revision: 5,
                value: { folders: [{ id: 'neighbor', name: 'Neighbor' }] }, stale: false });
        } finally { fixture.dispose(); }
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
            expect(boundary.requests).toHaveLength(1); // Refusal happened before POST; only the other client's write exists.
            expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', revision: 5, stale: false });
            expect(await rename(5)).toEqual({ status: 'updated', revision: 6 });
            expect(boundary.read('folders')).toMatchObject({ value: { folders: [
                { id: 'r2-folder', name: 'Renamed' }, { id: 'neighbor', name: 'Neighbor' },
            ] } });
        } finally { account.dispose(); fixture.dispose(); }
    });
});
