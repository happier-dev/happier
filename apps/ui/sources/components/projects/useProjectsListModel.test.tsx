import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { forgetProjectWorkspace } from '@/sync/ops/actions/projectWorkspaceActions';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const confirmation = vi.hoisted(() => ({ name: 'Renamed' }));
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { prompt: async () => confirmation.name } }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
const { useProjectsListModel } = await import('./useProjectsListModel');
const { storage } = await import('@/sync/domains/state/storage');
let serverId: string;
let rows: ProjectAccountRowV1[];
const mutationPath = '/v1/account/project-rows/mutate';
const repository = { provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'owner/repo', visibility: 'private' as const }, protocol: 'https' as const };

beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Projects Home', serverUrl: 'https://projects-menu.test', accountId: 'account-a' });
    rows = [{ key: { kind: 'workspace-ref', serverId, id: 'ref' }, revision: 0, content: { t: 'plain', v: {
        key: { kind: 'workspace-ref', serverId, id: 'ref' }, value: { id: 'ref', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 },
    } } }];
    homes.answer(serverId, '/v1/account/project-rows/list', { select: () => ({ body: { status: 'listed', coverage: 'complete', rows } }) });
    homes.answer(serverId, mutationPath, { select: input => {
        const request = ProjectAccountRowMutationRequestV1Schema.parse(input);
        const changed = request.mutations.map(item => ({ key: item.key, revision: (rows.find(row => JSON.stringify(row.key) === JSON.stringify(item.key))?.revision ?? -1) + 1, content: item.content }));
        rows = [...rows.filter(row => !changed.some(item => JSON.stringify(item.key) === JSON.stringify(row.key))), ...changed];
        return { body: { status: 'updated', rows: changed, cursor: 1 } };
    } });
    homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://projects-menu.test')!.token! });
    storage.getState().activateProjectAccountRowsScope({ serverId, accountId: 'account-a' });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    await createDefaultActionExecutor().execute('projects.list', { serverId });
    homes.requests.length = 0; routerPush.mockClear();
});
afterEach(async () => {
    await standardCleanup();
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection(); await homes.reset();
});

