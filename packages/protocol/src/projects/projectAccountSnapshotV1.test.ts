import { describe, expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { assertProjectAccountSnapshotTransition, parseProjectAccountSnapshotV1, ProjectAccountSnapshotV1Schema } from './projectAccountSnapshotV1.js';

describe('ProjectAccountSnapshotV1', () => {
  it('reads known stored fields without assigning meaning to unknown fields', () => {
    const empty = parseProjectAccountSnapshotV1({});
    expect(empty.workspaceRefs).toEqual([]);

    const parsed = parseProjectAccountSnapshotV1({
      workspaceRefs: [
        {
          id: 'workspace_1',
          serverId: 'server_1',
          machineId: 'machine_1',
          rootPath: '/repo',
          label: null,
          createdAtMs: 1,
          lastOpenedAtMs: 2,
          futureWorkspaceField: { keep: true },
        },
      ],
      futureSnapshotField: true,
    });

    expect(parsed.workspaceRefs).toEqual([
      expect.objectContaining({
        id: 'workspace_1',
        serverId: 'server_1',
        machineId: 'machine_1',
        rootPath: '/repo',
      }),
    ]);
    expect(parsed.workspaceRefs[0]).not.toHaveProperty('futureWorkspaceField');
    expect(parsed).not.toHaveProperty('futureSnapshotField');
  });

  it('fails closed for malformed workspace refs instead of silently dropping them', () => {
    expect(() => parseProjectAccountSnapshotV1({
      workspaceRefs: [{ id: 'workspace_missing_scope' }],
    })).toThrow();
    expect(parseProjectAccountSnapshotV1({
      workspaceRefs: [
        { id: 'one', serverId: 'server', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 },
        { id: 'two', serverId: 'server', machineId: 'machine', rootPath: '/repo/', createdAtMs: 1 },
      ],
    }).workspaceRefs).toHaveLength(2);
  });

  it('rejects rebinding retained workspace and relationship identities in place', () => {
    const policyFields = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const base = {
      workspaceRefs: [
        { id: 'alpha', serverId: 'server', machineId: 'machine-a', rootPath: '/a', createdAtMs: 1 },
        { id: 'beta', serverId: 'server', machineId: 'machine-b', rootPath: '/b', createdAtMs: 1 },
      ],
      relationships: [{
        v: 1 as const,
        relationshipId: 'relationship',
        controllerMachineId: 'machine-a',
        alphaWorkspaceRefId: 'alpha',
        betaWorkspaceRefId: 'beta',
        mode: 'keep_synced' as const,
        contentPolicy: {
          ...policyFields,
          policyDigest: computeWorkspaceSyncPolicyDigest(policyFields),
        },
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
      }],
    };

    expect(() => assertProjectAccountSnapshotTransition(base, {
      ...base,
      workspaceRefs: base.workspaceRefs.map((ref) => ref.id === 'alpha' ? { ...ref, rootPath: '/moved' } : ref),
    })).toThrow(expect.objectContaining({ code: 'workspace_ref_in_use' }));
    expect(() => assertProjectAccountSnapshotTransition(base, {
      ...base,
      workspaceRefs: base.workspaceRefs.map((ref) => ({ ...ref, serverId: 'another-home' })),
    })).toThrow(expect.objectContaining({ code: 'workspace_ref_in_use' }));
    expect(() => assertProjectAccountSnapshotTransition(base, {
      ...base,
      workspaceRefs: base.workspaceRefs.map((ref) => ({ ...ref, projectKey: ref.id })),
    })).not.toThrow();
    const anchored = {
      ...base,
      workspaceRefs: base.workspaceRefs.map((ref) => ({
        ...ref, projectKey: ref.id === 'alpha' ? 'established-project' : ref.id,
      })),
    };
    expect(() => assertProjectAccountSnapshotTransition(anchored, {
      ...anchored,
      workspaceRefs: anchored.workspaceRefs.map((ref) => ({
        ...ref, source: { sourceId: 'saved-source', revision: 1 },
      })),
    })).not.toThrow();
    expect(() => assertProjectAccountSnapshotTransition(anchored, {
      ...anchored,
      workspaceRefs: anchored.workspaceRefs.map((ref) => ref.id === 'alpha'
        ? { ...ref, projectKey: 'another-project' } : ref),
    })).toThrow(expect.objectContaining({ code: 'workspace_ref_in_use' }));
    expect(() => assertProjectAccountSnapshotTransition(anchored, {
      ...anchored,
      workspaceRefs: anchored.workspaceRefs.map((ref) => ref.id === 'alpha'
        ? { ...ref, projectKey: undefined } : ref),
    })).toThrow(expect.objectContaining({ code: 'workspace_ref_in_use' }));
    const unreferenced = {
      ...base,
      workspaceRefs: [...base.workspaceRefs, {
        id: 'spare', serverId: 'server-1', machineId: 'machine-c', rootPath: '/spare',
        createdAtMs: 1,
      }],
    };
    expect(() => assertProjectAccountSnapshotTransition(unreferenced, {
      ...unreferenced,
      workspaceRefs: unreferenced.workspaceRefs.map((ref) => (
        ref.id === 'spare' ? { ...ref, rootPath: '/rebound' } : ref
      )),
    })).toThrow(expect.objectContaining({ code: 'workspace_ref_in_use' }));
    expect(() => assertProjectAccountSnapshotTransition(base, {
      ...base,
      relationships: base.relationships.map((relationship) => ({
        ...relationship,
        mode: 'mirror_exactly' as const,
      })),
    })).toThrow(expect.objectContaining({ code: 'relationship_definition_conflict' }));
    expect(() => assertProjectAccountSnapshotTransition(base, {
      ...base,
      relationships: base.relationships.map((relationship) => ({
        ...relationship,
        enabled: false,
        updatedAtMs: 2,
      })),
    })).not.toThrow();
  });

  it('preserves more than 32 valid relationships and rejects malformed relationship authority', () => {
    const policyFields = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const contentPolicy = {
      ...policyFields,
      policyDigest: computeWorkspaceSyncPolicyDigest(policyFields),
    };
    const relationships = Array.from({ length: 33 }, (_, index) => ({
      v: 1 as const,
      relationshipId: `relationship-${index}`,
      controllerMachineId: 'machine-controller',
      alphaWorkspaceRefId: `alpha-${index}`,
      betaWorkspaceRefId: `beta-${index}`,
      mode: 'keep_synced' as const,
      contentPolicy,
      enabled: true,
      createdAtMs: index,
      updatedAtMs: index,
    }));
    const workspaceRefs = relationships.flatMap((relationship, index) => [
      { id: relationship.alphaWorkspaceRefId, serverId: 'server', machineId: 'machine-controller', rootPath: `/alpha-${index}`, createdAtMs: index },
      { id: relationship.betaWorkspaceRefId, serverId: 'server', machineId: `machine-beta-${index}`, rootPath: `/beta-${index}`, createdAtMs: index },
    ]);

    expect(parseProjectAccountSnapshotV1({ workspaceRefs, relationships }).relationships)
      .toHaveLength(33);
    expect(() => parseProjectAccountSnapshotV1({
      relationships: [{ relationshipId: 'malformed' }],
    })).toThrow();
  });

  it('validates workspace identity, scope, relationship references, and endpoint-pair ownership together', () => {
    const refs = [
      { id: 'alpha', serverId: 'server', machineId: 'machine-a', rootPath: '/alpha', createdAtMs: 1 },
      { id: 'beta', serverId: 'server', machineId: 'machine-b', rootPath: '/beta', createdAtMs: 1 },
    ];
    const policyFields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
    const relationship = {
      v: 1 as const, relationshipId: 'relationship-1', controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'alpha', betaWorkspaceRefId: 'beta', mode: 'keep_synced' as const,
      contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    };

    expect(parseProjectAccountSnapshotV1({ workspaceRefs: refs, relationships: [relationship] }))
      .toMatchObject({ workspaceRefs: refs, relationships: [relationship] });
    const normalizedRefs = refs.map((ref) => ({ ...ref, id: ` ${ref.id} `, serverId: ' server ' }));
    expect(parseProjectAccountSnapshotV1({ workspaceRefs: normalizedRefs, relationships: [relationship] }))
      .toMatchObject({ workspaceRefs: normalizedRefs, relationships: [relationship] });
    expect(() => assertProjectAccountSnapshotTransition(
      { workspaceRefs: normalizedRefs, relationships: [] },
      { workspaceRefs: normalizedRefs, relationships: [relationship] },
    )).not.toThrow();
    expect(() => assertProjectAccountSnapshotTransition(
      { workspaceRefs: normalizedRefs, relationships: [] },
      { workspaceRefs: [{ ...refs[0], rootPath: '/rebound' }, refs[1]], relationships: [] },
    )).toThrow(expect.objectContaining({ code: 'workspace_ref_in_use' }));
    const stored = {
      workspaceRefs: refs,
      relationships: [{ ...relationship, contentPolicy: { ...contentPolicy, futurePolicyField: { enabled: true } } }],
    };
    const opened = parseProjectAccountSnapshotV1(stored);
    expect(opened.relationships[0].contentPolicy).toEqual(contentPolicy);
    expect(ProjectAccountSnapshotV1Schema.safeParse(opened).success).toBe(true);
    expect(ProjectAccountSnapshotV1Schema.safeParse(stored).success).toBe(false);
    expect(parseProjectAccountSnapshotV1({ workspaceRefs: [...refs, { ...refs[1], id: 'beta-2' }] }).workspaceRefs).toHaveLength(3);
    expect(() => parseProjectAccountSnapshotV1({ workspaceRefs: [...refs, { ...refs[1], rootPath: '/other' }] })).toThrow(/id/i);
    expect(() => parseProjectAccountSnapshotV1({ workspaceRefs: refs, relationships: [{ ...relationship, betaWorkspaceRefId: 'missing' }] })).toThrow(/reference/i);
    expect(parseProjectAccountSnapshotV1({
      workspaceRefs: refs,
      relationships: [relationship, { ...relationship, relationshipId: 'relationship-2' }],
    }).relationships).toHaveLength(2);
    expect(parseProjectAccountSnapshotV1({ workspaceRefs: refs, relationships: [{ ...relationship, controllerMachineId: 'machine-b' }] })
      .relationships).toHaveLength(1);
    expect(() => assertProjectAccountSnapshotTransition(
      { workspaceRefs: refs, relationships: [] },
      { workspaceRefs: refs, relationships: [{ ...relationship, controllerMachineId: 'machine-b' }] },
    )).toThrow(expect.objectContaining({ code: 'workspace_sync_topology_invalid' }));
  });

  it('preserves qualified duplicate ids but refuses ambiguous or cross-Home Sync endpoints', () => {
    const refs = [
      { id: 'alpha', serverId: 'home-a', machineId: 'machine-a', rootPath: '/a', createdAtMs: 1 },
      { id: 'beta', serverId: 'home-a', machineId: 'machine-b', rootPath: '/b', createdAtMs: 1 },
      { id: 'alpha', serverId: 'home-b', machineId: 'machine-a', rootPath: '/a', createdAtMs: 1 },
    ];
    const policyFields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const relationship = {
      v: 1 as const, relationshipId: 'link', controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'alpha', betaWorkspaceRefId: 'beta', mode: 'keep_synced' as const,
      contentPolicy: { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) },
      enabled: true, createdAtMs: 1, updatedAtMs: 1,
    };
    expect(parseProjectAccountSnapshotV1({ workspaceRefs: refs }).workspaceRefs).toHaveLength(3);
    expect(() => parseProjectAccountSnapshotV1({
      workspaceRefs: [...refs, { ...refs[0], id: ' alpha ', serverId: ' home-a ' }],
    })).toThrow(/id/i);
    expect(() => parseProjectAccountSnapshotV1({ workspaceRefs: refs, relationships: [relationship] })).toThrow(/unambiguously/);
    expect(() => parseProjectAccountSnapshotV1({
      workspaceRefs: [refs[1], refs[2]], relationships: [relationship],
    })).toThrow(/Home/);
  });

  it('admits only supported workspace-sync components while keeping saved invalid topology readable and removable', () => {
    const policyFields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
    const refs = [
      { id: 'a', serverId: 'server', machineId: 'machine-a', rootPath: '/a', createdAtMs: 1 },
      { id: 'b', serverId: 'server', machineId: 'machine-b', rootPath: '/b', createdAtMs: 1 },
      { id: 'c', serverId: 'server', machineId: 'machine-c', rootPath: '/c', createdAtMs: 1 },
      { id: 'd', serverId: 'server', machineId: 'machine-d', rootPath: '/d', createdAtMs: 1 },
      { id: 'e', serverId: 'server', machineId: 'machine-e', rootPath: '/e', createdAtMs: 1 },
    ];
    const relationship = (
      relationshipId: string,
      alphaWorkspaceRefId: string,
      betaWorkspaceRefId: string,
      controllerMachineId: string,
      enabled = true,
    ) => ({
      v: 1 as const,
      relationshipId,
      controllerMachineId,
      alphaWorkspaceRefId,
      betaWorkspaceRefId,
      mode: 'keep_both_in_sync' as const,
      contentPolicy,
      enabled,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const ab = relationship('ab', 'a', 'b', 'machine-a');
    const ac = relationship('ac', 'a', 'c', 'machine-a');
    const bc = relationship('bc', 'b', 'c', 'machine-b');
    const unrelated = relationship('de', 'd', 'e', 'machine-d');

    expect(() => assertProjectAccountSnapshotTransition(
      { workspaceRefs: refs, relationships: [ab] },
      { workspaceRefs: refs, relationships: [ab, ac] },
    )).not.toThrow();

    expect(() => assertProjectAccountSnapshotTransition(
      { workspaceRefs: refs, relationships: [ab, ac] },
      { workspaceRefs: refs, relationships: [ab, ac, bc] },
    )).toThrow(expect.objectContaining({ code: 'workspace_sync_topology_invalid' }));

    const savedInvalid = { workspaceRefs: refs, relationships: [ab, ac, bc] };
    expect(parseProjectAccountSnapshotV1(savedInvalid).relationships).toHaveLength(3);
    expect(() => assertProjectAccountSnapshotTransition(savedInvalid, {
      ...savedInvalid,
      relationships: [ab, ac],
    })).not.toThrow();

    const disabledReuse = relationship('bc-disabled', 'b', 'c', 'machine-b', false);
    const withDisabledReuse = { workspaceRefs: refs, relationships: [ab, ac, disabledReuse] };
    expect(parseProjectAccountSnapshotV1(withDisabledReuse).relationships).toHaveLength(3);
    expect(() => assertProjectAccountSnapshotTransition(withDisabledReuse, {
      ...withDisabledReuse,
      relationships: [ab, ac, { ...disabledReuse, enabled: true, updatedAtMs: 2 }],
    })).toThrow(expect.objectContaining({ code: 'workspace_sync_topology_invalid' }));

    // An unrelated change does not make an already-saved invalid component a
    // global parse/write poison pill.
    expect(() => assertProjectAccountSnapshotTransition(withDisabledReuse, {
      ...withDisabledReuse,
      relationships: [...withDisabledReuse.relationships, unrelated],
    })).not.toThrow();
  });

});
