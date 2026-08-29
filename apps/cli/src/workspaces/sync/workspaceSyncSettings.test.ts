import { describe, expect, it } from 'vitest';
import { validateWorkspaceSyncRelationships } from './workspaceSyncSettings';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';

const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [], includeGitDirectory: false, policyDigest: '' };
policy.policyDigest = computeWorkspaceSyncPolicyDigest(policy);
const relationship = (id: string, alpha = 'a', beta = 'b') => ({ v: 1 as const, relationshipId: id, controllerMachineId: 'machine-a', alphaWorkspaceRefId: alpha, betaWorkspaceRefId: beta, mode: 'keep_synced' as const, contentPolicy: policy, enabled: true, createdAtMs: 1, updatedAtMs: 1 });

describe('workspace sync relationship settings', () => {
  it('accepts bounded valid relationships', () => expect(validateWorkspaceSyncRelationships([relationship('r1')])).toEqual([relationship('r1')]));
  it('rejects duplicate ids and endpoints', () => {
    expect(() => validateWorkspaceSyncRelationships([relationship('r1'), relationship('r1')])).toThrow(/relationshipId/);
    expect(() => validateWorkspaceSyncRelationships([relationship('r1', 'a', 'a')])).toThrow(/distinct/);
  });
  it('rejects invalid policy digests and oversized pattern lists', () => {
    expect(() => validateWorkspaceSyncRelationships([{ ...relationship('r1'), contentPolicy: { ...policy, policyDigest: 'bad' } }])).toThrow(/policyDigest/);
    expect(() => validateWorkspaceSyncRelationships([{ ...relationship('r1'), contentPolicy: { ...policy, extraIgnorePatterns: Array.from({ length: 257 }, () => 'x') } }])).toThrow(/patterns/);
  });
});
