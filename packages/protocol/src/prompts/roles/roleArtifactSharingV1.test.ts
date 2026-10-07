import { describe, expect, it } from 'vitest';
import { listSharedRoleArtifactsV1, roleArtifactSharingAdapterV1 } from './roleArtifactSharingV1.js';

const role = { name: 'Builder', instructions: 'Build', runsAs: { kind: 'session' }, workspaceWrites: 'allow', secondOpinion: 'off', enabled: true };
const artifact = { artifactId: 'shared-role', ownerAccountId: 'other', access: 'view' as const,
  header: { kind: 'role.v1', name: 'Builder' }, body: JSON.stringify(role), revision: { headerVersion: 1, bodyVersion: 1 } };

describe('role Artifact grant projection', () => {
  it('filters granted opened documents by kind and carries access and current revision', () => {
    expect(listSharedRoleArtifactsV1([
      artifact,
      { ...artifact, artifactId: 'owned', access: 'owner' },
      { ...artifact, artifactId: 'unproven', access: undefined },
      { ...artifact, artifactId: 'workflow', header: { kind: 'workflow-definition.v1' } },
    ])).toMatchObject([{ roleId: 'shared-role', role, shared: true, viewOnly: true, revision: artifact.revision }]);
    expect(listSharedRoleArtifactsV1([{ ...artifact, access: 'edit' }])[0]?.viewOnly).toBe(false);
    expect(listSharedRoleArtifactsV1([])).toEqual([]);
  });

  it('never admits a malformed or different-kind role to the grant path', () => {
    expect(roleArtifactSharingAdapterV1.canShare({ ...artifact, body: '{}' })).toBe(false);
    expect(roleArtifactSharingAdapterV1.canShare({ ...artifact, header: { kind: 'notes.v1' } })).toBe(false);
  });

  it('projects stored granted role documents with additive fields without losing the role', () => {
    const opened = { ...artifact, body: JSON.stringify({ ...role, future: true, runsAs: { ...role.runsAs, future: true } }) };
    expect(roleArtifactSharingAdapterV1.canShare(opened)).toBe(true);
    expect(listSharedRoleArtifactsV1([opened])[0]?.role).toEqual(role);
  });
});
