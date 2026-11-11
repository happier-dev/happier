import { describe, expect, it } from 'vitest';

import {
  matchesWorkspaceSyncFinalReadyFact,
  type WorkspaceSyncFinalReadyFact,
  type WorkspaceSyncRequesterCopyCustody,
} from './workspaceSyncFinalReadyFact';

const basis = {
  relationshipId: 'relationship', endpointRole: 'beta' as const,
  targetWorkspaceRefId: 'target-ref', canonicalRoot: '/target',
  rootFingerprint: 'fingerprint', policyDigest: 'policy',
};
const custody: WorkspaceSyncRequesterCopyCustody = {
  accountServerId: 'home', actorAccountId: 'requester-a',
  sourceWriter: { machineId: 'source', installationId: 'source-installation' },
  sourceWorkspace: { id: 'source-ref', machineId: 'source', rootPath: '/source' },
  target: { machineId: 'target', installationId: 'target-installation' },
  relationship: {
    v: 1, relationshipId: basis.relationshipId, controllerMachineId: 'source',
    alphaWorkspaceRefId: 'source-ref', betaWorkspaceRefId: basis.targetWorkspaceRefId,
    mode: 'keep_synced', enabled: true, createdAtMs: 1, updatedAtMs: 1,
    contentPolicy: { v: 1, selection: 'all_files', extraIgnorePatterns: [],
      extraIncludePatterns: [], policyDigest: basis.policyDigest },
  },
};
const installed: WorkspaceSyncFinalReadyFact = { ...basis, v: 1, completedAtMs: 1 };
const requester: WorkspaceSyncFinalReadyFact = { ...basis, v: 2, completedAtMs: 1, requesterCopyCustody: custody };

describe('Workspace Sync final READY custody matching', () => {
  it('matches installed custody only when both sides carry no requester custody', () => {
    expect(matchesWorkspaceSyncFinalReadyFact(installed, basis)).toBe(true);
    expect(matchesWorkspaceSyncFinalReadyFact(requester, basis)).toBe(false);
  });

  it('matches requester custody only when the caller carries the identical binding', () => {
    const expected = { ...basis, requesterCopyCustody: custody };
    expect(matchesWorkspaceSyncFinalReadyFact(requester, expected)).toBe(true);
    expect(matchesWorkspaceSyncFinalReadyFact(installed, expected)).toBe(false);
    expect(matchesWorkspaceSyncFinalReadyFact(requester, {
      ...basis, requesterCopyCustody: { ...custody, actorAccountId: 'requester-b' },
    })).toBe(false);
  });
});
