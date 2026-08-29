import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceSyncHandoffAdapter } from './workspaceSyncHandoffAdapter';

describe('WorkspaceSyncHandoffAdapter', () => {
  it('ensures a relationship during prepare and flushes it at commit', async () => {
    const sync = {
      ensure: vi.fn(async () => ({ relationshipId: 'rel-1', status: 'ready' })),
      flush: vi.fn(async () => ({ relationshipId: 'rel-1', status: 'synced' })),
      terminate: vi.fn(async () => undefined),
    };
    const adapter = createWorkspaceSyncHandoffAdapter({ sync });

    const prepared = await adapter.prepare({
      operationId: 'handoff-1',
      action: { kind: 'relationship', relationshipId: 'rel-1', flushBeforeCommit: true },
      sourceMachineId: 'machine-a',
      targetMachineId: 'machine-b',
      sourceWorkspaceRefId: 'workspace-a',
      targetWorkspaceRefId: 'workspace-b',
      sourceRootPath: '/src',
      targetRootPath: '/dst',
      contentPolicy: { v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [], includeGitDirectory: false },
    });

    expect(prepared).toMatchObject({ kind: 'relationship', relationshipId: 'rel-1' });
    expect(sync.ensure).toHaveBeenCalledWith(expect.objectContaining({ relationshipId: 'rel-1' }), undefined);

    const committed = await adapter.commit({ operationId: 'handoff-1', prepared });
    expect(committed).toMatchObject({ kind: 'relationship', relationshipId: 'rel-1' });
    expect(sync.flush).toHaveBeenCalledWith('rel-1', undefined);
  });

  it('uses copyOnce for a one-shot action and never downgrades to the old engine', async () => {
    const sync = { copyOnce: vi.fn(async () => ({ relationshipId: 'copy-1', status: 'synced' })) };
    const adapter = createWorkspaceSyncHandoffAdapter({ sync });
    const prepared = await adapter.prepare({
      operationId: 'handoff-copy',
      action: { kind: 'copy_once', contentPolicy: { v: 1, selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [], includeGitDirectory: false } },
      sourceMachineId: 'machine-a', targetMachineId: 'machine-b',
      sourceWorkspaceRefId: 'workspace-a', targetWorkspaceRefId: 'workspace-b',
      sourceRootPath: '/src', targetRootPath: '/dst',
    });
    await adapter.commit({ operationId: 'handoff-copy', prepared });
    expect(sync.copyOnce).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'handoff-copy' }), undefined);
  });
});
