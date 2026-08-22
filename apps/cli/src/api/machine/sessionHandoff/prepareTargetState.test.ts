import { describe, expect, it } from 'vitest';

import {
  resolvePrepareTargetWorkspaceRootPath,
  resolveWorkspaceReplicationHandoffBackTargetRootPath,
} from './prepareTargetState';

describe('prepareTargetState handoff workspace paths', () => {
  const workspaceTransfer = {
    enabled: true as const,
    strategy: 'sync_changes' as const,
    conflictPolicy: 'replace_existing' as const,
    includeIgnoredMode: 'exclude' as const,
    ignoredIncludeGlobs: [],
  };

  it('preserves a Windows origin root when resolving a sync_changes handoff back', () => {
    expect(resolveWorkspaceReplicationHandoffBackTargetRootPath({
      metadata: {
        handoffV1: {
          sourceMachineId: 'machine_windows_origin',
          sourceWorkspaceRootPath: 'C:\\Users\\alice\\projects\\demo',
        },
      },
      workspaceTransfer,
      requestedTargetMachineId: 'machine_windows_origin',
    })).toBe('C:\\Users\\alice\\projects\\demo');
  });

  it('prefers the Windows handoff-back root over a conflict sibling target path', () => {
    expect(resolvePrepareTargetWorkspaceRootPath({
      requestedTargetPath: 'C:\\Users\\alice\\projects\\demo-replication-9',
      workspaceTransfer,
      handoffMetadataV2: {
        workspaceReplicationHandoffBackTargetRootPath: 'C:\\Users\\alice\\projects\\demo',
      },
      homeDir: 'C:\\Users\\alice',
    })).toBe('C:\\Users\\alice\\projects\\demo');
  });
});
