import { describe, expect, it } from 'vitest';
// Sync already imports retirement input; loading its schema first must retain the public read.
import { WorkspaceSyncCommittedCopyInspectV1Schema } from '../../sessions/control/handoff/workspaceSyncCommittedCopyV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { computeWorkspaceSyncPolicyDigest } from '../../sessions/control/handoff/workspaceSyncSchemas.js';
import { PROJECT_WORKER_ACTION_SPECS } from './projectWorkers.js';

describe('committed-worker-copy review Action declaration', () => {
  it('publishes a strict passive read through the existing committed-copy owner', () => {
    const spec = PROJECT_WORKER_ACTION_SPECS.find(row => row.id === 'projects.worker.copy.inspect');
    expect(spec).toBeDefined();
    if (!spec) throw new Error('The committed-copy review Action is missing');
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine',
      surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true },
      bindings: { rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT },
    });
    expect(spec.cli?.commands).toContainEqual(expect.objectContaining({ path: ['projects', 'worker', 'copy', 'inspect'] }));
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const request = { kind: 'preview', workspace: { serverId: 'home', refId: 'source' }, machineId: 'controller',
      targetMachineId: 'worker', targetWorkspaceRefId: 'copy', expectedRelationship: {
        v: 1, relationshipId: 'copy-link', controllerMachineId: 'controller', alphaWorkspaceRefId: 'source',
        betaWorkspaceRefId: 'copy', mode: 'keep_synced', enabled: true, createdAtMs: 1, updatedAtMs: 2,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      } };
    expect(spec.inputSchema.safeParse(request).success).toBe(true);
    expect(WorkspaceSyncCommittedCopyInspectV1Schema.safeParse(request).success).toBe(true);
    expect(spec.inputSchema.safeParse({ ...request, rootPath: '/caller/root' }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...request, expectedRelationship: undefined }).success).toBe(false);
    expect(spec.inputSchema.safeParse({ ...request, removeTargetCopy: { workspaceRefId: 'copy', rootFingerprint: 'a'.repeat(64) } }).success).toBe(false);
    const preview = { targetMachineId: 'worker', workspaceRefId: 'copy', rootFingerprint: 'a'.repeat(64), sizeBytes: 0 };
    expect(spec.outputSchema?.safeParse({ ok: true, preview }).success).toBe(true);
    expect(spec.outputSchema?.safeParse({ ok: true, preview: { ...preview, rootPath: '/private/root' } }).success).toBe(false);
    expect(spec.outputSchema?.safeParse({ ok: false, errorCode: 'workspace_copy_not_owned' }).success).toBe(true);
  });
});
