import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowMutationRequestV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createProjectAccountSnapshotMutation, readProjectAccountRows, readProjectAccountRowsObservation, mutateProjectAccountOrganization,
  getActiveProjectAccountRowsSnapshot, subscribeActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { updatePersonalProjectContextV1, ProjectContextUpdateInputV1Schema, type ProjectContextActionOwnerDepsV1 } from '@happier-dev/protocol/projects/projectContextV1';
import { PromptStackEntryV1Schema } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createProjectWorkspaceRetirement } from './projectWorkspaceRetirement';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary as boundary } from './projectAccountRows.testkit';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { readWorkspaceSyncWorkerTargetSnapshot } from './sync/workspaceSyncPreparation';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { configuration } from '@/configuration';

// Prepare the real lazy Machine transport during collection; this fixture measures HTTP row work, not source transformation.
await import('@/api/api');

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

describe('Project snapshot refresh availability', () => {
  it('publishes requester mutation acknowledgements to the installed Account without a readback or foreign Account publication', async () => {
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref)];
    const post = boundary(rows);
    const serverId = configuration.activeServerId;
    const installed = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'installed-account' })).toString('base64url')}.signature`, encryption: null };
    const foreign = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'foreign-account' })).toString('base64url')}.signature`, encryption: null };
    await readProjectAccountRows({ credentials: installed, serverId, publication: 'installed' });
    const changes: unknown[] = [];
    const release = subscribeActiveProjectAccountRowsSnapshot((_previous, next) => changes.push(next));
    try {
      const mutate = (credentials: typeof installed, accountId: string, home = serverId) => createProjectAccountSnapshotMutation({ credentials,
        serverId: home, sessionCustody: { serverId: home, accountId, serverHttpBaseUrl: 'http://localhost:3005', isCurrent: async () => true } });
      post.mockClear();
      await mutate(installed, 'installed-account')(snapshot => ({ ...snapshot,
        workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'acknowledged' })) }));
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([{ ...ref, label: 'acknowledged' }]);
      expect(changes).toHaveLength(1);
      expect(post.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual(['list', 'mutate']);
      post.mockClear();
      await mutate(installed, 'installed-account')(snapshot => snapshot);
      expect(changes).toHaveLength(1);
      expect(post.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual(['list']);
      await mutate(foreign, 'foreign-account')(snapshot => ({ ...snapshot,
        workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'foreign' })) }));
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([{ ...ref, label: 'acknowledged' }]);
      expect(changes).toHaveLength(1);
      await mutate(installed, 'installed-account', 'another-home')(snapshot => ({ ...snapshot,
        workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'another-home' })) }));
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([{ ...ref, label: 'acknowledged' }]);
      expect(changes).toHaveLength(1);
      withdrawActiveProjectAccountRowsSnapshot();
      await mutate(installed, 'installed-account')(snapshot => ({ ...snapshot,
        workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'private' })) }));
      expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    } finally { release(); }
  });
  it('requires a finite reader to name its projection instead of silently opening the whole Account', async () => {
    const post = boundary([createPlainProjectAccountRefRow(ref)]);
    // Exercise an untyped/injected caller at the public owner, not a TypeScript-only contract.
    // @ts-expect-error Untyped callers must not silently request the full census.
    await expect(readProjectAccountRows({ credentials, serverId: ref.serverId }))
      .rejects.toMatchObject({ code: 'project_account_rows_selection_required' });
    expect(post).not.toHaveBeenCalled();
    // @ts-expect-error An empty selector is a census, not a finite projection.
    await expect(readProjectAccountRows({ credentials, serverId: ref.serverId, selection: {} }))
      .rejects.toMatchObject({ code: 'project_account_rows_selection_required' });
    expect(post).not.toHaveBeenCalled();
  });
  it('requires a finite reader to retain its selected observation currentness across installed changes', async () => {
    const organizationKey = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: 'unrelated' };
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref), { key: organizationKey, revision: 0,
      content: { t: 'plain', v: { key: organizationKey, value: {} } } }];
    boundary(rows);
    const installed = { credentials, serverId: ref.serverId, publication: 'installed' as const };
    await readProjectAccountRows(installed);
    const observation = await readProjectAccountRowsObservation({ credentials, serverId: ref.serverId,
      selection: { kinds: ['workspace-ref'], serverId: ref.serverId } });
    expect(await observation.isCurrent()).toBe(true);
    rows[1] = { key: organizationKey, revision: 1,
      content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } };
    await readProjectAccountRows({ ...installed, changedKeys: [organizationKey] });
    expect(await observation.isCurrent()).toBe(true);
    rows[0] = createPlainProjectAccountRefRow({ ...ref, rootPath: '/fresh-change' }, 1);
    await readProjectAccountRows({ ...installed, changedKeys: [key] });
    expect(await observation.isCurrent()).toBe(false);
  });
  it.each([
    { event: 'changed', read: readProjectAccountRowsObservation, reader: 'observation' },
    { event: 'withdrawn', read: readProjectAccountRowsObservation, reader: 'observation' },
    { event: 'changed', read: readProjectAccountRows, reader: 'raw' },
    { event: 'withdrawn', read: readProjectAccountRows, reader: 'raw' },
  ] as const)('refuses a selected $reader when installed facts are $event during HTTP', async ({ event, read }) => {
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref)];
    const post = boundary(rows);
    const installed = { credentials, serverId: ref.serverId, publication: 'installed' as const };
    await readProjectAccountRows(installed);
    const readStarted = deferred();
    const releaseRead = deferred();
    const serve = post.getMockImplementation()!;
    let hold = true;
    post.mockImplementation(async (...args) => {
      const response = await serve(...args);
      if (hold) { hold = false; readStarted.resolve(); await releaseRead.promise; }
      return response;
    });
    const pending = read({ credentials, serverId: ref.serverId,
      selection: { kinds: ['workspace-ref'], serverId: ref.serverId } });
    await readStarted.promise;
    if (event === 'changed') {
      rows[0] = createPlainProjectAccountRefRow({ ...ref, rootPath: '/changed-during-read' }, 1);
      await readProjectAccountRows({ ...installed, changedKeys: [key] });
    } else withdrawActiveProjectAccountRowsSnapshot();
    releaseRead.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'project_account_rows_changed' });
    if (event === 'changed') expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs)
      .toEqual([{ ...ref, rootPath: '/changed-during-read' }]);
    else expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
  });
  it('keeps its own complete selected topology publication current without reopening organizations', async () => {
    const organizationKey = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: 'unrelated' };
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref), { key: organizationKey, revision: 0,
      content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } }];
    const post = boundary(rows);
    const installed = { credentials, serverId: ref.serverId, publication: 'installed' as const };
    const baseline = await readProjectAccountRows(installed);
    rows[0] = createPlainProjectAccountRefRow({ ...ref, rootPath: '/fresh-own-publication' }, 1);
    post.mockClear();
    const observation = await readProjectAccountRowsObservation({ ...installed,
      selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
    expect(observation.snapshot.workspaceRefs).toEqual([{ ...ref, rootPath: '/fresh-own-publication' }]);
    expect(await observation.isCurrent()).toBe(true);
    expect(getActiveProjectAccountRowsSnapshot()?.organizations).toEqual(baseline.organizations);
    expect(post.mock.calls.map(([, body]) => body)).toEqual([{ kinds: ['workspace-ref', 'relationship-graph'] }]);
  });
  it('requires a finite reader to leave installed graph publication to the complete topology owner', async () => {
    const other = { ...ref, id: 'ref-b', rootPath: '/work/b' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'sync', controllerMachineId: ref.machineId,
      alphaWorkspaceRefId: ref.id, betaWorkspaceRefId: other.id, mode: 'keep_both_in_sync' as const, enabled: false,
      createdAtMs: 1, updatedAtMs: 1, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } };
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref), createPlainProjectAccountRefRow(other),
      { key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } }];
    const post = boundary(rows);
    const installed = { credentials, serverId: ref.serverId, publication: 'installed' as const };
    const before = await readProjectAccountRows(installed);
    rows[0] = { key, revision: 1, content: null };
    rows[2] = { key: graphKey, revision: 1, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } };
    post.mockClear();
    const selected = await readProjectAccountRows({ credentials, serverId: ref.serverId,
      selection: { kinds: ['workspace-ref'] } });
    expect(selected.workspaceRefs).toEqual([other]);
    expect(getActiveProjectAccountRowsSnapshot()).toBe(before);
    expect(post.mock.calls.map(([, body]) => body)).toEqual([{ kinds: ['workspace-ref'] }]);
    const updates: unknown[] = [];
    const stop = subscribeActiveProjectAccountRowsSnapshot((_previous, next) => updates.push(next));
    try {
      const next = await readProjectAccountRows({ ...installed, changedKeys: [key, graphKey] });
      expect(next.workspaceRefs).toEqual([other]);
      expect(next.relationships).toEqual([]);
      expect(updates).toEqual([next]);
    } finally { stop(); }
  });
  it('mutates complete topology without opening 1,024 unrelated organizations', async () => {
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref), ...Array.from({ length: 1024 }, (_, index) => {
      const key = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: `unrelated-${index}` };
      return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
    })];
    const post = boundary(rows);
    const mutate = createProjectAccountSnapshotMutation({ credentials, serverId: ref.serverId });
    const result = await mutate(snapshot => ({ ...snapshot,
      workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'fresh label' })) }));
    expect(result).toMatchObject({ status: 'applied', snapshot: { workspaceRefs: [{ ...ref, label: 'fresh label' }] } });
    expect(post.mock.calls.filter(([url]) => url.endsWith('/list')).map(([, body]) => body))
      .toEqual([{ kinds: ['workspace-ref', 'relationship-graph'] }]);
  });
  it('opens only the demanded topology domain and accepts a ref/graph removal atomically against admitted rows', async () => {
    const other = { ...ref, id: 'ref-b', rootPath: '/work/b' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'sync', controllerMachineId: ref.machineId,
      alphaWorkspaceRefId: ref.id, betaWorkspaceRefId: other.id, mode: 'keep_both_in_sync' as const, enabled: false,
      createdAtMs: 1, updatedAtMs: 1, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } };
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref), createPlainProjectAccountRefRow(other),
      { key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } },
      ...Array.from({ length: 1024 }, (_, index) => {
        const key = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: `unrelated-${index}` };
        return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
      })];
    const post = boundary(rows);
    const input = { credentials, serverId: ref.serverId, publication: 'installed' as const };
    const initial = await readProjectAccountRows(input);
    rows[0] = { key, revision: 1, content: null };
    rows[2] = { key: graphKey, revision: 1, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } };
    post.mockClear();
    const published: unknown[] = [];
    const stop = subscribeActiveProjectAccountRowsSnapshot((_previous, next) => published.push(next));
    try {
      // The endpoint hint can be on the following durable feed page.
      const changed = { ...input, changedKeys: [graphKey, graphKey] };
      const next = await readProjectAccountRows(changed);
      expect(next.workspaceRefs).toEqual([other]);
      expect(next.relationships).toEqual([]);
      expect(next.organizations).toEqual(initial.organizations);
      expect(published).toEqual([next]);
      expect(post.mock.calls.map(([url, body]) => [new URL(url).pathname, body])).toEqual([
        ['/v1/account/project-rows/list', { kinds: ['workspace-ref', 'relationship-graph'] }],
      ]);
    } finally { stop(); }
  });
  it('opens one changed organization without rereading topology or 1,024 unrelated organizations', async () => {
    const organizationKey = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: 'changed' };
    const organization = (revision: number, pinned: boolean) => ({ key: organizationKey, revision,
      content: { t: 'plain' as const, v: { key: organizationKey, value: { pinned } } } });
    const rows: unknown[] = [organization(0, false), createPlainProjectAccountRefRow(ref),
      ...Array.from({ length: 1024 }, (_, index) => {
        const key = { ...organizationKey, projectKey: `unrelated-${index}` };
        return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
      })];
    const post = boundary(rows);
    const input = { credentials, serverId: ref.serverId, publication: 'installed' as const };
    const initial = await readProjectAccountRows(input);
    let unrelatedPayloadReads = 0;
    for (const row of initial.rows) {
      if (row.key.kind !== 'project-organization' || row.key.projectKey === organizationKey.projectKey) continue;
      const payload = row.payload;
      // Observe already-admitted bodies without replacing any projection logic.
      Object.defineProperty(row, 'payload', { configurable: true, enumerable: true,
        get: () => { unrelatedPayloadReads++; return payload; } });
    }
    rows[0] = organization(1, true);
    post.mockClear();
    const next = await readProjectAccountRows({ ...input, changedKeys: [organizationKey, organizationKey] });
    expect(unrelatedPayloadReads).toBe(0);
    expect(next.organizations.filter((row, index) => row !== initial.organizations[index])).toHaveLength(1);
    expect(next.workspaceRefs).toBe(initial.workspaceRefs);
    expect(next.relationships).toBe(initial.relationships);
    expect(next.workspaceRefs).toEqual([ref]);
    expect(next.organizations.find(row => row.key.projectKey === organizationKey.projectKey)).toMatchObject({ revision: 1, value: { pinned: true } });
    expect(post.mock.calls.map(([url, body]) => [new URL(url).pathname, body])).toEqual([
      ['/v1/account/project-rows/read', { key: organizationKey }],
    ]);
  });
  it.each(['cancelled', 'retired'] as const)('accepts no incremental reply after its authority is %s', async reason => {
    const rows: unknown[] = [createPlainProjectAccountRefRow(ref)];
    const post = boundary(rows);
    const input = { credentials, serverId: ref.serverId, publication: 'installed' as const };
    await readProjectAccountRows(input);
    rows[0] = createPlainProjectAccountRefRow({ ...ref, rootPath: '/late' }, 1);
    const controller = new AbortController();
    let current = true;
    const serve = post.getMockImplementation()!;
    post.mockImplementation(async (...args) => {
      expect(args[2]?.signal).toBe(controller.signal);
      const response = await serve(...args);
      if (reason === 'cancelled') controller.abort(); else current = false;
      return response;
    });
    await expect(readProjectAccountRows({ ...input, changedKeys: [key], signal: controller.signal,
      assertCurrentAuthority: async () => { if (!current) throw new Error('retired'); } })).rejects.toBeDefined();
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs.some(value => value.rootPath === '/late') ?? false).toBe(false);
  });
  it('publishes no unchanged row census to its consumers and retains immutable rows across a real change', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => createPlainProjectAccountRefRow({ ...ref,
      id: `ref-${index}`, rootPath: `/work/${index}` }));
    boundary(rows);
    const input = { credentials, serverId: 'home-a', publication: 'installed' as const };
    const accepted = await readProjectAccountRows(input);
    let publications = 0;
    const releases = Array.from({ length: 8 }, () => subscribeActiveProjectAccountRowsSnapshot(() => publications++));
    try {
      // Response ordering and fresh HTTP objects are not a Project change.
      rows.reverse();
      for (let refresh = 0; refresh < 3; refresh++) {
        expect(await readProjectAccountRows(input)).toBe(accepted);
      }
      expect(publications).toBe(0);
      const changed = rows[0];
      if (changed.key.kind !== 'workspace-ref') throw new Error('Expected workspace fixture');
      const changedId = changed.key.id;
      rows[0] = createPlainProjectAccountRefRow({ ...ref, id: changedId, rootPath: '/work/moved' }, 1);
      const next = await readProjectAccountRows(input);
      expect(publications).toBe(8);
      expect(next.workspaceRefs.find(value => value.id === changedId)?.rootPath).toBe('/work/moved');
      expect(next.rows.filter(row => row.key.kind !== 'workspace-ref' || row.key.id !== changedId)
        .every(row => accepted.rows.includes(row))).toBe(true);
      expect(await readProjectAccountRows(input)).toBe(next);
      expect(publications).toBe(8);
      withdrawActiveProjectAccountRowsSnapshot();
      expect(publications).toBe(16);
      // Repeated withdrawal is not a new unavailability transition.
      withdrawActiveProjectAccountRowsSnapshot();
      expect(publications).toBe(16);
    } finally { for (const release of releases) release(); }
  });

  it('asks only for the complete Home ref/graph domain during Sync target preparation', async () => {
    const rows = [{ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } },
      ...Array.from({ length: 1024 }, (_, index) => {
        const key = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: `other-${index}` };
        return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
      })];
    const post = boundary(rows);
    vi.mocked(axios.get).mockImplementation(async url => url.endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : { status: 200, data: { machine: { id: ref.machineId, active: true, installationId: 'installation-a',
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
        metadata: encodePlainMachineStoredContent({ host: 'test', platform: 'linux', homeDir: '/home/test',
          username: 'test', happyCliVersion: 'test', happyHomeDir: '/home/test/.happier' }) } } });
    let loadedRows = 0;
    post.mockImplementation(async (_url, body) => {
      const filter = body as { kinds?: string[]; serverId?: string };
      const selected = rows.filter(row => (!filter.kinds || filter.kinds.includes(row.key.kind))
        && (!filter.serverId || row.key.serverId === filter.serverId));
      loadedRows += selected.length;
      return { status: 200, data: { status: 'listed', rows: selected, coverage: 'complete' } };
    });
    const result = await readWorkspaceSyncWorkerTargetSnapshot({ credentials, serverId: ref.serverId,
      serverHttpBaseUrl: 'https://home.example', sourceWorkspaceRefId: ref.id, targetMachineId: ref.machineId });
    expect(loadedRows).toBe(1);
    expect(result.workspaceRefs).toEqual([ref]);
    expect(result.organizations).toEqual([]);
    expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
  });

  it('reads one organization row without opening a 1,024-row Account census', async () => {
    const organizationKey = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'project-a' };
    const post = boundary([{ key: organizationKey, revision: 2,
      content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } }, ...Array.from({ length: 1023 }, (_, index) => {
      const key = { ...organizationKey, projectKey: `unrelated-${index}` };
      return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
    })]);
    const transport = post.getMockImplementation()!;
    let loadedRows = 0;
    post.mockImplementation(async (...args) => {
      if (args[0].endsWith('/read')) {
        loadedRows += 1;
        return { status: 200, data: { status: 'present', row: { key: organizationKey, revision: 2,
          content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } } } };
      }
      if (args[0].endsWith('/list')) loadedRows += 1024;
      return await transport(...args);
    });
    const result = await mutateProjectAccountOrganization({ credentials, serverId: 'home-a', projectKey: 'project-a',
      mutate: value => ({ ...value, hidden: true }) });
    expect.soft(loadedRows).toBe(1);
    expect(result).toMatchObject({ status: 'updated', value: { pinned: true, hidden: true } });
    expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
  });

  it.each(['account-mode-mismatch', 'mode authentication', 'row authentication', 'invalid content'] as const)(
    'withdraws the installed projection when an exact organization observation refuses %s', async failure => {
      const organizationKey = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'project-a' };
      const row = { key: organizationKey, revision: 2,
        content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } };
      const post = boundary([row]);
      const input = { credentials, serverId: 'home-a' };
      await readProjectAccountRows({ ...input, publication: 'installed' });
      expect(getActiveProjectAccountRowsSnapshot()?.organizations).toHaveLength(1);
      post.mockClear();
      if (failure === 'mode authentication') vi.mocked(axios.get).mockResolvedValueOnce({ status: 401, data: { error: 'unauthorized' } });
      else post.mockResolvedValueOnce(failure === 'row authentication'
        ? { status: 403, data: { error: 'access_denied' } }
        : failure === 'invalid content'
          ? { status: 200, data: { status: 'present', row: { ...row, content: { t: 'encrypted', c: 'invalid' } } } }
          : { status: 200, data: { status: 'account-mode-mismatch' } });
      const mutate = vi.fn<Parameters<typeof mutateProjectAccountOrganization>[0]['mutate']>(value => value);
      const code = failure === 'mode authentication' ? 'project_account_mode_unavailable'
        : failure === 'row authentication' ? 'project_account_rows_unavailable'
          : failure === 'invalid content' ? 'project_account_mode_mismatch' : 'project_account_rows_account-mode-mismatch';
      await expect(mutateProjectAccountOrganization({ ...input, projectKey: 'project-a', mutate })).rejects.toMatchObject({ code });
      expect(mutate).not.toHaveBeenCalled();
      expect(post.mock.calls.map(([url]) => url.slice(url.lastIndexOf('/') + 1)))
        .toEqual(failure === 'mode authentication' ? [] : ['read']);
      expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    });

  it.each(['network', 'row throttling'] as const)('retains the installed projection after exact organization %s failure and accepts recovery', async failure => {
    const organizationKey = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'project-a' };
    const post = boundary([{ key: organizationKey, revision: 2,
      content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } }]);
    const input = { credentials, serverId: 'home-a', projectKey: 'project-a' };
    const accepted = await readProjectAccountRows({ credentials, serverId: input.serverId, publication: 'installed' });
    if (failure === 'network') post.mockRejectedValueOnce(new axios.AxiosError('Connection reset', 'ECONNRESET'));
    else post.mockResolvedValueOnce({ status: 429, data: { error: 'throttled' } });
    const error: unknown = await mutateProjectAccountOrganization({ ...input, mutate: value => ({ ...value, hidden: true }) })
      .catch((failure: unknown) => failure);
    expect(classifyServerEndpointError(error)).toMatchObject({ retryable: true });
    expect(getActiveProjectAccountRowsSnapshot()).toBe(accepted);
    expect(await mutateProjectAccountOrganization({ ...input, expectedRevision: 2, mutate: value => ({ ...value, hidden: true }) }))
      .toMatchObject({ status: 'updated', revision: 3, value: { pinned: true, hidden: true } });
    expect(getActiveProjectAccountRowsSnapshot()?.organizations).toMatchObject([
      { key: organizationKey, revision: 3, value: { pinned: true, hidden: true } },
    ]);
  });

  it('keeps another Account scope installed when an exact organization read hard-refuses', async () => {
    const organizationKey = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'project-a' };
    const post = boundary([{ key: organizationKey, revision: 2,
      content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } }]);
    const accepted = await readProjectAccountRows({ credentials, serverId: 'home-a', publication: 'installed' });
    post.mockResolvedValueOnce({ status: 200, data: { status: 'account-mode-mismatch' } });
    await expect(mutateProjectAccountOrganization({ credentials: { token: 'other-account-token', encryption: null },
      serverId: 'home-a', projectKey: 'project-a', mutate: value => value })).rejects.toMatchObject({ code: 'project_account_rows_account-mode-mismatch' });
    expect(getActiveProjectAccountRowsSnapshot()).toBe(accepted);
  });

  it.each([[403, false], [429, true]] as const)('preserves HTTP %s read disposition and retains rows only for retryable failures', async (status, retryable) => {
    const post = boundary([{ key, revision: 1, content: { t: 'plain', v: { key, value: ref } } }]);
    const input = { credentials, serverId: 'home-a', publication: 'installed' as const };
    const accepted = await readProjectAccountRows(input);
    post.mockResolvedValueOnce({ status, data: { error: 'PRIVATE_RESPONSE' } });
    const error: unknown = await readProjectAccountRows(input).catch((failure: unknown) => failure);
    expect(classifyServerEndpointError(error)).toMatchObject({ statusCode: status, retryable });
    expect(getActiveProjectAccountRowsSnapshot()).toBe(retryable ? accepted : null);
    expect(String(error)).not.toContain('PRIVATE_RESPONSE');
  });

  it('keeps cold failures unavailable and withdraws accepted rows on authentication failure', async () => {
    const post = boundary([{ key, revision: 1, content: { t: 'plain', v: { key, value: ref } } }]);
    const input = { credentials, serverId: 'home-a', publication: 'installed' as const };
    post.mockResolvedValueOnce({ status: 503, data: { error: 'internal' } });
    await expect(readProjectAccountRows(input)).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
    expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    await readProjectAccountRows(input);
    vi.mocked(axios.get).mockResolvedValueOnce({ status: 401, data: { error: 'unauthorized' } });
    await expect(readProjectAccountRows(input)).rejects.toMatchObject({ code: 'project_account_mode_unavailable' });
    expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
  });

  it.each(['network', 'rows 500', 'mode 500'] as const)('retains the last accepted same-scope rows after %s and accepts recovery', async failure => {
    const rows = [{ key, revision: 1, content: { t: 'plain', v: { key, value: ref } } }];
    const post = boundary(rows);
    const input = { credentials, serverId: 'home-a', publication: 'installed' as const };
    const accepted = await readProjectAccountRows(input);
    if (failure === 'network') post.mockRejectedValueOnce(new axios.AxiosError('Connection reset', 'ECONNRESET'));
    if (failure === 'rows 500') post.mockResolvedValueOnce({ status: 500, data: { error: 'internal' } });
    if (failure === 'mode 500') vi.mocked(axios.get).mockResolvedValueOnce({ status: 500, data: { error: 'internal' } });
    await expect(readProjectAccountRows(input)).rejects.toBeDefined();
    expect(getActiveProjectAccountRowsSnapshot()).toBe(accepted);
    rows[0] = { key, revision: 2, content: { t: 'plain', v: { key, value: { ...ref, rootPath: '/work/recovered' } } } };
    expect((await readProjectAccountRows(input)).workspaceRefs).toEqual([{ ...ref, rootPath: '/work/recovered' }]);
    // Invalid mode/content evidence still withdraws access; a retained snapshot
    // must never turn a security failure into a successful stored-data read.
    post.mockResolvedValueOnce({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key, revision: 3, content: { t: 'encrypted', c: 'invalid' } },
    ] } });
    await expect(readProjectAccountRows(input)).rejects.toMatchObject({ code: 'project_account_mode_mismatch' });
    expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
  });
});

