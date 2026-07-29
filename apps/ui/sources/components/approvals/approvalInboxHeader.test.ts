import { describe, expect, it } from 'vitest';

import { isOpenApprovalInboxArtifact } from './approvalInboxHeader';

function artifact(header: Record<string, unknown>) {
  return { id: 'a1', header } as never;
}

describe('isOpenApprovalInboxArtifact', () => {
  it('admits bounded target headers and rejects malformed or oversized copies', () => {
    expect(isOpenApprovalInboxArtifact(artifact({
      kind: 'target_action_approval.v1', approvalStatus: 'open', title: 'Publish',
      qualifiedActionId: 'acme.publisher/actions/releases/publish', subjectFingerprint: 'a'.repeat(64),
    }))).toBe(true);
    expect(isOpenApprovalInboxArtifact(artifact({
      kind: 'target_action_approval.v1', approvalStatus: 'open', title: 'Publish',
      qualifiedActionId: 'not-qualified', subjectFingerprint: 'a'.repeat(64),
    }))).toBe(false);
    expect(isOpenApprovalInboxArtifact(artifact({
      kind: 'target_action_approval.v1', approvalStatus: 'open', title: 'x'.repeat(1_025),
      qualifiedActionId: 'acme.publisher/actions/releases/publish', subjectFingerprint: 'a'.repeat(64),
    }))).toBe(false);
  });

  it('preserves the existing open built-in approval admission', () => {
    expect(isOpenApprovalInboxArtifact(artifact({ kind: 'approval_request.v1', approvalStatus: 'open' }))).toBe(true);
    expect(isOpenApprovalInboxArtifact(artifact({ kind: 'approval_request.v1', approvalStatus: 'approved' }))).toBe(false);
  });

  it('admits only coherent execution-run host-action headers', () => {
    expect(isOpenApprovalInboxArtifact(artifact({
      kind: 'execution_run_host_action_approval.v1', approvalStatus: 'open',
      title: 'Create 1 proposed review comment', actionId: 'reviews.comments.create',
      sessionId: 'session-1', runId: 'run-1', subjectFingerprint: 'a'.repeat(64), serverId: 'server-1',
    }))).toBe(true);
    expect(isOpenApprovalInboxArtifact(artifact({
      kind: 'execution_run_host_action_approval.v1', approvalStatus: 'open',
      title: 'Create 1 proposed review comment', actionId: 'plugins.reload',
      sessionId: 'session-1', runId: 'run-1', subjectFingerprint: 'a'.repeat(64), serverId: 'server-1',
    }))).toBe(false);
  });
});
