import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { setProjectVisibilityV1 } from '@happier-dev/protocol/projects/projectVisibilityV1';
import { createProjectAccountRowsDomain, type ProjectAccountRowsDomain } from '@/sync/store/domains/projectAccountRows';
import { createUiProjectAccountRowsClient } from './projectAccountRowsClient';

const store = createStore<ProjectAccountRowsDomain>()((set, get) => createProjectAccountRowsDomain({ set, get }));
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({ storage: { getState: () => store.getState() } });
});

describe('Project visibility through the real UI row transport and store', () => {
  it('reports indeterminate mutation settlement when cancellation follows HTTP issuance', async () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const abort = new AbortController();
    const key = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: 'ref' };
    store.getState().clearProjectAccountRowsScope(); store.getState().activateProjectAccountRowsScope(scope);
    const client = createUiProjectAccountRowsClient({ ...scope, credentials: { token: 'plain-token' }, assertCurrent: () => {},
      resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
      request: async path => {
        if (path.endsWith('/list')) return new Response(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [{ key, revision: 0,
          content: { t: 'plain', v: { key, value: { id: 'ref', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 } } } }] }));
        abort.abort(); throw new DOMException('Request aborted after issuance', 'AbortError');
      },
    });
    expect(await client.updateWorkspace({ serverId: scope.serverId, workspaceId: 'ref', label: 'Named', signal: abort.signal }))
      .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
  });
  it('updates and Forgets through captured Account rows while refusing foreign private-row authority before HTTP', async () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    store.getState().clearProjectAccountRowsScope(); store.getState().activateProjectAccountRowsScope(scope);
    const refKey = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: 'ref' };
    const organizationKey = { kind: 'project-organization' as const, serverId: scope.serverId, projectKey: 'anchor' };
    const rows = new Map<string, ProjectAccountRowV1>([
      [JSON.stringify(refKey), { key: refKey, revision: 0, content: { t: 'plain', v: { key: refKey,
        value: { id: 'ref', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'anchor', createdAtMs: 1 } } } }],
      [JSON.stringify(organizationKey), { key: organizationKey, revision: 4, content: { t: 'plain', v: { key: organizationKey, value: { hidden: true } } } }],
    ]);
    const client = createUiProjectAccountRowsClient({ ...scope, credentials: { token: 'plain-token' }, assertCurrent: () => {},
      resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
      request: async (path, init) => {
        if (path.endsWith('/list')) return new Response(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [...rows.values()] }));
        const input = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
        for (const mutation of input.mutations) {
          const previous = rows.get(JSON.stringify(mutation.key));
          if ((previous?.revision ?? 'absent') !== mutation.expectedRevision) return new Response(JSON.stringify({ status: 'conflict', key: mutation.key, revision: previous?.revision ?? -1 }));
        }
        const changed = input.mutations.map(mutation => ({ key: mutation.key,
          revision: (rows.get(JSON.stringify(mutation.key))?.revision ?? -1) + 1, content: mutation.content }));
        for (const row of changed) rows.set(JSON.stringify(row.key), row);
        return new Response(JSON.stringify({ status: 'updated', rows: changed, cursor: 1 }));
      },
    });
    expect(await client.updateWorkspace({ serverId: scope.serverId, workspaceId: 'ref', label: 'Named', pinned: true }))
      .toMatchObject({ ok: true, workspaceRef: { id: 'ref', label: 'Named' }, organization: { hidden: true, pinned: true } });
    const address = { serverId: scope.serverId, workspaceId: 'ref', machineId: 'machine', rootPath: '/repo' };
    expect(await client.recordWorkspaceSource({ ...address, workspaceId: ' ref ' }, { sourceId: 'source', revision: 2 }))
      .toEqual({ ok: true, workspaceId: 'ref' });
    expect(store.getState().projectAccountRows?.workspaceRefs).toMatchObject([
      { id: 'ref', label: 'Named', projectKey: 'anchor', source: { sourceId: 'source', revision: 2 } },
    ]);
    expect(await client.recordWorkspaceSource({ ...address, rootPath: '/other' }, { sourceId: 'wrong-source', revision: 1 }))
      .toMatchObject({ ok: false, errorCode: 'workspace_ref_not_found' });
    expect(await client.forgetWorkspace({ serverId: scope.serverId, workspaceId: 'ref' }, { runtimeAccountId: 'foreign' }))
      .toMatchObject({ ok: false, errorCode: 'project_account_access_denied' });
    expect(store.getState().projectAccountRows?.workspaceRefs).toHaveLength(1);
    expect(await client.forgetWorkspace({ serverId: scope.serverId, workspaceId: 'ref' })).toEqual({ ok: true, workspaceId: 'ref' });
    expect(rows.get(JSON.stringify(refKey))?.content).toBe(null);
    expect(store.getState().projectAccountRows?.workspaceRefs).toEqual([]);
  });
  it('does not erase authoring-memory recency when an Action refreshes structural Account rows', async () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const ref = { id: 'ref', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    const key = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: ref.id };
    store.getState().clearProjectAccountRowsScope();
    store.getState().activateProjectAccountRowsScope(scope);
    store.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [{ ...ref, lastOpenedAtMs: 111 }], organizations: [], relationships: [], revisionsByPhysicalKey: {} });
    const client = createUiProjectAccountRowsClient({ ...scope, credentials: { token: 'plain-token' }, assertCurrent: () => {},
      resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
      request: async () => new Response(JSON.stringify({ status: 'listed', coverage: 'complete',
        rows: [{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } }] })),
    });
    expect((await client.read()).workspaceRefs[0]?.lastOpenedAtMs).toBe(111);
    expect(store.getState().projectAccountRows?.workspaceRefs[0]?.lastOpenedAtMs).toBe(111);
  });
  it('preserves organization neighbors through Hide/Show, rejects stale revisions and another Home without writing', async () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    store.getState().clearProjectAccountRowsScope();
    store.getState().activateProjectAccountRowsScope(scope);
    const key = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'anchor' };
    let row: ProjectAccountRowV1 = { key, revision: 2, content: { t: 'plain', v: { key, value: { pinned: true, promptStack: [] } } } };
    const writes: ReturnType<typeof ProjectAccountRowMutationRequestV1Schema.parse>[] = [];
    const client = createUiProjectAccountRowsClient({ ...scope, credentials: { token: 'plain-token' },
      assertCurrent: () => {}, resolveAccountEncryption: async () => ({ accountMode: 'plain', encryption: null }),
      // HTTP is the genuine external boundary. Cipher, CAS intent and store stay real.
      request: async (path, init) => {
        if (path.endsWith('/list')) return new Response(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [row] }));
        const request = ProjectAccountRowMutationRequestV1Schema.parse(JSON.parse(String(init?.body)));
        writes.push(request);
        const mutation = request.mutations[0]!;
        row = { key, revision: row.revision + 1, content: mutation.content };
        return new Response(JSON.stringify({ status: 'updated', rows: [row], cursor: row.revision }));
      },
    });
    const owner = { accountScope: () => scope, mutateOrganization: client.mutateOrganization };
    const target = { serverId: scope.serverId, projectKey: key.projectKey };
    expect(await setProjectVisibilityV1(owner, { target, expectedRevision: 2, hidden: true }))
      .toEqual({ ok: true, row: { hidden: true, pinned: true, promptStack: [] }, revision: 3 });
    expect(store.getState().projectAccountRows?.organizations[0]?.value.hidden).toBe(true);
    expect(await setProjectVisibilityV1(owner, { target, expectedRevision: 2, hidden: false }))
      .toEqual({ ok: false, errorCode: 'project_visibility_conflict', currentRevision: 3 });
    expect(writes).toHaveLength(1);
    expect(await setProjectVisibilityV1(owner, { target: { ...target, serverId: 'home-b' }, expectedRevision: 3, hidden: false }))
      .toMatchObject({ ok: false, errorCode: 'project_visibility_access_denied' });
    expect(writes).toHaveLength(1);
    expect(await setProjectVisibilityV1(owner, { target, expectedRevision: 3, hidden: false }))
      .toEqual({ ok: true, row: { hidden: false, pinned: true, promptStack: [] }, revision: 4 });
    expect(writes.every(request => !request.topologyChange && request.expectedRefs.length === 0)).toBe(true);
    expect(store.getState().projectAccountRows?.organizations[0]?.value).toEqual({ hidden: false, pinned: true, promptStack: [] });
    // Undo carries the original Hide receipt, never a freshly read revision that could supersede a later Show.
    expect(await setProjectVisibilityV1(owner, { target, expectedRevision: 3, hidden: false }))
      .toEqual({ ok: false, errorCode: 'project_visibility_conflict', currentRevision: 4 });
    expect(writes).toHaveLength(2);
    expect(store.getState().projectAccountRows?.organizations[0]?.value.hidden).toBe(false);
  });
});