describe('Project checkout retirement', () => {
  const createOwner = () => createProjectWorkspaceRetirement({ authority: { credentials, serverId: ref.serverId, publication: 'installed' },
    serverId: ref.serverId, machineId: ref.machineId, assertCurrentAuthority: async () => {} });
  const row = (value: WorkspaceRefV1 = ref, revision = 2) => {
    const rowKey = { ...key, serverId: value.serverId, id: value.id };
    return { key: rowKey, revision, content: { t: 'plain', v: { key: rowKey, value } } };
  };
  it('prepares a fresh retirement from topology only, without opening unrelated organization bodies', async () => {
    const post = boundary([row(), ...Array.from({ length: 1024 }, (_, index) => {
      const key = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: `unrelated-${index}` };
      return { key, revision: 0, content: { t: 'plain', v: { key, value: {} } } };
    })]);
    const prepared = await createOwner().prepare({ rootPath: ref.rootPath });
    await createOwner().assertCurrent(prepared.ownerData);
    expect(post.mock.calls.map(([url, body]) => [new URL(url).pathname, body])).toEqual([
      ['/v1/account/project-rows/list', { kinds: ['workspace-ref', 'relationship-graph'] }],
      ['/v1/account/project-rows/list', { kinds: ['workspace-ref', 'relationship-graph'] }],
    ]);
  });
  it('retires the reviewed main and dependent refs together and exactly restores their identities through Undo', async () => {
    const dependent = { ...ref, id: 'external-worktree', rootPath: '/other/branch', projectKey: 'retained-project' };
    const nested = { ...ref, id: 'nested-project', rootPath: '/work/a/nested' };
    const unrelated = { ...ref, id: 'unrelated', rootPath: '/work/a2' };
    const ancestor = { ...ref, id: 'ancestor', rootPath: '/work' };
    const foreignMachine = { ...ref, id: 'other-machine', machineId: 'machine-b' };
    const independent = { ...ref, id: 'independent-repository', rootPath: `${dependent.rootPath}/nested` };
    const organizationKey = { kind: 'project-organization' as const, serverId: ref.serverId, projectKey: 'retained-project' };
    const rows = [row(), row(dependent), row(nested), row(unrelated), row(ancestor), row(foreignMachine), row(independent),
      { key: organizationKey, revision: 3, content: { t: 'plain', v: { key: organizationKey, value: { pinned: true } } } }];
    boundary(rows);
    const owner = createOwner();
    const prepared = await owner.prepare({ rootPath: ref.rootPath, dependentWorktreePaths: [dependent.rootPath] });
    // The real producer must survive the existing JSON-only Trash owner-data boundary.
    const retained = JSON.parse(JSON.stringify(prepared.ownerData));
    await owner.assertCurrent(retained);
    await owner.retire(retained);
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([unrelated, ancestor, foreignMachine, independent]);
    expect((await readProjectAccountRows({ credentials, serverId: ref.serverId, selection: { kinds: ['workspace-ref'] } })).workspaceRefs).toEqual([unrelated, ancestor, foreignMachine, independent]);
    await owner.retire(retained);
    await owner.reinstate(retained, ref.rootPath);
    await owner.reinstate(retained, ref.rootPath);
    const restored = await readProjectAccountRows({ credentials, serverId: ref.serverId, selection: { kinds: ['workspace-ref', 'project-organization'] } });
    expect(restored.workspaceRefs).toEqual([ref, dependent, nested, unrelated, ancestor, foreignMachine, independent]);
    expect(restored.organizations).toMatchObject([{ key: organizationKey, revision: 3, value: { pinned: true } }]);
  });
  it('rejects reviewed state changes and never overwrites a ref recreated after retirement', async () => {
    const rows = [row()];
    const post = boundary(rows);
    const owner = createOwner();
    const prepared = await owner.prepare({ rootPath: ref.rootPath });
    rows[0] = row({ ...ref, label: 'Changed' }, 3);
    await expect(owner.assertCurrent(prepared.ownerData)).rejects.toMatchObject({ code: 'changed_since_review' });
    await expect(owner.retire(prepared.ownerData)).rejects.toMatchObject({ code: 'changed_since_review' });
    expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(0);
    const latest = await owner.prepare({ rootPath: ref.rootPath });
    await owner.retire(latest.ownerData);
    rows[0] = row({ ...ref, label: 'Recreated' }, 5);
    await expect(owner.reinstate(latest.ownerData, ref.rootPath)).rejects.toMatchObject({ code: 'changed_since_review' });
    expect((await readProjectAccountRows({ credentials, serverId: ref.serverId, selection: { kinds: ['workspace-ref'] } })).workspaceRefs).toEqual([{ ...ref, label: 'Recreated' }]);
  });
  it('blocks even a paused Sync endpoint before checkout retirement is prepared', async () => {
    const other = { ...ref, id: 'ref-b', rootPath: '/work/b' };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'paused-sync', controllerMachineId: ref.machineId,
      alphaWorkspaceRefId: ref.id, betaWorkspaceRefId: other.id, mode: 'keep_both_in_sync' as const, enabled: false,
      createdAtMs: 1, updatedAtMs: 1, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } };
    const post = boundary([row(), row(other), { key: graphKey, revision: 2,
      content: { t: 'plain', v: { key: graphKey, value: { relationships: [relationship] } } } }]);
    await expect(createOwner().prepare({ rootPath: ref.rootPath })).rejects.toMatchObject({
      code: 'workspace_ref_in_use', relationshipIds: ['paused-sync'],
    });
    expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(0);
  });
  it('settles lost retirement and Undo replies from the exact retained rows without repeating their writes', async () => {
    const rows: unknown[] = [row()];
    const post = boundary(rows);
    const transport = post.getMockImplementation()!;
    let loseReply = true;
    post.mockImplementation(async (...args) => {
      const result = await transport(...args);
      if (args[0].endsWith('/mutate') && loseReply) {
        loseReply = false;
        throw new Error('Account reply unavailable after commit');
      }
      return result;
    });
    // The installed startup owner, not finite retirement preparation, establishes
    // the projection whose acknowledged/recovered changes this test observes.
    await readProjectAccountRows({ credentials, serverId: ref.serverId, publication: 'installed' });
    const owner = createOwner();
    const prepared = await owner.prepare({ rootPath: ref.rootPath });
    await expect(owner.retire(prepared.ownerData)).rejects.toMatchObject({ code: 'project_account_row_outcome_unknown' });
    await owner.retire(prepared.ownerData);
    expect(rows[0]).toMatchObject({ revision: 3, content: null });
    loseReply = true;
    await expect(owner.reinstate(prepared.ownerData, ref.rootPath)).rejects.toMatchObject({ code: 'project_account_row_outcome_unknown' });
    await owner.reinstate(prepared.ownerData, ref.rootPath);
    expect(rows[0]).toEqual(row(ref, 4));
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([ref]);
  });
  it('guards the complete ref census with graph CAS and refuses a changed restoration path', async () => {
    const rows: unknown[] = [row()];
    const post = boundary(rows, { beforeMutation: request => {
      const graph = request.mutations.find(mutation => mutation.key.kind === 'relationship-graph');
      if (graph) rows.push({ key: graphKey, revision: 0, content: { t: 'plain', v: { key: graphKey, value: { relationships: [] } } } });
      rows.push(row({ ...ref, id: 'new-checkout', rootPath: `${ref.rootPath}/new` }));
    } });
    const owner = createOwner();
    const prepared = await owner.prepare({ rootPath: ref.rootPath });
    await expect(owner.retire(prepared.ownerData)).rejects.toMatchObject({ code: 'changed_since_review' });
    expect(rows[0]).toEqual(row());
    await expect(owner.reinstate(prepared.ownerData, `${ref.rootPath} (restored)`)).rejects.toMatchObject({ code: 'restore_path_unsupported' });
    expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(1);
  });
  it('retires Windows roots through canonical mixed-separator equality without collecting sibling prefixes', async () => {
    const main = { ...ref, rootPath: 'C:\\Users\\alice\\project' };
    const nested = { ...ref, id: 'windows-child', rootPath: 'C:/Users/alice/project/nested' };
    const sibling = { ...ref, id: 'windows-sibling', rootPath: 'C:\\Users\\alice\\project2' };
    boundary([row(main), row(nested), row(sibling)]);
    const owner = createOwner();
    const prepared = await owner.prepare({ rootPath: main.rootPath });
    await owner.retire(prepared.ownerData);
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([sibling]);
    await owner.reinstate(prepared.ownerData, 'C:/Users/alice/project');
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([main, nested, sibling]);
  });
  it('restores a renamed payload without changing refs when its retirement write never committed', async () => {
    const rows: unknown[] = [row()];
    boundary(rows);
    const owner = createOwner();
    const prepared = await owner.prepare({ rootPath: ref.rootPath });
    await owner.reinstate(prepared.ownerData, ref.rootPath);
    expect(rows).toEqual([row()]);
  });
  it('rechecks captured machine custody after an awaited mode read before opening a row mutation', async () => {
    const rows: unknown[] = [row()];
    boundary(rows);
    let current = true;
    const owner = createProjectWorkspaceRetirement({ authority: { credentials, serverId: ref.serverId },
      serverId: ref.serverId, machineId: ref.machineId, assertCurrentAuthority: async () => {
        if (!current) throw Object.assign(new Error('machine_target_unavailable'), { code: 'machine_target_unavailable' });
      } });
    const prepared = await owner.prepare({ rootPath: ref.rootPath });
    let reads = 0;
    vi.mocked(axios.get).mockImplementation(async () => {
      if (++reads === 2) current = false;
      return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    });
    await expect(owner.retire(prepared.ownerData)).rejects.toMatchObject({ code: 'machine_target_unavailable' });
    expect(rows).toEqual([row()]);
  });
});
describe('Project Account row transport', () => {
  it.each(['empty', 'foreign'] as const)('keeps a private observation current without publishing over an %s installed scope', async installedScope => {
    boundary([]);
    if (installedScope === 'foreign') await readProjectAccountRows({ credentials, serverId: 'home-a', publication: 'installed' });
    const installed = getActiveProjectAccountRowsSnapshot();
    let current = true;
    const observation = await readProjectAccountRowsObservation({
      credentials: { token: 'private-requester', encryption: null }, serverId: 'home-a',
      selection: { kinds: ['workspace-ref', 'relationship-graph'] },
      assertCurrentAuthority: async () => { if (!current) throw new Error('Requester retired'); },
    });
    expect(await observation.isCurrent()).toBe(true);
    expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
    current = false;
    expect(await observation.isCurrent()).toBe(false);
    expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
  });

  it('keeps published observations across equivalent reprojected topology but refuses changed or withdrawn topology', async () => {
    const rows: unknown[] = [];
    boundary(rows);
    const input = { credentials, serverId: 'home-a', publication: 'installed' as const };
    const observation = await readProjectAccountRowsObservation(input);
    await readProjectAccountRows(input);
    expect(await observation.isCurrent()).toBe(true);
    rows.push({ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } });
    await readProjectAccountRows(input);
    expect(await observation.isCurrent()).toBe(false);
    const latest = await readProjectAccountRowsObservation(input);
    withdrawActiveProjectAccountRowsSnapshot();
    expect(await latest.isCurrent()).toBe(false);
  });

  it('keeps unbound and foreign credential reads private, including failures and acknowledged mutations', async () => {
    const rows: unknown[] = [];
    const post = boundary(rows);
    const requester = { credentials: { token: 'different-requester', encryption: null }, serverId: 'home-a' };
    const installed = await readProjectAccountRows({ credentials, serverId: 'home-a', publication: 'installed' });
    let publications = 0;
    const release = subscribeActiveProjectAccountRowsSnapshot(() => publications++);
    try {
      const privateSnapshot = await readProjectAccountRows({ ...requester, selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
      expect(privateSnapshot.scopeKey).not.toBe(installed.scopeKey);
      expect(await createProjectAccountSnapshotMutation(requester)(snapshot => ({ ...snapshot, workspaceRefs: [ref] })))
        .toMatchObject({ status: 'applied', snapshot: { workspaceRefs: [ref] } });
      expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
      post.mockRejectedValueOnce(new Error('Requester Home unavailable'));
      await expect(readProjectAccountRows({ ...requester, selection: { kinds: ['workspace-ref', 'relationship-graph'] } })).rejects.toThrow('Requester Home unavailable');
      expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
      await readProjectAccountRows({ credentials, serverId: 'home-a', selection: { kinds: ['workspace-ref', 'relationship-graph'] },
        sessionCustody: { serverId: 'home-a', accountId: 'installed-account', serverHttpBaseUrl: 'https://installed-home.invalid',
          isCurrent: async () => true } });
      expect(getActiveProjectAccountRowsSnapshot()).toBe(installed);
      expect(publications).toBe(0);
      // An ordinary installed refresh still publishes and can recover after withdrawal.
      await readProjectAccountRows({ credentials, serverId: 'home-a', publication: 'installed' });
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([ref]);
      expect(publications).toBe(1);
      withdrawActiveProjectAccountRowsSnapshot();
      await readProjectAccountRows({ credentials, serverId: 'home-a', publication: 'installed' });
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([ref]);
      withdrawActiveProjectAccountRowsSnapshot();
      await readProjectAccountRows({ ...requester, selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
      expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
    } finally { release(); }
  });
  it('uses admitted requester HTTP and cipher ports for private row acceptance without replacing the daemon snapshot', async () => {
    boundary([]);
    const daemonSnapshot = await readProjectAccountRows({ credentials, publication: 'installed' });
    const cipher = createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
      randomBytes: n => new Uint8Array(n).fill(2) });
    let current = true;
    const requests: unknown[] = [];
    // The host has already proved this carrier; the network/signing boundary supplies HTTP headers.
    const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1, token: 'admitted-account-authorization', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
        serverIdentityId: 'home-identity', machineId: 'machine-a', custodianAccountId: 'bob', installationId: 'installation-a',
        actionId: 'projects.open', requestId: 'project-open-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'machine-a' }, accountEncryptionMode: 'e2ee',
      },
    }), requesterAccountProjection: { accountId: 'bob', serverId: 'home-a', accountEncryptionMode: 'e2ee',
      projectAccountRowCipher: cipher, isCurrent: async () => current, readArtifact: async () => null },
      requesterHttpProjection: { accountId: 'bob', serverId: 'home-a', serverIdentityId: 'home-identity', serverHttpBaseUrl: 'https://bob-home.example',
        accountEncryptionMode: 'e2ee', isCurrent: async () => current,
        createRequestHeaders: async (request: unknown) => { requests.push(request); return current ? { 'x-requester-proof': 'bob' } : null; } },
    } satisfies ExternalActionExecutionAuthorizationV1;
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
    await expect(readProjectAccountRows({ ...input, selection: { kinds: ['workspace-ref', 'relationship-graph'] } })).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
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
    const older = readProjectAccountRows({ credentials, publication: 'installed' });
    await readStarted.promise;
    expect(await readProjectAccountRows({ credentials, publication: 'installed' })).toMatchObject({ graphRevision: 5, workspaceRefs: [] });
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
    const edit = createProjectAccountSnapshotMutation({ credentials, publication: 'installed' })(snapshot => ({ ...snapshot,
      workspaceRefs: snapshot.workspaceRefs.map(value => ({ ...value, label: 'Earlier edit' })),
    }));
    await writeStarted.promise;
    await readProjectAccountRows({ credentials, publication: 'installed' });
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
    await expect(readProjectAccountRows({ credentials, selection: { kinds: ['workspace-ref'] } })).rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' });
    await expect(readProjectAccountRows({ credentials: { token: 'bad-key', encryption: { type: 'legacy', secret: new Uint8Array(31) } }, selection: { kinds: ['workspace-ref'] } }))
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
    await expect(readProjectAccountRows({ credentials, selection: { kinds: ['workspace-ref'] } })).rejects.toMatchObject({ code: 'project_account_mode_mismatch' });
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 0 } });
    await expect(readProjectAccountRows({ credentials: { token: 't', encryption: { type: 'legacy', secret } }, selection: { kinds: ['workspace-ref'] } })).rejects.toMatchObject({ code: 'project_account_row_invalid' });
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
  it('prepares protected detail before selecting its pointer through the existing organization CAS', async () => {
    const rows: unknown[] = [];
    const post = boundary(rows);
    const detail = deferred();
    const update = mutateProjectAccountOrganization({ credentials, serverId: 'home-a', projectKey: 'project',
      expectedRevision: 'absent', mutate: async value => {
        await detail.promise;
        return { ...value, setupContent: { artifactId: 'prepared-detail', headerVersion: 1, bodyVersion: 1 } };
      } });
    detail.resolve();
    expect(await update).toMatchObject({ status: 'updated', value: {
      setupContent: { artifactId: 'prepared-detail', headerVersion: 1, bodyVersion: 1 },
    } });
    expect(post.mock.calls.filter(([url]) => url.endsWith('/mutate'))).toHaveLength(1);
  });

});
