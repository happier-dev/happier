import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from '../../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../../approvals/approvalRequestTransition.js';
import { computeWorkspaceSyncPolicyDigest } from '../../sessions/control/handoff/workspaceSyncSchemas.js';
import { executeApprovalObservationAction } from './approvalObservation.js';

it('settles an admitted unknown link from its owner without replaying the effect and preserves unknown on unavailable observation or failed storage', async () => {
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const original = ApprovalRequestV2Schema.parse({ v: 2, status: 'outcome_unknown', createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent',
    actionId: 'workspace.sync.relationship.create', summary: 'Link worker',
    actionArgs: { v: 1, sourceWorkspaceRefId: 'source', targetMachineId: 'worker', targetPath: '/copy',
      mode: 'keep_synced', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      destinationIntent: 'materialize_from_source_workspace', purpose: 'worker_clean_copy' },
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
      serverId: 'profile', serverIdentityId: 'home', sessionId: 'session',
      actionId: 'workspace.sync.relationship.create', requestId: 'admitted-request' },
    decision: { kind: 'approve', decidedAtMs: 1 },
    execution: { executedAtMs: 2, ok: false, effectAttempted: true, errorCode: 'RPC_OUTCOME_UNKNOWN' } });
  for (const scenario of ['present', 'absent', 'offline', 'storage_conflict', 'foreign_session'] as const) {
    let stored = original;
    let observations = 0;
    const result = await executeApprovalObservationAction({ actionId: 'approval.request.get', input: { artifactId: 'approval' },
      context: { surface: 'cli', ...(scenario === 'foreign_session' ? { externalActionTarget: { kind: 'session' as const, sessionId: 'other' } } : {}) },
      deps: {
        approvalsGet: async () => stored,
        approvalsUpdate: async ({ request }) => {
          if (scenario === 'storage_conflict') return { ok: false, errorCode: 'conflict', error: 'conflict' };
          expect(decideApprovalRequestTransition(stored, request)).toMatchObject({ ok: true });
          stored = ApprovalRequestV2Schema.parse(request); return { ok: true };
        },
        workspaceSyncRelationshipObserveCreation: async request => {
          observations += 1;
          // The transport routes by the local profile, not the portable Home identity.
          expect(request).toMatchObject({ operationId: 'admitted-request', input: original.actionArgs, serverId: 'profile' });
          if (scenario === 'offline') throw new Error('Peer offline');
          return scenario === 'absent' ? { outcome: 'failed', errorCode: 'workspace_sync_relationship_not_committed' }
            : { outcome: 'succeeded', relationshipId: 'relationship', controllerMachineId: 'controller',
              sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'copy' };
        },
      },
    });
    if (scenario === 'foreign_session') {
      expect(result).toMatchObject({ ok: false, errorCode: 'approval_not_found' });
      expect(observations).toBe(0);
    } else {
      const status = scenario === 'present' ? 'executed' : scenario === 'absent' ? 'failed' : 'outcome_unknown';
      expect(result).toMatchObject({ ok: true, result: { request: { status } } });
      expect(stored.status).toBe(status);
      expect(stored.decision).toEqual(original.decision);
    }
  }
});
