import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowMutationRequestV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createProjectAccountSnapshotMutation, readProjectAccountRows, mutateProjectAccountOrganization,
  getActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { updatePersonalProjectContextV1, ProjectContextUpdateInputV1Schema, type ProjectContextActionOwnerDepsV1 } from '@happier-dev/protocol/projects/projectContextV1';
import { PromptStackEntryV1Schema } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });
const credentials = { token: 'project-token', encryption: null };
const ref = { id: 'ref-a', serverId: 'home-a', machineId: 'machine-a', rootPath: '/work/a', createdAtMs: 1 };
const key = { kind: 'workspace-ref' as const, serverId: 'home-a', id: ref.id };
const graphKey = { kind: 'relationship-graph' as const };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}
function boundary(rows: unknown[]) {
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  return vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
    const request = body as ProjectAccountRowMutationRequestV1;
    for (const mutation of request.mutations) {
      const index = rows.findIndex(row => JSON.stringify(Reflect.get(row as object, 'key')) === JSON.stringify(mutation.key));
      const next = { key: mutation.key, revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1, content: mutation.content };
      if (index < 0) rows.push(next); else rows[index] = next;
    }
    return { status: 200, data: { status: 'updated', rows: request.mutations.map(mutation => rows.find(row => JSON.stringify(Reflect.get(row as object, 'key')) === JSON.stringify(mutation.key))), cursor: 1 } };
  });
}
describe('Project Account row transport', () => {
  it('uses admitted requester HTTP and cipher ports for private row acceptance without replacing the daemon snapshot', async () => {
    boundary([]);
    const daemonSnapshot = await readProjectAccountRows({ credentials });
    const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
      randomBytes: n => new Uint8Array(n).fill(2) });
    let current = true;
    const requests: unknown[] = [];
    // The host has already proved this carrier; the network/signing boundary supplies HTTP headers.
    const authorization = { requesterAccountProjection: { accountId: 'bob', serverId: 'home-a', accountEncryptionMode: 'e2ee',
      projectAccountRowCipher: cipher, isCurrent: async () => current, readArtifact: async () => null },
      requesterHttpProjection: { accountId: 'bob', serverId: 'home-a', serverIdentityId: 'home-identity', serverHttpBaseUrl: 'https://bob-home.example',
        accountEncryptionMode: 'e2ee', isCurrent: async () => current,
        createRequestHeaders: async (request: unknown) => { requests.push(request); return current ? { 'x-requester-proof': 'bob' } : null; } },
      binding: { accountId: 'bob', accountEncryptionMode: 'e2ee' } } as ExternalActionExecutionAuthorizationV1;
    const transport = vi.mocked(axios.post);
    transport.mockClear();
    const get = vi.mocked(axios.get);
    get.mockClear();
    const input = { authorization, effectActionId: 'projects.open', serverId: 'home-a' };
    expect(await createProjectAccountSnapshotMutation(input)(snapshot => ({ ...snapshot, workspaceRefs: [ref] })))
      .toMatchObject({ status: 'applied', snapshot: { workspaceRefs: [ref] } });
    expect(get).not.toHaveBeenCalled();
    expect(transport.mock.calls.every(([url, , config]) => url.startsWith('https://bob-home.example')
      && config?.headers?.['x-requester-proof'] === 'bob' && !config?.headers?.Authorization)).toBe(true);
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ effectActionId: 'projects.open', method: 'POST' })]));
    expect(getActiveProjectAccountRowsSnapshot()).toBe(daemonSnapshot);
    current = false;
    transport.mockClear();
    await expect(readProjectAccountRows(input)).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not resurrect a deleted ref or older graph when an earlier complete read arrives last', async () => {
    const post = boundary([]);
    const readStarted = deferred();
    const releaseRead = deferred();
    let firstRead = true;
    post.mockImplementation(async () => {
      if (firstRead) {
        firstRead = false;
        readStarted.resolve();
        await releaseRead.promise;
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
          { key, revision: 3, content: { t: 'plain', v: { key, value: ref } } },
          { key: graphKey, revision: 4, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
        ] } };
      }
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key, revision: 4, content: null },
        { key: graphKey, revision: 5, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
      ] } };
    });
    const older = readProjectAccountRows({ credentials });
    await readStarted.promise;
    expect(await readProjectAccountRows({ credentials })).toMatchObject({ graphRevision: 5, workspaceRefs: [] });
    releaseRead.resolve();
    expect(await older).toMatchObject({ graphRevision: 5, workspaceRefs: [] });
    expect(getActiveProjectAccountRowsSnapshot()).toMatchObject({ graphRevision: 5, workspaceRefs: [],
      rows: expect.arrayContaining([{ key, revision: 4, payload: null }]) });
  });

  it('retains a newer refresh and reserved tombstones when a valid acknowledgement arrives from an older baseline', async () => {
    const post = boundary([]);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const forgottenKey = { ...key, id: 'forgotten-ref' };
    let wrote = false;
    post.mockImplementation(async (url, body) => {
      if (url.endsWith('/mutate')) {
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        wrote = true;
        writeStarted.resolve();
        await releaseWrite.promise;
        return { status: 200, data: { status: 'updated', cursor: 6,
          rows: request.mutations.map(mutation => ({ key: mutation.key, revision: 3, content: mutation.content })) } };
      }
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key, revision: wrote ? 4 : 2, content: { t: 'plain', v: { key, value: wrote ? { ...ref, label: 'Later edit' } : ref } } },
        { key: graphKey, revision: 3, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
        ...(wrote ? [{ key: forgottenKey, revision: 2, content: null }] : []),
      ] } };
    });
    const edit = createProjectAccountSnapshotMutation(credentials)(snapshot => ({ ...snapshot,
      workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'Earlier edit' })),
    }));
    await writeStarted.promise;
    await readProjectAccountRows({ credentials });
    releaseWrite.resolve();
    expect(await edit).toMatchObject({ status: 'applied', version: 3, snapshot: { workspaceRefs: [{ ...ref, label: 'Later edit' }] } });
    expect(getActiveProjectAccountRowsSnapshot()).toMatchObject({ graphRevision: 3, workspaceRefs: [{ ...ref, label: 'Later edit' }],
      rows: expect.arrayContaining([{ key: forgottenKey, revision: 2, payload: null }]) });
  });

  it('settles a committed ref/graph write from the bound row acknowledgement when subsequent reads are unavailable', async () => {
    const transport = boundary([]);
    const list = transport.getMockImplementation()!;
    let committed = false;
    transport.mockImplementation(async (url, body, config) => {
      if (committed && url.endsWith('/list')) throw new Error('read unavailable after acknowledged commit');
      const result = await list(url, body, config);
      if (url.endsWith('/mutate')) committed = true;
      return result;
    });
    await expect(createProjectAccountSnapshotMutation(credentials)(snapshot => ({ ...snapshot, workspaceRefs: [ref] })))
      .resolves.toMatchObject({ status: 'applied', version: 0, snapshot: { workspaceRefs: [ref], relationships: [] } });
  });
  it('refuses missing or unusable E2EE material even when the Account currently has no Project rows', async () => {
    const transport = boundary([]);
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
    await expect(readProjectAccountRows({ credentials })).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' });
    await expect(readProjectAccountRows({ credentials: { token: 'bad-key', encryption: { type: 'legacy', secret: new Uint8Array(31) } } }))
      .rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('treats a bound but invalid revision acknowledgement as indeterminate instead of committed success', async () => {
    const post = boundary([]);
    post.mockImplementation(async (url, body) => {
      if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } };
      const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
      return { status: 200, data: { status: 'updated', cursor: 1,
        rows: request.mutations.map(mutation => ({ key: mutation.key, revision: 99, content: mutation.content })) } };
    });
    expect(await createProjectAccountSnapshotMutation(credentials)(snapshot => ({ ...snapshot, workspaceRefs: [ref] })))
      .toEqual({ status: 'outcomeUnknown', lastKnownVersion: -1 });
  });
  it('writes only the selected context entry under caller revision and preserves Hide/pin while refusing a stale basis', async () => {
    const organizationKey = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'project-a' };
    const entry = (id: string) => PromptStackEntryV1Schema.parse({ id, ref: { kind: 'doc', artifactId: id } });
    const value = { hidden: true, pinned: true, promptStack: [entry('first'), entry('second')] };
    const transport = boundary([{ key: organizationKey, revision: 4, content: { t: 'plain', v: { key: organizationKey, value } } }]);
    const deps = { accountScope: () => ({ serverId: 'home-a', accountId: 'account-a' }),
      readArtifact: async () => { throw new Error('A budget edit must not load document content'); },
      mutateOrganization: (input: Parameters<ProjectContextActionOwnerDepsV1['mutateOrganization']>[0]) => mutateProjectAccountOrganization({ ...input, credentials }),
    };
    const input = ProjectContextUpdateInputV1Schema.parse({ target: { serverId: 'home-a', projectKey: 'project-a' },
      expectedRevision: 4, intent: { kind: 'set_budget', entryId: 'second', maxChars: 120 } });
    expect(await updatePersonalProjectContextV1(deps, input)).toEqual({ ok: true, revision: 5,
      row: { ...value, promptStack: [entry('first'), { ...entry('second'), maxChars: 120 }] } });
    const writes = transport.mock.calls.filter(([url]) => url.endsWith('/mutate'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toMatchObject({ topologyChange: false, expectedRefs: [], mutations: [{ key: organizationKey, expectedRevision: 4 }] });
    expect(await updatePersonalProjectContextV1(deps, input)).toEqual({ ok: false, errorCode: 'project_context_conflict', currentRevision: 5 });
    expect(transport.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(1);
    expect(await updatePersonalProjectContextV1(deps, { ...input, expectedRevision: 5 })).toMatchObject({ ok: true, revision: 5 });
    expect(transport.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(1);
  });
  it('uses keyless Plain rows and graph CAS for ref existence, while independent label edits leave the graph unchanged', async () => {
    const transport = boundary([]);
    const mutate = createProjectAccountSnapshotMutation(credentials);
    const inserted = await mutate(snapshot => ({ ...snapshot, workspaceRefs: [ref] }));
    expect(inserted.status).toBe('applied');
    const insert = transport.mock.calls.find(([url]) => url.endsWith('/mutate'))?.[1] as ProjectAccountRowMutationRequestV1;
    expect(insert).toEqual({ mutations: [
      { key, expectedRevision: 'absent', content: { t: 'plain', v: { key, value: ref } } },
      { key: graphKey, expectedRevision: 'absent', content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
    ], expectedRefs: [], topologyChange: true });
    transport.mockClear();
    await mutate(snapshot => ({ ...snapshot, workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'Renamed' })) }));
    const rename = transport.mock.calls.find(([url]) => url.endsWith('/mutate'))?.[1] as ProjectAccountRowMutationRequestV1;
    expect(rename.topologyChange).toBe(false);
    expect(rename.expectedRefs).toEqual([]);
    expect(rename.mutations).toHaveLength(1);
    expect(rename.mutations[0]?.key).toEqual(key);
    expect(transport.mock.calls.every(([url]) => !url.includes('/account/settings'))).toBe(true);
  });

  it('refuses E2EE ciphertext bound to another physical ref and mode mismatches instead of projecting empty state', async () => {
    const secret = new Uint8Array(32).fill(7);
    const c = sealAccountScopedBlobCiphertext({ kind: 'project_account_row', material: { type: 'legacy', secret },
      payload: { key: { ...key, id: 'ref-b' }, value: { ...ref, id: 'ref-b' } }, randomBytes: n => new Uint8Array(n).fill(3) });
    const post = boundary([{ key, revision: 0, content: { t: 'encrypted', c } }]);
    await expect(readProjectAccountRows({ credentials })).rejects.toMatchObject({ code: 'project_account_mode_mismatch' });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
    await expect(readProjectAccountRows({ credentials: { token: 't', encryption: { type: 'legacy', secret } } })).rejects.toMatchObject({ code: 'project_account_row_invalid' });
    expect(post.mock.calls.every(([url]) => url.endsWith('/list'))).toBe(true);
  });

  it('asserts only reached relationship endpoints and leaves unrelated label revisions independent', async () => {
    const target = { ...ref, id: 'ref-b', machineId: 'machine-b', rootPath: '/work/b' };
    const unrelated = { ...ref, id: 'ref-c', machineId: 'machine-c', rootPath: '/work/c' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'rel-ab', controllerMachineId: ref.machineId,
      alphaWorkspaceRefId: ref.id, betaWorkspaceRefId: target.id, mode: 'keep_both_in_sync' as const, enabled: true,
      createdAtMs: 1, updatedAtMs: 1, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } };
    const transport = boundary([...[ref, target, unrelated].map(value => {
      const rowKey = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      return { key: rowKey, revision: 2, content: { t: 'plain', v: { key: rowKey, value } } };
    }), { key: graphKey, revision: 3, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } }]);
    expect(await createProjectAccountSnapshotMutation(credentials)(snapshot => ({ ...snapshot,
      relationships: snapshot.relationships.map(value => ({ ...value, enabled: false, updatedAtMs: 2 })),
    }))).toMatchObject({ status: 'applied', version: 4 });
    const request = transport.mock.calls.find(([url]) => url.endsWith('/mutate'))?.[1] as ProjectAccountRowMutationRequestV1;
    expect(request.expectedRefs).toEqual([{ key, expectedRevision: 2 }, { key: { ...key, id: target.id }, expectedRevision: 2 }]);
    expect(request.mutations).toHaveLength(1);
  });

  it('returns a graph conflict without publishing or reporting partial ref success', async () => {
    const post = boundary([{ key, revision: 3, content: { t: 'plain', v: { key, value: ref } } },
      { key: graphKey, revision: 4, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } }]);
    post.mockImplementation(async (url) => url.endsWith('/list')
      ? { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
        { key, revision: 3, content: { t: 'plain', v: { key, value: ref } } },
        { key: graphKey, revision: 4, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } },
      ] } }
      : { status: 200, data: { status: 'conflict', key: graphKey, revision: 5 } });
    expect(await createProjectAccountSnapshotMutation(credentials)(snapshot => ({ ...snapshot, workspaceRefs: [] }))).toEqual({ status: 'conflict' });
  });
});
