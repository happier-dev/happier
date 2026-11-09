import { describe, expect, it } from 'vitest';

import { ExecutionRunStartRequestSchema } from './executionRunStartRequest.js';
import {
  EXECUTION_RUN_BUILT_IN_ROLES,
  ExecutionRunRoleSchema,
  ExecutionRunStartV2RequestSchema,
  isExecutionRunBindRoleCompatibleV1,
  readExecutionRunStartV2OnlyFieldsV1,
  verifyExecutionRunStartV2EchoV1,
} from './executionRunStartV2.js';

const hiddenStart = {
  intent: 'delegate',
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
  instructions: 'Do it.',
  permissionMode: 'workspace_write',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
} as const;

const customRole = 'custom:0b8f1a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c' as const;

describe('execution.run.start.v2 request', () => {
  it('leaves the released hidden start request byte-identical', () => {
    expect(JSON.stringify(ExecutionRunStartRequestSchema.parse(hiddenStart))).toBe(JSON.stringify(hiddenStart));
    expect(readExecutionRunStartV2OnlyFieldsV1(hiddenStart)).toEqual([]);
  });

  it('detects every v2-only field so older start entries can reject it', () => {
    expect(readExecutionRunStartV2OnlyFieldsV1({ ...hiddenStart, visibility: 'hidden' })).toEqual(['visibility']);
    expect(readExecutionRunStartV2OnlyFieldsV1({ ...hiddenStart, role: 'worker', roleSource: 'explicit', targetSessionId: 'c' }))
      .toEqual(['role', 'roleSource', 'targetSessionId']);
  });

  it('accepts visible and role-bearing starts and rejects contradictory combinations', () => {
    expect(ExecutionRunStartV2RequestSchema.parse({ ...hiddenStart, visibility: 'session', targetSessionId: 'child' }).targetSessionId).toBe('child');
    expect(ExecutionRunStartV2RequestSchema.parse({ ...hiddenStart, visibility: 'hidden', role: 'worker', roleSource: 'explicit' }).role).toBe('worker');
    for (const invalid of [
      { ...hiddenStart, visibility: 'hidden' },
      { ...hiddenStart, visibility: 'hidden', targetSessionId: 'child', role: 'worker', roleSource: 'explicit' },
      { ...hiddenStart, visibility: 'session', role: 'worker' },
      { ...hiddenStart, visibility: 'session', roleSource: 'settings' },
      { ...hiddenStart, visibility: 'session', role: 'project_lead', roleSource: 'explicit' },
      { ...hiddenStart, intent: 'voice_agent', visibility: 'session' },
      { ...hiddenStart, role: 'worker', roleSource: 'explicit' },
    ]) {
      expect(ExecutionRunStartV2RequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('offers every assignable role except project_lead on runs', () => {
    expect(EXECUTION_RUN_BUILT_IN_ROLES).toEqual(['planner', 'worker', 'reviewer']);
    expect(ExecutionRunRoleSchema.safeParse('project_lead').success).toBe(false);
    expect(ExecutionRunRoleSchema.parse(customRole)).toBe(customRole);
  });
});

describe('bind role compatibility', () => {
  it('binds only the intent role, or an explicitly requested matching custom role', () => {
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'review', childRole: 'reviewer' })).toBe(true);
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'plan', childRole: 'planner' })).toBe(true);
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'delegate', childRole: 'worker' })).toBe(true);
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'delegate', childRole: 'reviewer' })).toBe(false);
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'delegate', requestedRole: 'reviewer', childRole: 'reviewer' })).toBe(false);
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'review', childRole: null })).toBe(false);
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'review', childRole: customRole })).toBe(false);
    expect(isExecutionRunBindRoleCompatibleV1({ intent: 'review', requestedRole: customRole, childRole: customRole })).toBe(true);
  });
});

