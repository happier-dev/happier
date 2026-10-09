import { describe, expect, it } from 'vitest';

import { computeWorkspaceSyncPolicyDigest } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import {
  deriveWorkspaceSyncTopology,
  resolveWorkspaceSyncTransferRoute,
  resolveWorkspaceSyncRelationshipEndpointRoles,
  resolveWorkspaceSyncRelationshipTransferDirection,
} from './workspaceSyncTopology.js';

const policyFields = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const contentPolicy = { ...policyFields, policyDigest: computeWorkspaceSyncPolicyDigest(policyFields) };
const refs = [
  { id: 'a', serverId: 'server', machineId: 'machine-a', rootPath: '/a', createdAtMs: 1 },
  { id: 'b', serverId: 'server', machineId: 'machine-b', rootPath: '/b', createdAtMs: 1 },
  { id: 'c', serverId: 'server', machineId: 'machine-c', rootPath: '/c', createdAtMs: 1 },
];
const relationship = (
  relationshipId: string,
  alphaWorkspaceRefId: string,
  betaWorkspaceRefId: string,
  controllerMachineId: string,
  mode: 'keep_synced' | 'mirror_exactly' | 'keep_both_in_sync' = 'keep_both_in_sync',
  enabled = true,
) => ({
  v: 1 as const,
  relationshipId,
  controllerMachineId,
  alphaWorkspaceRefId,
  betaWorkspaceRefId,
  mode,
  contentPolicy,
  enabled,
  createdAtMs: 1,
  updatedAtMs: 1,
});