describe('Projects model Action admission', () => {
    it('denied unlinked Forget leaves the accepted ref intact; granted Forget retires it', async () => {
        await homes.requireUiApproval(serverId, 'projects.workspace.forget');
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        await act(async () => { expect(await hook.getCurrent().removeProject(ref)).toMatchObject({ kind: 'approval_request_created' }); });
        expect(homes.requestsFor(mutationPath)).toEqual([]);
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).not.toBeNull();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const deniedId = hook.getCurrent().projectActionApproval?.artifactId;
        if (!deniedId) throw new Error('Expected the canonical approval receipt');
        const denial = await executor.execute('approval.request.decide', { artifactId: deniedId, decision: 'reject' }, { surface: 'ui', serverId });
        expect(denial, JSON.stringify(denial)).toMatchObject({ ok: true, result: { status: 'rejected' } });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).not.toBeNull();
        await act(async () => { await hook.getCurrent().removeProject(ref); });
        const grantedId = hook.getCurrent().projectActionApproval?.artifactId;
        if (!grantedId || grantedId === deniedId) throw new Error('Expected a new canonical approval request');
        await act(async () => { expect(await executor.execute('approval.request.decide', { artifactId: grantedId, decision: 'approve' }, { surface: 'ui', serverId }))
            .toMatchObject({ ok: true, result: { status: 'executed' } }); });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).toBeNull();
        await hook.unmount();
    });

    it('opens New session here with exact placement and offers the same Clone/Manage data', async () => {
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        const opened = hook.getCurrent().newSessionHere(ref);
        expect(opened).toMatchObject({ kind: 'opened' });
        if (opened.kind !== 'opened') throw new Error('Expected a seeded New Session draft');
        expect(routerPush).toHaveBeenCalledWith({ pathname: '/new', params: expect.objectContaining({ draftId: expect.any(String) }) });
        expect(readNewSessionDraftProjectionFromRepository({ scope: { serverId, accountId: 'account-a' }, draftId: opened.draftId })?.draft)
            .toMatchObject({ selectedMachineId: 'machine', selectedPath: '/repo', targetServerId: serverId });
        expect(hook.getCurrent().addSources).toMatchObject({ yours: [], teams: [], onManage: expect.any(Function) });
        expect(hook.getCurrent().cloneRepository).toBeTypeOf('function');
        await hook.unmount();
    });

    it('renames, clears the label and pins the existing anchor through the admitted metadata Action', async () => {
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        await act(async () => { await hook.getCurrent().renameProject(ref); });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).toMatchObject({ t: 'plain', v: { value: { label: 'Renamed', projectKey: 'anchor' } } });
        await act(async () => { await hook.getCurrent().resetProjectName(ref); await hook.getCurrent().togglePinned(ref.id); });
        expect(rows.find(row => row.key.kind === 'workspace-ref')?.content).toMatchObject({ t: 'plain', v: { value: { label: null, projectKey: 'anchor' } } });
        expect(rows.find(row => row.key.kind === 'project-organization')?.content).toMatchObject({ t: 'plain', v: { value: { pinned: true } } });
        await hook.unmount();
    });

    it('an admitted Forget refuses even a paused link without changing the accepted rows', async () => {
        const target = { id: 'target', serverId, machineId: 'other', rootPath: '/target', projectKey: 'anchor', createdAtMs: 1 };
        const targetKey = { kind: 'workspace-ref' as const, serverId, id: 'target' };
        const policy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const relationship = WorkspaceSyncRelationshipV1Schema.parse({ v: 1, relationshipId: 'link', controllerMachineId: 'machine',
            alphaWorkspaceRefId: 'ref', betaWorkspaceRefId: 'target', mode: 'keep_synced', enabled: false,
            contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 });
        const graphKey = { kind: 'relationship-graph' as const };
        rows.push({ key: targetKey, revision: 0, content: { t: 'plain', v: { key: targetKey, value: target } } },
            { key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } });
        const before = [...rows];
        expect(await forgetProjectWorkspace({ serverId, workspaceId: 'ref' }))
            .toMatchObject({ ok: false, errorCode: 'workspace_ref_in_use', details: { relationshipIds: ['link'] } });
        expect(rows).toEqual(before); expect(homes.requestsFor(mutationPath)).toEqual([]);
    });

    it('includes group and direct Account grants in the shared admitted Add composition', async () => {
        const shared = [
            { id: 'group-source', revision: 1, name: 'Group source', repository, createdByAccountId: 'owner',
                audience: [{ principal: { kind: 'group', teamId: 'team', groupId: 'group' }, level: 'view' }] },
            { id: 'account-source', revision: 1, name: 'Direct source', repository, createdByAccountId: 'owner',
                audience: [{ principal: { kind: 'account', accountId: 'account-a' }, level: 'view' }] },
        ];
        homes.answer(serverId, `/v1/projects/sources?serverId=${encodeURIComponent(serverId)}&query=`, {
            body: { ok: true, sources: shared, coverage: { complete: true, nextCursor: null } },
        });
        const hook = await renderHook(() => useProjectsListModel());
        await act(async () => { await hook.getCurrent().sourceCreation.controller.load(); });
        expect(hook.getCurrent().addSources?.teams.flatMap(group => group.sources.map(source => source.id)))
            .toEqual(['group-source', 'account-source']);
        await hook.unmount();
    });

    it('creates a Source through admission and records provenance on the accepted ref without changing its anchor', async () => {
        homes.answer(serverId, '/v1/projects/sources', { body: {
            ok: true, canManage: true, source: { id: 'source-a', revision: 1,
                name: 'Repository', repository, audience: [], createdByAccountId: 'account-a' },
        } });
        const hook = await renderHook(() => useProjectsListModel());
        const ref = hook.getCurrent().groups.projectGroups[0]!.items[0]!;
        await act(async () => { expect(await hook.getCurrent().saveAsSource(ref, { name: 'Repository', repository, audience: [] }))
            .toMatchObject({ kind: 'saved', source: { id: 'source-a' } }); });
        const content = rows.find(row => row.key.kind === 'workspace-ref')?.content;
        expect(content).toMatchObject({ t: 'plain', v: { value: { projectKey: 'anchor', source: { sourceId: 'source-a', revision: 1 } } } });
        expect(homes.requestsFor('/v1/projects/sources')).toHaveLength(1);
        await hook.unmount();
    });
});
