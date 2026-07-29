import {
  ExecutionRunHostActionApprovalRequestV1Schema,
  TargetActionApprovalRequestV1Schema,
} from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

export function isOpenApprovalInboxArtifact(artifact: DecryptedArtifact): boolean {
  const header = artifact.header;
  if (header?.approvalStatus !== 'open') return false;
  if (header.kind === 'approval_request.v1') return true;
  if (header.kind === 'execution_run_host_action_approval.v1') {
    return ExecutionRunHostActionApprovalRequestV1Schema.safeParse({
      v: 1,
      kind: 'execution_run_host_action',
      status: 'open',
      createdAtMs: 0,
      updatedAtMs: 0,
      createdBy: { surface: 'agent', sessionId: header.sessionId },
      requestedSurface: 'agent',
      actionId: header.actionId,
      sessionId: header.sessionId,
      runId: header.runId,
      callId: 'inbox-header-validation',
      profileId: 'inbox-header-validation',
      pluginId: 'inbox-header-validation',
      agentId: 'inbox-header-validation',
      projectId: 'inbox-header-validation',
      workspaceId: 'inbox-header-validation',
      serverId: header.serverId,
      proposalCount: 1,
      proposalPreview: [{
        pathLabel: 'inbox-header-validation',
        pathSha256: '0'.repeat(64),
        bodySha256: '0'.repeat(64),
        bodyPreview: 'inbox-header-validation',
      }],
      subjectFingerprint: header.subjectFingerprint,
      summary: header.title,
    }).success;
  }
  if (header.kind !== 'target_action_approval.v1') return false;

  return TargetActionApprovalRequestV1Schema.safeParse({
    v: 1,
    kind: 'plugin_target_action',
    status: 'open',
    createdAtMs: 0,
    updatedAtMs: 0,
    createdBy: { surface: 'system' },
    requestedSurface: 'ui',
    qualifiedActionId: header.qualifiedActionId,
    input: null,
    generation: 'inbox-header-validation',
    policyFingerprint: '0'.repeat(64),
    subjectFingerprint: header.subjectFingerprint,
    summary: header.title,
  }).success;
}
