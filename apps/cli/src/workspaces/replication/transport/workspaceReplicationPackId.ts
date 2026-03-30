import { createHash } from 'node:crypto';

import { deterministicStringify } from '@/utils/deterministicJson';

const MAX_WORKSPACE_REPLICATION_PACK_ID_LENGTH = 128;

export class WorkspaceReplicationBlobPackInputError extends Error {
  readonly code: 'invalid_pack_id';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceReplicationBlobPackInputError';
    this.code = 'invalid_pack_id';
  }
}

export function assertSafeWorkspaceReplicationPackId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WorkspaceReplicationBlobPackInputError('Workspace replication pack id is required');
  }
  if (trimmed.length > MAX_WORKSPACE_REPLICATION_PACK_ID_LENGTH) {
    throw new WorkspaceReplicationBlobPackInputError('Workspace replication pack id is invalid');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new WorkspaceReplicationBlobPackInputError('Workspace replication pack id is invalid');
  }
  if (trimmed.includes('\0') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new WorkspaceReplicationBlobPackInputError('Workspace replication pack id is invalid');
  }
  return trimmed;
}

export function createWorkspaceReplicationPackIdForDigests(digests: readonly string[]): string {
  const payload = deterministicStringify({
    schemaVersion: 1,
    digests: [...digests],
  });
  return `pack_${createHash('sha256').update(payload).digest('hex')}`;
}
