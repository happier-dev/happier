import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ProjectAccountRowMutationRequestV1Schema, ProjectAccountRowReadRequestV1Schema, buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { setProjectVisibilityV1 } from '@happier-dev/protocol/projects/projectVisibilityV1';
import { createProjectAccountRowsDomain, type ProjectAccountRowsDomain } from '@/sync/store/domains/projectAccountRows';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { createProjectAccountRowsSync } from '@/sync/engine/projects/projectAccountRowsSync';
import { createUiProjectAccountRowsClient } from './projectAccountRowsClient';

const store = createStore<ProjectAccountRowsDomain>()((set, get) => createProjectAccountRowsDomain({ set, get }));
// The app sync engine is the composition root that holds the one Project rows owner for its
// Account/Home; the handle is stubbed to expose a real owner over a counting HTTP boundary.
const appRows: { owner: ReturnType<typeof createProjectAccountRowsSync> | null; scope: { serverId: string; accountId: string } | null } = { owner: null, scope: null };
vi.mock('@/sync/sync', () => ({ sync: { projectAccountRowsOwnerFor: (scope: { serverId: string; accountId: string }) =>
  appRows.owner && appRows.scope?.serverId === scope.serverId && appRows.scope.accountId === scope.accountId ? Promise.resolve(appRows.owner) : null } }));
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({ storage: { getState: () => store.getState() } });
});

describe('Project rows Actions for the app Account', () => {
  it('read the app owner held rows (row-level hints included) and never re-open rows through a second reader', async () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    store.getState().clearProjectAccountRowsScope(); store.getState().activateProjectAccountRowsScope(scope);
    const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(3) },
      randomBytes: length => new Uint8Array(length).fill(4) });
    let opens = 0;
    const counted = { ...cipher, open: (...args: Parameters<typeof cipher.open>) => { opens++; return cipher.open(...args); } };
    const ref = (id: string, label?: string) => ({ id, serverId: scope.serverId, machineId: 'machine', rootPath: `/${id}`, createdAtMs: 1, ...(label ? { label } : {}) });
    const rows = new Map<string, ProjectAccountRowV1>();
    const put = (value: ReturnType<typeof ref>, revision: number) => {
      const key = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: value.id };
      rows.set(JSON.stringify(key), { key, revision, content: cipher.seal({ key, value }) });
    };
    for (let index = 0; index < 20; index++) put(ref(`ref-${index}`), 0);
    let lists = 0;
    // HTTP is the boundary: list and exact row read over the same server rows.
    const transport = {
      list: async () => { lists++; return { status: 'listed' as const, coverage: 'complete' as const, rows: [...rows.values()] }; },
      read: async (key: ProjectAccountRowV1['key']) => { const row = rows.get(JSON.stringify(key)); return row ? { status: 'present' as const, row } : { status: 'absent' as const }; },
      mutate: async () => { throw new Error('unexpected write'); },
    };
    appRows.scope = scope;
    appRows.owner = createProjectAccountRowsSync({ scope, cipher: counted, transport, isCurrent: () => true,
      apply: (...args) => store.getState().applyProjectAccountRowsForScope(scope, ...args) });
    await appRows.owner.refresh();
    // A row-level change hint after the census: the held rows must carry it.
    put(ref('ref-3', 'Renamed'), 1);
    await appRows.owner.refreshKeys([buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: scope.serverId, id: 'ref-3' })]);
    const before = { lists, opens };
    let accountRequests = 0;
    const reads: { rows: Awaited<ReturnType<ReturnType<typeof createUiProjectAccountRowsClient>['read']>>; reference: unknown }[] = [];
    // Three Action reads (PR open: projects.list + Project context + widget reference) through fresh clients.
    for (let index = 0; index < 3; index++) {
      const client = createUiProjectAccountRowsClient({ ...scope, credentials: { token: 'token' }, assertCurrent: () => {},
        resolveAccountEncryption: async () => { accountRequests++; return { accountMode: 'plain' as const, encryption: null }; },
        request: async () => { accountRequests++; return new Response(JSON.stringify({ status: 'listed', coverage: 'complete', rows: [] })); } });
      reads.push({ rows: await client.read(), reference: await client.readProjectReference({ serverId: scope.serverId, projectKey: 'ref-5' }) });
    }
    // Reads use the held rows; each reference guard (a write precondition) is one census on the
    // same owner, which re-opens no unchanged row and never builds a second reader.
    expect({ listsAfterActions: lists - before.lists, opensAfterActions: opens - before.opens, accountRequests })
      .toEqual({ listsAfterActions: 3, opensAfterActions: 0, accountRequests: 0 });
    for (const read of reads) {
      expect(read.rows.workspaceRefs).toHaveLength(20);
      expect(read.rows.workspaceRefs.find(item => item.id === 'ref-3')?.label).toBe('Renamed');
      expect(read.reference).toBe('referenced');
    }
    appRows.owner = null; appRows.scope = null;
  });
});

