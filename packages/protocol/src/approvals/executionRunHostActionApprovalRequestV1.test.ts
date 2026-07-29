import { describe, expect, it } from 'vitest';

import { ExecutionRunHostActionApprovalRequestV1Schema } from './executionRunHostActionApprovalRequestV1.js';

function request() {
  return {
    v: 1,
    kind: 'execution_run_host_action',
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'session-1' },
    requestedSurface: 'agent',
    actionId: 'reviews.comments.create',
    sessionId: 'session-1',
    runId: 'run-1',
    callId: 'call-1',
    profileId: 'acme.review/review',
    pluginId: 'acme.review',
    agentId: 'claude',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    serverId: 'server-1',
    proposalCount: 1,
    proposalPreview: [{
      findingId: 'finding-1',
      pathLabel: 'src/a.ts',
      pathSha256: 'b'.repeat(64),
      startLine: 7,
      endLine: 7,
      severity: 'warning',
      bodySha256: 'c'.repeat(64),
      bodyPreview: 'Use the canonical owner.',
    }],
    subjectFingerprint: 'a'.repeat(64),
    summary: 'Create 1 proposed review comment',
  } as const;
}

describe('ExecutionRunHostActionApprovalRequestV1Schema', () => {
  it('accepts a bounded authority-free execution-run host-action subject', () => {
    expect(ExecutionRunHostActionApprovalRequestV1Schema.parse(request())).toEqual(request());
  });

  it('rejects caller-supplied persistence authority and subject mutations', () => {
    expect(ExecutionRunHostActionApprovalRequestV1Schema.safeParse({
      ...request(),
      clientMutationId: 'caller-controlled',
    }).success).toBe(false);
    expect(ExecutionRunHostActionApprovalRequestV1Schema.safeParse({
      ...request(),
      actionId: 'plugins.reload',
    }).success).toBe(false);
    expect(ExecutionRunHostActionApprovalRequestV1Schema.safeParse({
      ...request(),
      subjectFingerprint: 'short',
    }).success).toBe(false);
  });

  it('requires a coherent terminal decision state', () => {
    const approved = {
      ...request(),
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    } as const;
    expect(ExecutionRunHostActionApprovalRequestV1Schema.parse(approved)).toEqual(approved);
    expect(ExecutionRunHostActionApprovalRequestV1Schema.safeParse({
      ...approved,
      decision: { kind: 'reject', decidedAtMs: 2 },
    }).success).toBe(false);
  });
});