describe('verifyExecutionRunStartV2EchoV1', () => {
  const base = { runId: 'run_1', callId: 'call_1', sidechainId: 'call_1', permissionMode: 'read_only', modelId: null };
  const role = { id: 'reviewer', name: 'Reviewer', assignmentId: 'a1' };

  it('accepts a created or reused visible run whose echo matches the request', () => {
    expect(verifyExecutionRunStartV2EchoV1({
      request: { visibility: 'session', role: 'reviewer', roleSource: 'explicit' },
      response: { ...base, visibility: 'session', binding: 'created', linkedSessionId: 'child', role, roleSource: 'explicit' },
    }).ok).toBe(true);
    expect(verifyExecutionRunStartV2EchoV1({
      request: { visibility: 'session', targetSessionId: 'child' },
      response: { ...base, visibility: 'session', binding: 'reused', linkedSessionId: 'child', role: null, roleSource: 'none' },
    }).ok).toBe(true);
    expect(verifyExecutionRunStartV2EchoV1({
      request: { visibility: 'hidden', role: 'reviewer', roleSource: 'settings' },
      response: { ...base, visibility: 'hidden', binding: null, linkedSessionId: null, role, roleSource: 'settings' },
    }).ok).toBe(true);
  });

  it('treats a missing or mismatched echo as an unassigned run with a typed error', () => {
    expect(verifyExecutionRunStartV2EchoV1({ request: { visibility: 'session' }, response: base }))
      .toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_visibility_unsupported', runId: 'run_1' }));
    expect(verifyExecutionRunStartV2EchoV1({ request: { visibility: 'hidden', role: 'reviewer', roleSource: 'explicit' }, response: base }))
      .toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_role_unsupported' }));
    expect(verifyExecutionRunStartV2EchoV1({
      request: { visibility: 'session', targetSessionId: 'child' },
      response: { ...base, visibility: 'session', binding: 'reused', linkedSessionId: 'other', role: null, roleSource: 'none' },
    }).ok).toBe(false);
    expect(verifyExecutionRunStartV2EchoV1({
      request: { visibility: 'session', role: 'reviewer', roleSource: 'explicit' },
      response: { ...base, visibility: 'session', binding: 'created', linkedSessionId: 'child', role: { ...role, id: 'worker' }, roleSource: 'explicit' },
    })).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_role_unsupported' }));
    expect(verifyExecutionRunStartV2EchoV1({
      request: { visibility: 'session', modelId: 'm1' },
      response: { ...base, visibility: 'session', binding: 'created', linkedSessionId: 'child', role: null, roleSource: 'none', modelId: 'm2' },
    }).ok).toBe(false);
  });
});

describe('execution run public state (R21 delivery records)', () => {
  it('carries the linked child delivery records for execution.run.get and stays readable for older producers', async () => {
    const { ExecutionRunPublicStateSchema } = await import('./executionRuns.js');
    const base = {
      runId: 'run_1', callId: 'call_1', sidechainId: 'call_1', intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
      retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'streaming', status: 'succeeded', startedAtMs: 1,
    };
    expect(ExecutionRunPublicStateSchema.safeParse(base).success).toBe(true);
    const linkState = {
      report: { turnEpoch: 1, reportedAt: 5, ack: 'accepted', attempts: 1 },
      relay: { turnEpoch: 1, status: 'queued', localId: 'l1', at: 6 },
      delivery: { turnEpoch: 1, status: 'verified', localId: 'l1', transcriptSeq: 9, verifiedAt: 7 },
    };
    const parsed = ExecutionRunPublicStateSchema.parse({ ...base, visibility: 'session', binding: 'reused', linkedSessionId: 'child', linkState });
    expect(parsed.linkState).toEqual(linkState);
  });
});

describe('resolveExecutionRunStartV2UnsupportedErrorCodeV1', () => {
  it('reports a visibility error for visible or child-naming requests and a role error otherwise', async () => {
    const { resolveExecutionRunStartV2UnsupportedErrorCodeV1 } = await import('./executionRunStartV2.js');
    expect(resolveExecutionRunStartV2UnsupportedErrorCodeV1({ visibility: 'session' })).toBe('execution_run_visibility_unsupported');
    expect(resolveExecutionRunStartV2UnsupportedErrorCodeV1({ targetSessionId: 'c' })).toBe('execution_run_visibility_unsupported');
    expect(resolveExecutionRunStartV2UnsupportedErrorCodeV1({ visibility: 'hidden' })).toBe('execution_run_visibility_unsupported');
    expect(resolveExecutionRunStartV2UnsupportedErrorCodeV1({ visibility: 'hidden', role: 'worker' })).toBe('execution_run_role_unsupported');
    expect(resolveExecutionRunStartV2UnsupportedErrorCodeV1({ roleSource: 'explicit' })).toBe('execution_run_role_unsupported');
  });
});