describe('Project visibility through the real UI row transport and store', () => {
  it('opens and commits selected defaults through the captured Account without publishing them to the census', async () => {
    const scope = { serverId: 'home-defaults', accountId: 'account-defaults' };
    store.getState().clearProjectAccountRowsScope();
    store.getState().activateProjectAccountRowsScope(scope);
    const censusBefore = store.getState().projectAccountRows;
    const key = { kind: 'project-session-defaults' as const, serverId: scope.serverId, projectKey: 'selected' };
    let row: ProjectAccountRowV1 | undefined;
    const operations: string[] = [];
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: length => new Uint8Array(length) });
    const signal = new AbortController().signal;
    let current = true;
    const client = createUiProjectAccountRowsClient({ ...scope, credentials: { token: 'plain-token' },
      assertCurrent: () => { if (!current) throw new Error('retired'); },
      resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
      request: async (path, init) => {
        expect(init?.signal).toBe(signal);
        operations.push(path);
        const body: unknown = JSON.parse(String(init?.body));
        if (path.endsWith('/read')) {
          expect(ProjectAccountRowReadRequestV1Schema.parse(body).key).toEqual(key);
          return Response.json(row ? { status: 'present', row } : { status: 'absent' });
        }
        expect(path).toBe('/v1/account/project-rows/mutate');
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        const mutation = request.mutations[0]!;
        expect(request).toMatchObject({ expectedRefs: [], topologyChange: false });
        expect(mutation.key).toEqual(key);
        row = { key, revision: (row?.revision ?? -1) + 1, content: mutation.content };
        return Response.json({ status: 'updated', rows: [row], cursor: row.revision });
      },
    });
    const project = { serverId: key.serverId, projectKey: key.projectKey };
    expect(await client.readSessionDefaults(project, signal)).toBeNull();
    expect(await client.mutateSessionDefaults({ ...project, expectedRevision: 'absent', defaults: {}, signal }))
      .toEqual({ status: 'updated', revision: 0, value: {} });
    expect(await client.readSessionDefaults(project, signal)).toEqual({ revision: 0, defaults: {} });
    expect(row?.content && cipher.open(key, row.content)).toEqual({ key, value: {} });
    expect(operations.filter(path => path.endsWith('/mutate'))).toHaveLength(1);
    expect(operations.some(path => path.endsWith('/list'))).toBe(false);
    expect(store.getState().projectAccountRows).toBe(censusBefore);
    current = false;
    const issued = operations.length;
    await expect(client.readSessionDefaults(project, signal)).rejects.toThrow();
    expect(operations).toHaveLength(issued);
  });
  it('reports indeterminate mutation settlement when cancellation follows HTTP issuance', async () => {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const abort = new AbortController();
    const key = { kind: 'workspace-ref' as const, serverId: scope.serverId, id: 'ref' };
    store.getState().clearProjectAccountRowsScope(); store.getState().activateProjectAccountRowsScope(scope);
    const client = createUiProjectAccountRowsClient({ ...scope, credentials: { token: 'plain-token' }, assertCurrent: () => {},
      resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
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
      resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
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
    await expect(client.readProjectReference({ serverId: 'foreign', projectKey: 'anchor' }))
      .rejects.toMatchObject({ code: 'project_account_access_denied' });
    await expect(client.readProjectReference({ serverId: scope.serverId, projectKey: 'anchor' }, undefined, { runtimeAccountId: 'foreign' }))
      .rejects.toMatchObject({ code: 'project_account_access_denied' });
    expect(await client.readProjectReference({ serverId: scope.serverId, projectKey: 'anchor' })).toBe('referenced');
    expect(await client.forgetWorkspace({ serverId: scope.serverId, workspaceId: 'ref' })).toEqual({ ok: true, workspaceId: 'ref' });
    expect(rows.get(JSON.stringify(refKey))?.content).toBe(null);
    expect(store.getState().projectAccountRows?.workspaceRefs).toEqual([]);
    // Retained organization preferences do not recreate a forgotten Project anchor.
    expect(await client.readProjectReference({ serverId: scope.serverId, projectKey: 'anchor' })).toBe('unreferenced');
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
      resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
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
      assertCurrent: () => {}, resolveAccountEncryption: async () => ({ accountMode: 'plain' as const, encryption: null }),
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
