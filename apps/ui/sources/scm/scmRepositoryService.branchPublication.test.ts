import { afterEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';

import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import {
    createSessionFilesViewFixture,
    fileViewSnapshot,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { log } from '@/log';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { workspaceScopeFromProject } from '@/sync/domains/workspaces/workspaceScope';

// The shared harness substitutes HTTP, daemon RPC and native SDK boundaries;
// Account lifetimes, metadata mutation and repository publication remain real.
installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { ScmRepositoryService } = await import('./scmRepositoryService');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
});

describe('demanded SCM branch publication', () => {
    it('retains a guest-only Git remote on the exact Project row when the controller has the same path', async () => {
        const serverId = 'srv_scm_retain_guest';
        const guest = { v: 2, kind: 'managed', serverId, id: 'guest-checkout', managedId: 'guest',
            projectKey: 'guest-project', controller: { machineId: 'm1', installationId: 'test-installation' },
            rootPath: '/workspace', createdAtMs: 1 } as const;
        const controller = { serverId, id: 'controller-checkout', machineId: 'm1',
            projectKey: 'controller-project', rootPath: '/workspace', createdAtMs: 1 } as const;
        const list = createPlainProjectAccountRowListFixture({ workspaceRefs: [controller, guest] });
        let rows: readonly ProjectAccountRowV1[] = list.rows;
        const observedIdentity = { kind: 'github', deployment: 'https://github.com', repository: 'owner/guest-repo' };
        const snapshot = { ...fileViewSnapshot(), hostingProvider: {
            id: 'scm.github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com',
            nameWithOwner: 'owner/guest-repo', repositoryWebUrl: 'https://github.com/owner/guest-repo',
            remoteName: 'origin', urlSafety: { allowedSchemes: ['https:'] },
        } };
        fixture = await createSessionFilesViewFixture({ serverIdentityId: serverId,
            rpc: request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT
                && request.payload && typeof request.payload === 'object' && 'target' in request.payload
                ? { success: true, snapshot } : undefined,
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/project-rows/list') return Response.json({ ...list, rows });
                if (path !== '/v1/account/project-rows/mutate') return null;
                const decoded = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
                const changed = decoded.mutations.map(mutation => ({ key: mutation.key, content: mutation.content, revision: 1 }));
                rows = rows.map(row => changed.find(item => JSON.stringify(item.key) === JSON.stringify(row.key)) ?? row);
                return Response.json({ status: 'updated', rows: changed, cursor: 1 });
            },
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('projects.list', { serverId })).toMatchObject({ ok: true });
        expect(fixture.storage.getState().projectAccountRows?.workspaceRefs.map(ref => ref.id)).toEqual([controller.id, guest.id]);
        const scope = workspaceScopeFromProject(guest, guest.rootPath);
        await expect(new ScmRepositoryService().fetchSnapshotForMachinePath({ ...scope, path: scope.rootPath }))
            .resolves.toMatchObject({ hostingProvider: { nameWithOwner: 'owner/guest-repo' } });
        const persisted = (id: string) => rows.find(row => row.key.kind === 'workspace-ref' && row.key.id === id)?.content;
        expect(persisted(guest.id)).toMatchObject({ t: 'plain', v: { value: { kind: 'managed', repositoryIdentity: observedIdentity } } });
        expect(persisted(controller.id)).toMatchObject({ t: 'plain', v: { value: controller } });
        expect(persisted(controller.id)).not.toMatchObject({ t: 'plain', v: { value: { repositoryIdentity: observedIdentity } } });
    });

    it('publishes the demanded Branch into the real list matcher without a list read', async () => {
        const sessionId = 'branch-to-list';
        let record = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
            metadata: { path: '/workspace', machineId: 'm1', host: 'tester.local' } });
        const metadataRequests: string[] = [];
        const listRequests: string[] = [];
        let snapshot = fileViewSnapshot();
        fixture = await createSessionFilesViewFixture({ sessionId,
            rpc: request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT
                ? { success: true, snapshot } : undefined,
            request: createSessionReadBatchFetchBoundary(async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v2/sessions' || path === '/v2/sessions/active') listRequests.push(path);
                if (path !== `/v2/sessions/${sessionId}`) return null;
                const method = init?.method ?? 'GET';
                metadataRequests.push(method);
                if (method === 'GET') return Response.json({ session: record });
                if (method !== 'PATCH') return null;
                const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init?.body)));
                if (patch.mode !== 'owner') throw new Error('Expected owner Branch publication');
                expect(patch.sharedMetadata.expectedVersion).toBe(record.metadataVersion);
                expect(patch.expectedOwnerMetadata).toEqual(record.ownerMetadata);
                record = { ...record, metadata: patch.sharedMetadata.ciphertext,
                    ownerMetadata: patch.ownerMetadata, metadataVersion: record.metadataVersion + 1,
                    agentState: patch.agentState.ciphertext,
                    ...(patch.displayProjectionV1 ? { displayProjectionV1: patch.displayProjectionV1 } : {}) };
                return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: record.metadataVersion }, agentState: { version: record.agentStateVersion } }));
            }),
        });
        const { matchSessionListRowLocalFilter } = await import('@/sync/domains/session/listing/sessionListWorkFilter');
        const { storage, scope } = fixture;
        const filter = normalizeSessionListFilterV1({ homeServerIds: [scope.serverId], scope: 'all_accessible',
            branches: { include: ['main'], exclude: [] } });
        const currentMatch = () => {
            const row = storage.getState().sessionListRowsByServerId[scope.serverId]?.[sessionId];
            if (!row) throw new Error('Expected the published Session list row');
            return matchSessionListRowLocalFilter(row, scope.serverId, filter, { nowMs: 1 });
        };
        expect(currentMatch()).toBe('unavailable');
        listRequests.length = 0;
        const service = new ScmRepositoryService();
        await service.fetchSnapshotForSession(sessionId);
        expect(currentMatch()).toBe('match');
        const writesAfterPublication = metadataRequests.filter(method => method === 'PATCH').length;
        expect(writesAfterPublication).toBe(1);
        await service.fetchSnapshotForSession(sessionId);
        expect(metadataRequests.filter(method => method === 'PATCH')).toHaveLength(writesAfterPublication);
        snapshot = { ...snapshot, branch: { ...snapshot.branch, head: 'feature/changed' } };
        await service.fetchSnapshotForSession(sessionId);
        expect(currentMatch()).toBe('miss');
        expect(listRequests).toEqual([]);
    });

    it('keeps the snapshot usable and logs one sanitized warning when the metadata publication read is denied', async () => {
        const sessionId = 'branch-publication-failure';
        const snapshot = fileViewSnapshot();
        const metadataRequests: string[] = [];
        fixture = await createSessionFilesViewFixture({ sessionId,
            rpc: request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT ? { success: true, snapshot } : undefined,
            request: createSessionReadBatchFetchBoundary(async (url, init) => {
                if (new URL(String(url)).pathname !== `/v2/sessions/${sessionId}`) return null;
                const method = init?.method ?? 'GET';
                metadataRequests.push(method);
                return Response.json({ error: 'Forbidden', detail: 'private metadata transport detail' }, { status: 403 });
            }),
        });
        const before = log.getCount();
        const service = new ScmRepositoryService();

        await expect(service.fetchSnapshotForSession(sessionId)).resolves.toMatchObject({
            repo: { isRepo: true, rootPath: '/workspace' }, branch: { head: 'main' },
        });

        // Publication stops at its denied external read, without writing or
        // retrying, while the demanded SCM snapshot remains usable.
        expect(metadataRequests).toEqual(['GET']);
        const warnings = log.getLogs().slice(before).filter(line => line.includes('SCM branch observation'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).not.toContain('private metadata transport detail');
        expect(warnings[0]).not.toContain(sessionId);
    });
});
