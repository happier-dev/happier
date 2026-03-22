import { createHash } from 'node:crypto';

import {
  serializeWorkspaceReplicationDirectionScope,
  type WorkspaceReplicationDirectionScope,
} from '../relationships/relationshipScope';

export type WorkspaceReplicationBaselineScope = WorkspaceReplicationDirectionScope;

export function buildWorkspaceReplicationBaselineCacheKey(scope: WorkspaceReplicationBaselineScope): string {
  const hash = createHash('sha256');
  hash.update('workspace-replication-baseline-v1\n');
  hash.update(serializeWorkspaceReplicationDirectionScope(scope));
  return `workspace-replication-baseline-v1-${hash.digest('hex')}`;
}
