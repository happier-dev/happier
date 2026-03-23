import { describe, expect, it } from 'vitest';
import * as Protocol from './index.js';

import {
  ExecutionRunIntentSchema,
  ExecutionRunPublicStateSchema,
  ExecutionRunSendRequestSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunTransportErrorCodeSchema,
} from './executionRuns.js';
import { EphemeralTaskKindSchema } from './ephemeralTasks.js';
import { ReviewFindingSchema } from './reviews/ReviewFinding.js';
import { ReviewFollowUpInputSchema } from './reviews/reviewFollowUp.js';
import { ReviewFindingsV1Schema } from './structuredMessages/reviewFindingsV1.js';
import { ReviewFindingsV2Schema } from './structuredMessages/reviewFindingsV2.js';
import { ReviewFollowUpV1Schema } from './structuredMessages/reviewFollowUpV1.js';
import { ReviewPublishRequestV1Schema } from './structuredMessages/reviewPublishRequestV1.js';
import { PlanOutputV1Schema } from './structuredMessages/planOutputV1.js';
import { DelegateOutputV1Schema } from './structuredMessages/delegateOutputV1.js';
import { ParticipantMessageV1Schema } from './structuredMessages/participantMessageV1.js';
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
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      status: 'succeeded',
      turnInFlight: true,
      startedAtMs: now,
      finishedAtMs: now + 1,
      transcript: { persistenceMode: 'persistent', epoch: 2 },
    });
    expect(parsed.intent).toBe('review');
    expect((parsed as any).turnInFlight).toBe(true);
    expect((parsed as any).transcript).toMatchObject({ persistenceMode: 'persistent', epoch: 2 });

    expect(() => ExecutionRunPublicStateSchema.parse({
      runId: 'run_1',
      callId: 'subagent_run_1',
      sidechainId: 'subagent_run_1',
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      status: 'succeeded',
      startedAtMs: now,
    })).toThrow();
  });

  it('validates start request', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });
    expect(parsed.intent).toBe('review');
  });

  it('validates optional voice replay seed requests on start requests', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      initialContextMode: 'first_turn',
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
        transcriptEpoch: 3,
        strategy: 'summary_plus_recent',
        recentMessagesCount: 16,
      },
    }) as any;
    expect(parsed.replay).toMatchObject({
      kind: 'voice_session.v1',
      previousSessionId: 'sess_voice',
      transcriptEpoch: 3,
    });
    expect((parsed as any).initialContextMode).toBe('first_turn');

    expect(() => ExecutionRunStartRequestSchema.parse({
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
      },
    })).toThrow();
  });

  it('validates optional resumeHandle on start requests', () => {
    expect(() => ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: { kind: 'vendor_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } },
    })).toThrow();

    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: {
        kind: 'vendor_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        vendorSessionId: 'vendor_1',
      },
    }) as any;
    expect(parsed.resumeHandle?.kind).toBe('vendor_session.v1');
  });

  it('accepts legacy backendId fields in resume handles', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: {
        kind: 'vendor_session.v1',
        backendId: 'codex',
        vendorSessionId: 'vendor_1',
      },
    }) as any;

    expect(parsed.resumeHandle).toMatchObject({
      kind: 'vendor_session.v1',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      vendorSessionId: 'vendor_1',
    });
  });

  it('validates optional display fields for group-chat future-proofing', () => {
    expect(() => ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      display: 123,
    })).toThrow();

    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
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
      whyItMatters: 'This could hide a real failure.',
      evidence: 'Observed in unit test output.',
      confidence: 0.8,
    });
    expect(parsed.id).toBe('f1');
    expect(parsed.confidence).toBe(0.8);
  });

  it('validates review_findings.v1 structured payload', () => {
    const now = Date.now();
    const parsed = ReviewFindingsV1Schema.parse({
      runRef: {
        runId: 'run_1',
        callId: 'subagent_run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        retentionPolicy: 'resumable',
      },
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

  it('validates review_findings.v2 structured payload', () => {
    const now = Date.now();
    const parsed = ReviewFindingsV2Schema.parse({
      runRef: {
        runId: 'run_1',
        callId: 'subagent_run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        retentionPolicy: 'resumable',
      },
      summary: 'Summary.',
      overviewMarkdown: '## Overview\n\nThis needs attention.',
      findings: [
        {
          id: 'f1',
          title: 'Example',
          severity: 'low',
          category: 'style',
          summary: 'One paragraph.',
          whyItMatters: 'Consistency matters here.',
          evidence: 'The old branch handles this differently.',
          confidence: 0.6,
        },
      ],
      questions: [{ id: 'q1', text: 'Should this support empty input?', status: 'open', findingIds: ['f1'] }],
      assumptions: [{ id: 'a1', text: 'Assumed strict mode is enabled.', findingIds: ['f1'] }],
      publication: { findings: [{ id: 'f1', published: false }] },
      generatedAtMs: now,
    });
    expect(parsed.overviewMarkdown).toContain('Overview');
    expect(parsed.questions[0]?.status).toBe('open');
    expect(parsed.findings[0]?.confidence).toBe(0.6);
  });

  it('validates review_follow_up.v1 structured payload', () => {
    const now = Date.now();
    const parsed = ReviewFollowUpV1Schema.parse({
      parentRunRef: { runId: 'run_1', callId: 'subagent_run_1', backendId: 'claude' },
      threadId: 'thread_1',
      findingIds: ['f1'],
      requestMarkdown: 'Can you clarify why this is risky?',
      answerMarkdown: 'Yes. It breaks when the input is null.',
      updatedFindings: [
        {
          id: 'f1',
          title: 'Example',
          severity: 'medium',
          category: 'correctness',
          summary: 'Updated summary.',
          whyItMatters: 'Null input now crashes.',
          evidence: 'Reproduced with `null` in local test.',
          confidence: 0.9,
        },
      ],
      questions: [{ id: 'q2', text: 'Is null input allowed by product requirements?', status: 'open' }],
      assumptions: [{ id: 'a1', text: 'Assumed null can reach this path.' }],
      generatedAtMs: now,
    });
    expect(parsed.threadId).toBe('thread_1');
    expect(parsed.updatedFindings?.[0]?.confidence).toBe(0.9);
  });

  it('validates review_publish_request.v1 structured payload', () => {
    const parsed = ReviewPublishRequestV1Schema.parse({
      sourceRunRef: { runId: 'run_1', callId: 'subagent_run_1', backendId: 'claude' },
      findingIds: ['f1'],
      publishedFindings: [
        {
          id: 'f1',
          title: 'Example',
          severity: 'medium',
          category: 'correctness',
          summary: 'Ship this fix.',
          whyItMatters: 'It crashes production input.',
          evidence: 'Reproduced locally.',
          confidence: 0.95,
        },
      ],
      threadRefs: ['thread_1'],
    });
    expect(parsed.publishedFindings[0]?.id).toBe('f1');
  });

  it('validates review follow-up action input', () => {
    const parsed = ReviewFollowUpInputSchema.parse({
      findingIds: ['f1'],
      threadId: 'thread_1',
      replyToQuestionId: 'q1',
      messageMarkdown: 'Here is the missing context.',
    });
    expect(parsed.replyToQuestionId).toBe('q1');
    expect(parsed.findingIds).toEqual(['f1']);
  });

  it('validates plan_output.v1 structured payload', () => {
    const now = Date.now();
    const parsed = PlanOutputV1Schema.parse({
      runRef: {
        runId: 'run_1',
        callId: 'subagent_run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
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
      runRef: {
        runId: 'run_1',
        callId: 'subagent_run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
      summary: 'Delegation summary.',
      deliverables: [
        { id: 'd1', title: 'Deliverable 1', details: 'Do it' },
      ],
      generatedAtMs: now,
    });
    expect(parsed.deliverables).toHaveLength(1);
  });

  it('keeps legacy structured runRef payloads parseable without backendTarget', () => {
    const now = Date.now();
    const parsed = ReviewFindingsV2Schema.parse({
      runRef: { runId: 'run_1', callId: 'subagent_run_1', backendId: 'claude' },
      summary: 'Summary.',
      overviewMarkdown: '## Overview',
      findings: [],
      generatedAtMs: now,
    });

    expect(parsed.runRef.backendId).toBe('claude');
    expect((parsed.runRef as any).backendTarget).toBeUndefined();
  });

  it('adds SubAgent to known canonical tool names', () => {
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('SubAgent' as any)).toBe(true);
  });

  it('adds SubAgentRun to known canonical tool names', () => {
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('SubAgentRun' as any)).toBe(true);
  });

  it('adds Agent Team tools to known canonical tool names', () => {
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('AgentTeamCreate' as any)).toBe(true);
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('AgentTeamDelete' as any)).toBe(true);
    expect(KNOWN_CANONICAL_TOOL_NAMES_V2.includes('AgentTeamSendMessage' as any)).toBe(true);
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

  it('validates optional delivery on send requests', () => {
    const parsed = ExecutionRunSendRequestSchema.parse({
      runId: 'run_1',
      message: 'steer me',
      delivery: 'steer_if_supported',
    });
    expect((parsed as any).delivery).toBe('steer_if_supported');

    // Back-compat: missing delivery remains valid.
    expect(() => ExecutionRunSendRequestSchema.parse({ runId: 'run_1', message: 'hi' })).not.toThrow();
  });

  it('validates participant_message.v1 meta payload', () => {
    expect(() => ParticipantMessageV1Schema.parse({
      recipient: { kind: 'execution_run', runId: 'run_1' },
    })).not.toThrow();
    expect(() => ParticipantMessageV1Schema.parse({
      recipient: { kind: 'agent_team_member', teamId: 'probe', memberId: 'alpha@probe' },
    })).not.toThrow();
    expect(() => ParticipantMessageV1Schema.parse({
      recipient: { kind: 'agent_team_broadcast', teamId: 'probe' },
    })).not.toThrow();
  });

  it('exports and validates subagent_launch.v1 meta payload', () => {
    expect('SubagentLaunchV1Schema' in Protocol).toBe(true);
    const schema = (Protocol as { SubagentLaunchV1Schema: { parse: (value: unknown) => unknown } }).SubagentLaunchV1Schema;

    expect(() => schema.parse({
      kind: 'agent_team_create',
      teamId: 'team_1',
      description: 'Coordinate work',
    })).not.toThrow();

    expect(() => schema.parse({
      kind: 'agent_team_member_create',
      teamId: 'team_1',
      memberLabel: 'Alice',
      instructions: 'Review the routing changes',
      runInBackground: true,
    })).not.toThrow();
  });

  it('exports and validates subagent_command.v1 meta payload', () => {
    expect('SubagentCommandV1Schema' in Protocol).toBe(true);
    const schema = (Protocol as { SubagentCommandV1Schema: { parse: (value: unknown) => unknown } }).SubagentCommandV1Schema;

    expect(() => schema.parse({
      kind: 'agent_team_delete',
      teamId: 'team_1',
    })).not.toThrow();

    expect(() => schema.parse({
      kind: 'agent_team_member_delete',
      teamId: 'team_1',
      memberId: 'alice@team_1',
      memberLabel: 'Alice',
    })).not.toThrow();
  });
});
