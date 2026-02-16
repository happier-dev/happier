import { describe, expect, it } from 'vitest';

import {
  ExecutionRunIntentSchema,
  ExecutionRunPublicStateSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunTransportErrorCodeSchema,
} from './executionRuns.js';
import { EphemeralTaskKindSchema } from './ephemeralTasks.js';
import { ReviewFindingSchema } from './reviews/ReviewFinding.js';
import { ReviewFindingsV1Schema } from './structuredMessages/reviewFindingsV1.js';
import { PlanOutputV1Schema } from './structuredMessages/planOutputV1.js';
import { DelegateOutputV1Schema } from './structuredMessages/delegateOutputV1.js';
import { KNOWN_CANONICAL_TOOL_NAMES_V2 } from './tools/v2/names.js';

describe('executionRuns protocol', () => {
  it('parses supported intents', () => {
    expect(ExecutionRunIntentSchema.parse('review')).toBe('review');
    expect(ExecutionRunIntentSchema.parse('voice_agent')).toBe('voice_agent');
    expect(ExecutionRunIntentSchema.parse('memory_hints')).toBe('memory_hints');
  });

  it('validates public state shape', () => {
    const now = Date.now();
    const parsed = ExecutionRunPublicStateSchema.parse({
      runId: 'run_1',
      callId: 'subagent_run_1',
      sidechainId: 'subagent_run_1',
      intent: 'review',
      backendId: 'claude',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      status: 'succeeded',
      startedAtMs: now,
      finishedAtMs: now + 1,
    });
    expect(parsed.intent).toBe('review');

    expect(() => ExecutionRunPublicStateSchema.parse({
      runId: 'run_1',
      callId: 'subagent_run_1',
      sidechainId: 'subagent_run_1',
      intent: 'review',
      backendId: 'claude',
      status: 'succeeded',
      startedAtMs: now,
    })).toThrow();
  });

  it('validates start request', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(parsed.intent).toBe('review');
  });

  it('validates optional resumeHandle on start requests', () => {
    expect(() => ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude' },
    })).toThrow();

    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: { kind: 'vendor_session.v1', backendId: 'claude', vendorSessionId: 'vendor_1' },
    }) as any;
    expect(parsed.resumeHandle?.kind).toBe('vendor_session.v1');
  });

  it('validates optional display fields for group-chat future-proofing', () => {
    expect(() => ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      display: 123,
    })).toThrow();

    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendId: 'claude',
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      display: { title: 'Reviewer A', participantLabel: 'A', groupId: 'group_1' },
    });
    expect((parsed as any).display?.groupId).toBe('group_1');
  });

  it('exports ReviewFinding schema', () => {
    const parsed = ReviewFindingSchema.parse({
      id: 'f1',
      title: 'Example',
      severity: 'low',
      category: 'style',
      summary: 'One paragraph.',
    });
    expect(parsed.id).toBe('f1');
  });

  it('validates review_findings.v1 structured payload', () => {
    const now = Date.now();
    const parsed = ReviewFindingsV1Schema.parse({
      runRef: { runId: 'run_1', callId: 'subagent_run_1', backendId: 'claude' },
      summary: 'Summary.',
      findings: [
        {
          id: 'f1',
          title: 'Example',
          severity: 'low',
          category: 'style',
          summary: 'One paragraph.',
        },
      ],
      generatedAtMs: now,
    });
    expect(parsed.findings).toHaveLength(1);
  });

  it('validates plan_output.v1 structured payload', () => {
    const now = Date.now();
    const parsed = PlanOutputV1Schema.parse({
      runRef: { runId: 'run_1', callId: 'subagent_run_1', backendId: 'claude' },
      summary: 'Plan summary.',
      sections: [
        { title: 'Approach', items: ['Step 1', 'Step 2'] },
      ],
      risks: ['Risk 1'],
      milestones: [{ title: 'Milestone 1', details: 'Soon' }],
      recommendedBackendId: 'claude',
      generatedAtMs: now,
    });
    expect(parsed.sections).toHaveLength(1);
  });

  it('validates delegate_output.v1 structured payload', () => {
    const now = Date.now();
    const parsed = DelegateOutputV1Schema.parse({
      runRef: { runId: 'run_1', callId: 'subagent_run_1', backendId: 'claude' },
      summary: 'Delegation summary.',
      deliverables: [
        { id: 'd1', title: 'Deliverable 1', details: 'Do it' },
      ],
      generatedAtMs: now,
    });
    expect(parsed.deliverables).toHaveLength(1);
  });

  it('adds SubAgentRun to known canonical tool names', () => {
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('SubAgentRun' as any)).toBe(true);
  });

  it('parses supported ephemeral task kinds', () => {
    expect(EphemeralTaskKindSchema.parse('scm.commit_message')).toBe('scm.commit_message');
  });

  it('pins canonical execution-run transport error codes', () => {
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_not_allowed')).toBe('execution_run_not_allowed');
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_not_found')).toBe('execution_run_not_found');
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_action_not_supported')).toBe('execution_run_action_not_supported');
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_invalid_action_input')).toBe('execution_run_invalid_action_input');
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_stream_not_found')).toBe('execution_run_stream_not_found');
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_busy')).toBe('execution_run_busy');
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_failed')).toBe('execution_run_failed');
    expect(ExecutionRunTransportErrorCodeSchema.parse('execution_run_budget_exceeded')).toBe('execution_run_budget_exceeded');
    expect(ExecutionRunTransportErrorCodeSchema.parse('run_depth_exceeded')).toBe('run_depth_exceeded');
    expect(ExecutionRunTransportErrorCodeSchema.parse('permission_denied')).toBe('permission_denied');

    expect(() => ExecutionRunTransportErrorCodeSchema.parse('execution_run_send_failed')).toThrow();
  });
});