describe('workspaceSyncTopology', () => {
  it('derives mixed-policy saved links around their concrete controller-owned hub', () => {
    const ab = relationship('ab', 'a', 'b', 'machine-a', 'keep_synced');
    const ac = relationship('ac', 'a', 'c', 'machine-a', 'keep_both_in_sync', false);
    const topology = deriveWorkspaceSyncTopology({ workspaceRefs: refs, relationships: [ab, ac] });

    expect(topology.issues).toEqual([]);
    expect(topology.sets).toEqual([{
      hubWorkspaceRefId: 'a',
      controllerMachineId: 'machine-a',
      relationships: [ab, ac],
    }]);
  });

  it('resolves duplicate ref ids only within the explicitly selected Home', () => {
    const ab = relationship('ab', 'a', 'b', 'machine-a');
    const workspaceRefs = [
      ...refs,
      { ...refs[0]!, serverId: 'other-home', machineId: 'other-machine-a' },
      { ...refs[1]!, serverId: 'other-home', machineId: 'other-machine-b' },
    ];

    expect(deriveWorkspaceSyncTopology({
      serverId: 'server', workspaceRefs, relationships: [ab],
    })).toEqual({
      issues: [],
      sets: [{ hubWorkspaceRefId: 'a', controllerMachineId: 'machine-a', relationships: [ab] }],
    });
    expect(resolveWorkspaceSyncTransferRoute({
      serverId: 'server', workspaceRefs, relationships: [ab],
      sourceWorkspaceRefId: 'a', targetWorkspaceRefId: 'b',
    })).toMatchObject({ ok: true, kind: 'direct', relationships: [ab] });
    expect(deriveWorkspaceSyncTopology({ workspaceRefs, relationships: [ab] })).toEqual({
      sets: [],
      issues: [{ code: 'ambiguous_workspace_ref', relationshipIds: ['ab'], workspaceRefIds: ['a', 'b'] }],
    });
    expect(resolveWorkspaceSyncTransferRoute({
      workspaceRefs, relationships: [ab], sourceWorkspaceRefId: 'a', targetWorkspaceRefId: 'b',
    })).toEqual({ ok: false, code: 'workspace_ref_not_ready', workspaceRefId: 'a' });
  });

  it('refuses same-Home duplicate ids even when the last ref would make topology valid', () => {
    const ab = relationship('ab', 'a', 'b', 'machine-a');
    const workspaceRefs = [{ ...refs[0]!, machineId: 'another-machine' }, ...refs];

    expect(deriveWorkspaceSyncTopology({
      serverId: 'server', workspaceRefs, relationships: [ab],
    })).toEqual({
      sets: [],
      issues: [{ code: 'ambiguous_workspace_ref', relationshipIds: ['ab'], workspaceRefIds: ['a'] }],
    });
    expect(resolveWorkspaceSyncTransferRoute({
      serverId: 'server', workspaceRefs, relationships: [],
      sourceWorkspaceRefId: 'a', targetWorkspaceRefId: 'a',
    })).toEqual({ ok: false, code: 'workspace_ref_not_ready', workspaceRefId: 'a' });
  });

  it('does not recover missing or incomplete Home targets from another Home', () => {
    const ab = relationship('ab', 'a', 'b', 'machine-a');
    expect(deriveWorkspaceSyncTopology({
      serverId: 'missing-home', workspaceRefs: refs, relationships: [ab],
    })).toEqual({
      sets: [],
      issues: [{ code: 'missing_workspace_ref', relationshipIds: ['ab'], workspaceRefIds: ['a', 'b'] }],
    });
    expect(deriveWorkspaceSyncTopology({
      serverId: ' ', workspaceRefs: refs, relationships: [ab],
    })).toEqual({
      sets: [],
      issues: [{ code: 'invalid_workspace_ref', relationshipIds: ['ab'], workspaceRefIds: ['a', 'b'] }],
    });
    expect(resolveWorkspaceSyncTransferRoute({
      serverId: 'missing-home', workspaceRefs: refs, relationships: [ab],
      sourceWorkspaceRefId: 'a', targetWorkspaceRefId: 'b',
    })).toEqual({ ok: false, code: 'workspace_ref_not_ready', workspaceRefId: 'a' });
  });

  it('uses the caller Home alias context for endpoint admission and route topology', () => {
    const ab = relationship('ab', 'a', 'b', 'machine-a');
    const workspaceRefs = refs.map((ref) => ({ ...ref, serverId: 'legacy-profile' }));
    const context = { normalizeServerId: (value: string) => value === 'legacy-profile' ? 'server' : value };

    expect(deriveWorkspaceSyncTopology({
      serverId: 'server', context, workspaceRefs, relationships: [ab],
    })).toEqual({
      issues: [],
      sets: [{ hubWorkspaceRefId: 'a', controllerMachineId: 'machine-a', relationships: [ab] }],
    });
    expect(resolveWorkspaceSyncTransferRoute({
      serverId: 'server', context, workspaceRefs, relationships: [ab],
      sourceWorkspaceRefId: 'a', targetWorkspaceRefId: 'b',
    })).toMatchObject({ ok: true, kind: 'direct', relationships: [ab] });
  });

  it('preserves beta-controlled and same-machine bootstrap conventions', () => {
    expect(resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: 'keep_both_in_sync',
      controllerMachineId: 'machine-b',
      alphaMachineId: 'machine-a',
      betaMachineId: 'machine-b',
    })).toEqual({ sourceEndpointRole: 'beta', targetEndpointRole: 'alpha' });
    expect(resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: 'keep_both_in_sync',
      controllerMachineId: 'machine-a',
      alphaMachineId: 'machine-a',
      betaMachineId: 'machine-a',
    })).toEqual({ sourceEndpointRole: 'alpha', targetEndpointRole: 'beta' });
  });

  it('separates initial roles from allowed transfer direction', () => {
    const twoWay = relationship('ab', 'a', 'b', 'machine-b');
    expect(resolveWorkspaceSyncRelationshipTransferDirection({
      relationship: twoWay,
      sourceWorkspaceRefId: 'b',
      targetWorkspaceRefId: 'a',
    })).toEqual({ sourceEndpointRole: 'beta', targetEndpointRole: 'alpha' });
    expect(resolveWorkspaceSyncRelationshipTransferDirection({
      relationship: { ...twoWay, mode: 'keep_synced' },
      sourceWorkspaceRefId: 'b',
      targetWorkspaceRefId: 'a',
    })).toBeNull();
  });

  it('reports cycles and spoke reuse as typed component issues', () => {
    const topology = deriveWorkspaceSyncTopology({
      workspaceRefs: refs,
      relationships: [
        relationship('ab', 'a', 'b', 'machine-a'),
        relationship('ac', 'a', 'c', 'machine-a'),
        relationship('bc', 'b', 'c', 'machine-b'),
      ],
    });
    expect(topology.sets).toEqual([]);
    expect(topology.issues).toContainEqual(expect.objectContaining({
      code: 'unsupported_component',
      relationshipIds: ['ab', 'ac', 'bc'],
    }));
  });

  it('resolves a direct route once and a spoke route in source-to-target order', () => {
    const ac = relationship('ac', 'a', 'c', 'machine-a', 'keep_both_in_sync');
    const ab = relationship('ab', 'a', 'b', 'machine-a', 'keep_synced');

    expect(resolveWorkspaceSyncTransferRoute({
      workspaceRefs: refs,
      relationships: [ac, ab],
      sourceWorkspaceRefId: 'a',
      targetWorkspaceRefId: 'b',
    })).toMatchObject({ ok: true, kind: 'direct', relationships: [ab] });
    expect(resolveWorkspaceSyncTransferRoute({
      workspaceRefs: refs,
      relationships: [ac, ab],
      sourceWorkspaceRefId: 'c',
      targetWorkspaceRefId: 'b',
    })).toMatchObject({ ok: true, kind: 'via_hub', hubWorkspaceRefId: 'a', relationships: [ac, ab] });
  });

  it('rejects reverse one-way transfer but permits a beta-controller two-way source', () => {
    const ac = relationship('ac', 'a', 'c', 'machine-a', 'keep_both_in_sync');
    const ab = relationship('ab', 'a', 'b', 'machine-a', 'keep_synced');
    expect(resolveWorkspaceSyncTransferRoute({
      workspaceRefs: refs,
      relationships: [ac, ab],
      sourceWorkspaceRefId: 'b',
      targetWorkspaceRefId: 'c',
    })).toMatchObject({ ok: false, code: 'direction_mismatch', relationshipId: 'ab' });

    const betaControlled = relationship('ba', 'b', 'a', 'machine-a', 'keep_both_in_sync');
    expect(resolveWorkspaceSyncTransferRoute({
      workspaceRefs: refs,
      relationships: [betaControlled, ac],
      sourceWorkspaceRefId: 'b',
      targetWorkspaceRefId: 'c',
    })).toMatchObject({ ok: true, kind: 'via_hub', relationships: [betaControlled, ac] });
  });

  it('fails closed for a paused or changed selected route without considering another component', () => {
    const ac = relationship('ac', 'a', 'c', 'machine-a', 'keep_both_in_sync');
    const ab = relationship('ab', 'a', 'b', 'machine-a', 'keep_synced', false);
    expect(resolveWorkspaceSyncTransferRoute({
      workspaceRefs: refs,
      relationships: [ac, ab],
      sourceWorkspaceRefId: 'c',
      targetWorkspaceRefId: 'b',
    })).toMatchObject({ ok: false, code: 'relationship_paused', relationshipId: 'ab' });
  });
});
