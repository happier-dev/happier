import { describe, expect, it } from 'vitest';
import {
  ApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
  ExecutionRunHostActionApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import {
  TargetActionApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import {
  buildApprovalRequestArtifactHeaderV1,
  buildExecutionRunHostActionApprovalArtifactHeaderV1,
  buildTargetActionApprovalArtifactHeaderV1,
} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';

import { isOpenApprovalInboxArtifact } from './approvalInboxHeader';

function artifact(header: Record<string, unknown>, body?: unknown) {
  return { id: 'a1', header, body: body === undefined ? undefined : JSON.stringify(body) } as never;
}

describe('isOpenApprovalInboxArtifact', () => {
  const target = TargetActionApprovalRequestV1Schema.parse({
    v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'system' }, requestedSurface: 'ui',
    qualifiedActionId: 'acme.publisher/actions/releases/publish', input: null,
    sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
    policyFingerprint: '0'.repeat(64), subjectFingerprint: 'a'.repeat(64),
    summary: 'Publish',
  });
  const host = ExecutionRunHostActionApprovalRequestV1Schema.parse({
    v: 1, kind: 'execution_run_host_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
    actionId: 'reviews.comments.create', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
    profileId: 'profile-1', pluginId: 'plugin-1', agentId: 'agent-1', projectId: 'project-1',
    workspaceId: 'workspace-1', serverId: 'server-1', proposalCount: 1,
    proposalPreview: [{ pathLabel: 'src/a.ts', pathSha256: 'b'.repeat(64), bodySha256: 'c'.repeat(64), bodyPreview: 'Change' }],
    subjectFingerprint: 'd'.repeat(64), summary: 'Create 1 proposed review comment',
  });

  it('requires a hydrated body that corresponds exactly to a target-action header', () => {
    const header = buildTargetActionApprovalArtifactHeaderV1(target);
    expect(isOpenApprovalInboxArtifact(artifact(header, target))).toBe(true);
    expect(isOpenApprovalInboxArtifact(artifact(header))).toBe(false);
    expect(isOpenApprovalInboxArtifact(artifact({ ...header, subjectFingerprint: 'e'.repeat(64) }, target))).toBe(false);
  });

  it('preserves coherent open built-in approval admission', () => {
    const request = ApprovalRequestV1Schema.parse({
      v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' },
      actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
    });
    const header = buildApprovalRequestArtifactHeaderV1(request);
    expect(isOpenApprovalInboxArtifact(artifact(header, request))).toBe(true);
    expect(isOpenApprovalInboxArtifact(artifact({ ...header, approvalStatus: 'approved' }, request))).toBe(false);
  });

  it('admits only coherent execution-run host-action Artifacts', () => {
    const header = buildExecutionRunHostActionApprovalArtifactHeaderV1(host);
    expect(isOpenApprovalInboxArtifact(artifact(header, host))).toBe(true);
    expect(isOpenApprovalInboxArtifact(artifact({ ...header, profileId: 'other-profile' }, host))).toBe(false);
  });
});
