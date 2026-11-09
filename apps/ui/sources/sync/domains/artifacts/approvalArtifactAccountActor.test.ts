import { describe, expect, it } from 'vitest';
import type { ArtifactAccessGrantsListResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';

import { projectApprovalArtifactAccountActor } from './approvalArtifactAccountActor';

const accessGrants: ArtifactAccessGrantsListResponseV1 = {
  artifactId: 'approval-1',
  ownerAccountId: 'alice',
  access: 'owner',
  grants: [{
    principal: { kind: 'account', accountId: 'bob' },
    accessLevel: 'view',
    createdByAccountId: 'alice',
    createdAt: 1,
    display: { name: 'QA N3 Bob', username: 'qa-n3b' },
  }],
};

describe('projectApprovalArtifactAccountActor', () => {
  it('projects a direct requester grant as a current sanitized actor', () => {
    expect(projectApprovalArtifactAccountActor({
      artifactId: 'approval-1', serverId: 'server-1', accountId: 'bob', accessGrants,
    })).toMatchObject({
      serverId: 'server-1', accountId: 'bob', accessibility: 'current',
      profile: { name: 'QA N3 Bob', username: 'qa-n3b' },
    });
  });

  it('projects a missing requester from an available roster as former', () => {
    expect(projectApprovalArtifactAccountActor({
      artifactId: 'approval-1', serverId: 'server-1', accountId: 'carol', accessGrants,
    })).toMatchObject({
      serverId: 'server-1', accountId: 'carol', accessibility: 'former', profile: null,
    });
  });

  it('does not infer a relationship when the roster is unavailable', () => {
    expect(projectApprovalArtifactAccountActor({
      artifactId: 'approval-1', serverId: 'server-1', accountId: 'bob', accessGrants: null,
    })).toBeNull();
  });
});
