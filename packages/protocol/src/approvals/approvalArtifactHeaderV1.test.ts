import { describe, expect, it } from 'vitest';

import { ApprovalRequestV2Schema } from './approvalRequestV1.js';
import {
  approvalArtifactBodyMatchesHeaderV1,
  buildApprovalRequestArtifactHeaderV1,
  buildExecutionRunHostActionApprovalArtifactHeaderV1,
  buildTargetActionApprovalArtifactHeaderV1,
} from './approvalArtifactHeaderV1.js';
import { ExecutionRunHostActionApprovalRequestV1Schema } from './executionRunHostActionApprovalRequestV1.js';
import { TargetActionApprovalRequestV1Schema } from './targetActionApprovalRequestV1.js';

describe('approval Artifact header correspondence', () => {
  const builtIn = ApprovalRequestV2Schema.parse({
    v: 2,
    status: 'executing',
    createdAtMs: 1,
    updatedAtMs: 2,
    createdBy: { surface: 'agent', sessionId: 'session-1' },
    requestedSurface: 'agent',
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'agent',
      caller: { kind: 'host' },
      serverId: 'profile-1',
      serverIdentityId: 'server-identity-1',
      accountId: 'account-1',
      sessionId: 'session-1',
      machineId: 'machine-1',
      runId: 'run-1',
      runOccurrenceId: 'occurrence-1',
      actionId: 'session.title.set',
      requestId: 'request-1',
    },
    actionId: 'session.title.set',
    actionArgs: { sessionId: 'session-1', title: 'Approved' },
    summary: 'Set title',
    decision: { kind: 'approve', decidedAtMs: 2 },
  });

  const target = TargetActionApprovalRequestV1Schema.parse({
    v: 1,
    kind: 'plugin_target_action',
    status: 'executing',
    createdAtMs: 1,
    updatedAtMs: 2,
    createdBy: { surface: 'system' },
    requestedSurface: 'api',
    qualifiedActionId: 'acme.publisher/actions/releases/publish',
    input: {},
    sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-1', installSource: 'npm' },
    policyFingerprint: 'a'.repeat(64),
    subjectFingerprint: 'b'.repeat(64),
    replayPlacement: { serverId: 'profile-1', machineId: 'machine-1', defaultSessionId: 'session-1' },
    executionOriginV1: {
      v: 1,
      authority: 'account_automation',
      surface: 'api',
      caller: { kind: 'host' },
      serverId: 'profile-1',
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      sessionId: 'session-1',
      machineId: 'machine-1',
      target: { kind: 'session', sessionId: 'session-1' },
      actionId: 'action.invoke',
      requestId: 'request-1',
    },
    summary: 'Publish',
    decision: { kind: 'approve', decidedAtMs: 2 },
  });

  const host = ExecutionRunHostActionApprovalRequestV1Schema.parse({
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
    profileId: 'profile-1',
    pluginId: 'plugin-1',
    agentId: 'agent-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    serverId: 'server-1',
    proposalCount: 1,
    proposalPreview: [{
      pathLabel: 'src/a.ts',
      pathSha256: 'c'.repeat(64),
      bodySha256: 'd'.repeat(64),
      bodyPreview: 'Change',
    }],
    subjectFingerprint: 'e'.repeat(64),
    summary: 'Create review comment',
  });

  it.each([
    ['built-in kind', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'kind'],
    ['built-in status', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'approvalStatus'],
    ['built-in session list', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'sessions'],
    ['built-in server identity', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'serverIdentityId'],
    ['built-in profile', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'serverId'],
    ['built-in machine', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'machineId'],
    ['built-in run', 'built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), 'runId'],
    ['target action id', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'qualifiedActionId'],
    ['target subject', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'subjectFingerprint'],
    ['target machine', 'target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), 'machineId'],
    ['host profile', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'profileId'],
    ['host server', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'serverId'],
    ['host run', 'execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), 'runId'],
  ] as const)('fails closed for a contradictory %s header', (_label, family, request, header, field) => {
    const body = JSON.stringify(request);
    expect(approvalArtifactBodyMatchesHeaderV1(header, body)).toEqual({ family, request });
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, [field]: 'contradiction' }, body)).toBeNull();
  });

  it('rejects an unhydrated or wrong-family body instead of trusting the index header', () => {
    const header = buildApprovalRequestArtifactHeaderV1(builtIn);
    expect(approvalArtifactBodyMatchesHeaderV1(header, null)).toBeNull();
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify(target))).toBeNull();
  });

  it.each([
    ['built_in', builtIn, buildApprovalRequestArtifactHeaderV1(builtIn), ApprovalRequestV2Schema],
    ['target_action', target, buildTargetActionApprovalArtifactHeaderV1(target), TargetActionApprovalRequestV1Schema],
    ['execution_run_host_action', host, buildExecutionRunHostActionApprovalArtifactHeaderV1(host), ExecutionRunHostActionApprovalRequestV1Schema],
  ] as const)('reads known stored %s fields while strict admission rejects unknown fields', (family, request, header, schema) => {
    const stored = { ...request, future: true, createdBy: { ...request.createdBy, future: true } };
    expect(schema.safeParse(stored).success).toBe(false);
    expect(approvalArtifactBodyMatchesHeaderV1({ ...header, future: true }, JSON.stringify(stored)))
      .toEqual({ family, request });
    expect(approvalArtifactBodyMatchesHeaderV1(header, JSON.stringify({ ...stored, status: 'unknown' }))).toBeNull();
  });
});
