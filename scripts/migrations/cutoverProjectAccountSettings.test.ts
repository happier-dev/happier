import assert from 'node:assert/strict';
import test from 'node:test';

import { ProjectAccountRowPayloadV1Schema, buildProjectAccountRowPhysicalKeyV1 } from '../../packages/protocol/src/projects/projectAccountRowsV1.js';
import { computeWorkspaceSyncPolicyDigest } from '../../packages/protocol/src/sessions/control/handoff/workspaceSyncSchemas.js';
import { cutoverProjectAccountSettings, type ProjectSettingsCutoverPorts } from './cutoverProjectAccountSettings.js';

function fixture() {
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const refs = [
    { id: 'alpha', serverId: 'home', machineId: 'machine-a', rootPath: '/a', label: 'Alpha', createdAtMs: 1 },
    { id: 'beta', serverId: 'home', machineId: 'machine-b', rootPath: '/b', createdAtMs: 1 },
  ];
  const relationships = [{
    v: 1 as const, relationshipId: 'retained-link', controllerMachineId: 'machine-a',
    alphaWorkspaceRefId: 'alpha', betaWorkspaceRefId: 'beta', mode: 'keep_synced' as const,
    contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    enabled: true, createdAtMs: 1, updatedAtMs: 9,
  }];
  let source = { version: 7, raw: {
    workspaceRefsV1: refs, workspaceSyncRelationshipsV1: relationships, pinnedWorkspaceRefIdsV1: ['alpha'],
    workspaceLabelsV1: { '/a': 'Old label' }, sessionFoldersV1: { v: 1, folders: [] },
  } as Record<string, unknown> };
  let rows: Awaited<ReturnType<ProjectSettingsCutoverPorts['readRows']>> = [];
  let writes = 0;
  let conflictRetirement = false;
  const ports: ProjectSettingsCutoverPorts = {
    async readSource() { return structuredClone(source); },
    async readRows() { return structuredClone(rows); },
    async writeRows(write) {
      for (const mutation of write.mutations) {
        const row = rows.find(candidate => buildProjectAccountRowPhysicalKeyV1(candidate.key) === buildProjectAccountRowPhysicalKeyV1(mutation.key));
        if ((row?.revision ?? 'absent') !== mutation.expectedRevision) return 'conflict';
      }
      rows = [...rows.filter(row => !write.mutations.some(mutation => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(mutation.key))),
        ...write.mutations.map(mutation => ({ key: mutation.key, revision: mutation.expectedRevision === 'absent' ? 0 : mutation.expectedRevision + 1,
          payload: ProjectAccountRowPayloadV1Schema.parse(mutation.payload) }))];
      writes += 1;
      return 'updated';
    },
    async retireSource(next) {
      if (conflictRetirement || next.version !== source.version) return 'conflict';
      source = { version: source.version + 1, raw: structuredClone(next.raw) };
      return 'updated';
    },
  };
  return { ports, refs, relationships, get source() { return source; }, get rows() { return rows; }, get writes() { return writes; },
    setRaw(raw: Record<string, unknown>) { source = { ...source, raw }; },
    setRows(next: typeof rows) { rows = next; },
    conflictRetirement() { conflictRetirement = true; } };
}

test('cuts retained Project data over with original IDs and topology before exact source retirement', async () => {
  const state = fixture();
  assert.deepEqual(await cutoverProjectAccountSettings(state.ports), { status: 'cutover' });
  assert.equal(state.writes, 1);
  assert.deepEqual(state.rows.filter(row => row.key.kind === 'workspace-ref').map(row => row.payload?.value), state.refs);
  assert.deepEqual(state.rows.find(row => row.key.kind === 'relationship-graph')?.payload?.value, { relationships: state.relationships });
  assert.deepEqual(state.rows.find(row => row.key.kind === 'project-organization')?.payload?.value, { pinned: true });
  assert.deepEqual(state.source.raw, { workspaceLabelsV1: { '/a': 'Old label' }, sessionFoldersV1: { v: 1, folders: [] } });
  assert.deepEqual(await cutoverProjectAccountSettings(state.ports), { status: 'not-needed' });
});

test('keeps malformed retained data repairable and performs no destination write', async () => {
  for (const refs of [[{ id: 'malformed' }], fixture().refs.map(ref => ({ ...ref, unknownRetainedFact: 'must not vanish' })),
    fixture().refs.map(ref => ({ ...ref, label: 23 }))]) {
    const state = fixture();
    state.setRaw({ ...state.source.raw, workspaceRefsV1: refs });
    const before = structuredClone(state.source);
    await assert.rejects(cutoverProjectAccountSettings(state.ports));
    assert.deepEqual(state.source, before);
    assert.equal(state.writes, 0);
  }
});

test('transfers Project recency to qualified navigation memory before retiring structural source', async () => {
  const state = fixture();
  state.setRaw({ ...state.source.raw, workspaceRefsV1: state.refs.map(ref => ({ ...ref, projectKey: 'shared-project', lastOpenedAtMs: 42 })) });
  const before = structuredClone(state.source);
  await assert.rejects(cutoverProjectAccountSettings(state.ports), /recency/);
  assert.deepEqual(state.source, before);
  assert.equal(state.writes, 0);
  const memory: unknown[] = [];
  assert.deepEqual(await cutoverProjectAccountSettings({ ...state.ports, async retainRecency(entries) {
    assert.ok(state.source.raw.workspaceRefsV1);
    memory.push(...entries);
  } }), { status: 'cutover' });
  assert.deepEqual(memory, [{ serverId: 'home', projectKey: 'shared-project', lastOpenedAtMs: 42 }]);
  assert.deepEqual(state.rows.filter(row => row.key.kind === 'workspace-ref').map(row => row.payload?.value),
    state.refs.map(ref => ({ ...ref, projectKey: 'shared-project' })));
});

test('retains source after a settings CAS conflict and refuses tombstone resurrection', async () => {
  const state = fixture();
  state.conflictRetirement();
  assert.deepEqual(await cutoverProjectAccountSettings(state.ports), { status: 'source-conflict' });
  assert.ok(state.source.raw.workspaceRefsV1);
  assert.equal(state.rows.length, 4);
  const deleted = fixture();
  deleted.setRows([{ key: { kind: 'workspace-ref', serverId: 'home', id: 'alpha' }, revision: 2, payload: null }]);
  assert.deepEqual(await cutoverProjectAccountSettings(deleted.ports), { status: 'destination-conflict' });
  assert.equal(deleted.writes, 0);
  assert.ok(deleted.source.raw.workspaceRefsV1);
});

test('does not overwrite a canonical unpin with a stale retained pin', async () => {
  const state = fixture();
  const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'alpha' };
  state.setRows([{ key, revision: 2, payload: ProjectAccountRowPayloadV1Schema.parse({ key, value: { pinned: false, hidden: true } }) }]);
  assert.deepEqual(await cutoverProjectAccountSettings(state.ports), { status: 'destination-conflict' });
  assert.equal(state.writes, 0);
  assert.ok(state.source.raw.pinnedWorkspaceRefIdsV1);
  assert.deepEqual(state.rows[0].payload?.value, { pinned: false, hidden: true });
});

test('keeps source when a destination response is not confirmed by authoritative readback', async () => {
  const state = fixture();
  const before = structuredClone(state.source);
  // A persistence/network boundary may acknowledge a write that its read owner
  // cannot yet prove. Do not replace the internal parser or cutover logic.
  await assert.rejects(cutoverProjectAccountSettings({ ...state.ports, async writeRows() { return 'updated'; } }), /acknowledgement/);
  assert.deepEqual(state.source, before);
});
