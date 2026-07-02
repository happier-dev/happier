import { describe, expect, it } from 'vitest';
import * as Protocol from './index.js';

import {
  ExecutionRunIntentSchema,
  ExecutionRunActionRequestSchema,
  ExecutionRunPublicStateSchema,
  ExecutionRunListRequestSchema,
  ExecutionRunSendRequestSchema,
  ExecutionRunStartRequestSchema,
  ExecutionRunTransportErrorCodeSchema,
} from './executionRuns.js';
import { ReviewFindingSchema } from './reviews/ReviewFinding.js';
import { ReviewFollowUpInputSchema } from './reviews/reviewFollowUp.js';
import { ReviewFindingsV1Schema } from './structuredMessages/reviewFindingsV1.js';
import { ReviewFindingsV2Schema } from './structuredMessages/reviewFindingsV2.js';
import { ReviewFollowUpV1Schema } from './structuredMessages/reviewFollowUpV1.js';
import { ReviewPublishRequestV1Schema } from './structuredMessages/reviewPublishRequestV1.js';
import { ExecutionRunStructuredRunRefSchema } from './structuredMessages/executionRunStructuredRunRef.js';
import { PlanOutputV1Schema } from './structuredMessages/planOutputV1.js';
import { DelegateOutputV1Schema } from './structuredMessages/delegateOutputV1.js';
import { ParticipantMessageV1Schema } from './structuredMessages/participantMessageV1.js';
import { KNOWN_CANONICAL_TOOL_NAMES_V2 } from './tools/v2/names.js';

describe('executionRuns protocol', () => {
  it('parses supported intents', () => {
    expect(ExecutionRunIntentSchema.parse('review')).toBe('review');
    expect(ExecutionRunIntentSchema.parse('voice_agent')).toBe('voice_agent');
    expect(ExecutionRunIntentSchema.parse('memory_hints')).toBe('memory_hints');
    expect(ExecutionRunIntentSchema.parse('scm_commit_message')).toBe('scm_commit_message');
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
      futurePublicStateFlag: 'state-extra',
    });
    expect(parsed.intent).toBe('review');
    expect((parsed as any).turnInFlight).toBe(true);
    expect((parsed as any).transcript).toMatchObject({ persistenceMode: 'persistent', epoch: 2 });
    expect((parsed as any).futurePublicStateFlag).toBe('state-extra');

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

  it('preserves additive fields on execution run list requests', () => {
    const parsed = ExecutionRunListRequestSchema.parse({
      backendId: 'claude',
      status: 'running',
      limit: 5,
      futureListFlag: 'keep-me',
    });

    expect(parsed).toMatchObject({
      backendId: 'claude',
      status: 'running',
      limit: 5,
    });
    expect((parsed as any).futureListFlag).toBe('keep-me');
  });

  it('accepts canonical V2 backendTarget inputs on execution run list requests', () => {
    const parsed = ExecutionRunListRequestSchema.parse({
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      status: 'running',
      limit: 5,
    });

    expect(parsed).toMatchObject({
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      status: 'running',
      limit: 5,
    });
  });

  it('preserves additive fields on execution run action requests', () => {
    const parsed = ExecutionRunActionRequestSchema.parse({
      runId: 'run_1',
      actionId: 'session.message.send',
      input: { message: 'Continue.' },
      futureActionFlag: 'keep-me',
    });

    expect(parsed).toMatchObject({
      runId: 'run_1',
      actionId: 'session.message.send',
      input: { message: 'Continue.' },
    });
    expect((parsed as any).futureActionFlag).toBe('keep-me');
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
      futureRunFlag: 'run-extra',
    });
    expect(parsed.intent).toBe('review');
    expect((parsed as any).futureRunFlag).toBe('run-extra');
  });

  it('validates scm_commit_message.v1 start requests as bounded read-only execution runs', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      kind: 'scm_commit_message.v1',
      intent: 'scm_commit_message',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'no_tools',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      intentInput: {
        instructions: 'Use conventional commits.',
        scope: { kind: 'paths', include: ['a.txt'] },
      },
    });

    expect(parsed.kind).toBe('scm_commit_message.v1');
    expect(parsed.intent).toBe('scm_commit_message');
  });

  it('validates scm_diff_summary.v1 start requests as bounded read-only execution runs', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      kind: 'scm_diff_summary.v1',
      intent: 'scm_diff_summary',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      intentInput: {
        cwd: '/repo',
        source: { kind: 'turnCheckpoint' },
        turnId: 'turn-1',
        checkpointReceiptId: 'checkpoint.diff_computed',
        turnChangeSet: {
          sessionId: 'sess-1',
          turnId: 'turn-1',
          seqRange: { startSeqInclusive: 10, endSeqInclusive: 12 },
          status: 'completed',
          provider: 'codex',
          derivedAt: 1,
          files: [{
            filePath: 'src/a.ts',
            changeKind: 'modified',
            source: 'scm_checkpoint',
            confidence: 'exact',
            provider: 'codex',
            unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n',
          }],
          repositoryCheckpoint: {
            version: 1,
            scopeId: 'scope-1',
            baseRefSource: 'turn_start',
            contentConfidence: 'exact',
            attributionScope: 'shared_worktree',
            receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/1' }],
          },
        },
      },
    });

    expect(parsed.kind).toBe('scm_diff_summary.v1');
    expect(parsed.intent).toBe('scm_diff_summary');
  });

  it('rejects scm_diff_summary.v1 checkpoint starts without TurnChangeSet evidence', () => {
    expect(() =>
      ExecutionRunStartRequestSchema.parse({
        kind: 'scm_diff_summary.v1',
        intent: 'scm_diff_summary',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        intentInput: {
          cwd: '/repo',
          source: { kind: 'turnCheckpoint' },
          turnId: 'turn-1',
          checkpointReceiptId: 'checkpoint.diff_computed',
        },
      }),
    ).toThrow();
  });

  it('rejects write-capable scm_commit_message.v1 start requests', () => {
    expect(() =>
      ExecutionRunStartRequestSchema.parse({
        kind: 'scm_commit_message.v1',
        intent: 'scm_commit_message',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        permissionMode: 'workspace_write',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      }),
    ).toThrow();
  });

  it('rejects legacy ephemeral task run wrappers as execution-run starts', () => {
    expect(ExecutionRunStartRequestSchema.safeParse({
      kind: 'scm.commit_message',
      sessionId: 'sess_1',
      input: { backendId: 'claude' },
      permissionMode: 'no_tools',
    }).success).toBe(false);
  });

  it('accepts V2 backendTarget input on start requests and preserves the canonical backend transport shape', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'claude',
      sourceKind: 'built_in',
    });
  });

  it('rejects start requests that use builtIn customAcp as a concrete backend target', () => {
    expect(() =>
      ExecutionRunStartRequestSchema.parse({
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      }),
    ).toThrow();
  });

  it('rejects start requests that use legacy configured ACP flavor carriers as concrete backend ids', () => {
    expect(() =>
      ExecutionRunStartRequestSchema.parse({
        intent: 'review',
        backendId: 'acp:review-bot',
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
      } as any),
    ).toThrow();
  });

  it('accepts V2 configured backend targets in resume handles and preserves canonical backend transport shape', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          configuredBackendId: 'review-bot',
          sourceKind: 'configured',
        },
        providerSessionId: 'vendor_1',
      },
    }) as any;

    expect(parsed.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      providerSessionId: 'vendor_1',
    });
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
        futureReplayFlag: 'keep-me',
      },
    }) as any;
    expect(parsed.replay).toMatchObject({
      kind: 'voice_session.v1',
      previousSessionId: 'sess_voice',
      transcriptEpoch: 3,
    });
    expect((parsed as any).initialContextMode).toBe('first_turn');
    expect((parsed.replay as any).futureReplayFlag).toBe('keep-me');

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

  it('accepts voice-agent initial context and bootstrap mode fields on start requests', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'voice_agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'long_lived',
      ioMode: 'streaming',
      initialContext: 'Resume with the latest summary.',
      bootstrapMode: 'ready_handshake',
      replay: {
        kind: 'voice_session.v1',
        previousSessionId: 'sess_voice',
        transcriptEpoch: 3,
      },
    }) as any;

    expect(parsed.initialContext).toBe('Resume with the latest summary.');
    expect(parsed.bootstrapMode).toBe('ready_handshake');
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
      resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'builtInAgent', agentId: 'claude' } },
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
        kind: 'provider_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        providerSessionId: 'vendor_1',
      },
    }) as any;
    expect(parsed.resumeHandle?.kind).toBe('provider_session.v1');
  });

  it('accepts legacy vendorSessionId input on resume handles as provider session identity compatibility', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: {
        kind: 'provider_session.v1',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        vendorSessionId: 'legacy-provider-session',
      },
    });

    expect(parsed.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      providerSessionId: 'legacy-provider-session',
    });
    expect(Object.prototype.hasOwnProperty.call(parsed.resumeHandle, 'vendorSessionId')).toBe(false);
  });

  it('accepts legacy vendor_session.v1 resume handle kind as provider_session.v1 read compatibility', () => {
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
        providerSessionId: 'legacy-kind-session',
      },
    });

    expect(parsed.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      providerSessionId: 'legacy-kind-session',
    });
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
        kind: 'provider_session.v1',
        backendId: 'codex',
        providerSessionId: 'vendor_1',
      },
    }) as any;

    expect(parsed.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      providerSessionId: 'vendor_1',
    });
  });

  it('accepts legacy configured backend provenance in resume handles', () => {
    const parsed = ExecutionRunStartRequestSchema.parse({
      intent: 'review',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      instructions: 'Review.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      runClass: 'bounded',
      ioMode: 'request_response',
      resumeHandle: {
        kind: 'provider_session.v1',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
        providerSessionId: 'vendor_1',
      },
    }) as any;

    expect(parsed.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      providerSessionId: 'vendor_1',
    });
  });

  it('rejects ambiguous customAcp legacy backendId fields in resume handles', () => {
    expect(() =>
      ExecutionRunStartRequestSchema.parse({
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'bounded',
        ioMode: 'request_response',
        resumeHandle: {
          kind: 'provider_session.v1',
          backendId: 'customAcp',
          providerSessionId: 'vendor_1',
        },
      }),
    ).toThrow();
  });

  it('rejects resume handles that use builtIn customAcp as a concrete backend target', () => {
    expect(() =>
      ExecutionRunStartRequestSchema.parse({
        intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        instructions: 'Review.',
        permissionMode: 'read_only',
        retentionPolicy: 'resumable',
        runClass: 'bounded',
        ioMode: 'request_response',
        resumeHandle: {
          kind: 'provider_session.v1',
          backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
          providerSessionId: 'vendor_1',
        },
      }),
    ).toThrow();
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
        futureRunRefField: 'keep-me',
      },
      summary: 'Summary.',
      findings: [
        {
          id: 'f1',
          title: 'Example',
          severity: 'low',
          category: 'style',
          summary: 'One paragraph.',
          futureFindingField: true,
        },
      ],
      futureReviewFindingsField: 'keep-me',
      generatedAtMs: now,
    });
    expect(parsed.findings).toHaveLength(1);
    expect((parsed as any).futureReviewFindingsField).toBe('keep-me');
    expect((parsed.runRef as any).futureRunRefField).toBe('keep-me');
    expect((parsed.findings[0] as any).futureFindingField).toBe(true);
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
        futureRunRefField: 'keep-me',
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
          futureFindingField: 'keep-me',
        },
      ],
      questions: [{ id: 'q1', text: 'Should this support empty input?', status: 'open', findingIds: ['f1'], futureQuestionField: 'keep-me' }],
      assumptions: [{ id: 'a1', text: 'Assumed strict mode is enabled.', findingIds: ['f1'], futureAssumptionField: 'keep-me' }],
      publication: { findings: [{ id: 'f1', published: false, futurePublicationField: 'keep-me' }], futurePublicationEnvelope: 'keep-me' },
      futureReviewFindingsField: 'keep-me',
      generatedAtMs: now,
    });
    expect(parsed.overviewMarkdown).toContain('Overview');
    expect(parsed.questions[0]?.status).toBe('open');
    expect(parsed.findings[0]?.confidence).toBe(0.6);
    expect((parsed as any).futureReviewFindingsField).toBe('keep-me');
    expect((parsed.runRef as any).futureRunRefField).toBe('keep-me');
    expect((parsed.findings[0] as any).futureFindingField).toBe('keep-me');
    expect((parsed.questions[0] as any).futureQuestionField).toBe('keep-me');
    expect((parsed.assumptions[0] as any).futureAssumptionField).toBe('keep-me');
    expect((parsed.publication as any).futurePublicationEnvelope).toBe('keep-me');
    expect((parsed.publication?.findings[0] as any).futurePublicationField).toBe('keep-me');
  });

  it('validates review_follow_up.v1 structured payload', () => {
    const now = Date.now();
    const parsed = ReviewFollowUpV1Schema.parse({
      parentRunRef: {
        runId: 'run_1',
        callId: 'subagent_run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      },
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
      sourceRunRef: {
        runId: 'run_1',
        callId: 'subagent_run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        futureSourceRunRefField: 'keep-me',
      },
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
          futureFindingField: 'keep-me',
        },
      ],
      threadRefs: ['thread_1'],
      futurePublishRequestField: 'keep-me',
    });
    expect(parsed.publishedFindings[0]?.id).toBe('f1');
    expect((parsed as any).futurePublishRequestField).toBe('keep-me');
    expect((parsed.sourceRunRef as any).futureSourceRunRefField).toBe('keep-me');
    expect((parsed.publishedFindings[0] as any).futureFindingField).toBe('keep-me');
  });

  it('exports the shared structured run ref schema from the protocol root entrypoint', () => {
    expect(Protocol.ExecutionRunStructuredRunRefSchema).toBe(ExecutionRunStructuredRunRefSchema);
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
        futureRunRefField: 'keep-me',
      },
      summary: 'Plan summary.',
      sections: [
        { title: 'Approach', items: ['Step 1', 'Step 2'], futureSectionField: 'keep-me' },
      ],
      risks: ['Risk 1'],
      milestones: [{ title: 'Milestone 1', details: 'Soon', futureMilestoneField: 'keep-me' }],
      recommendedBackendId: 'claude',
      futurePlanField: 'keep-me',
      generatedAtMs: now,
    });
    expect(parsed.sections).toHaveLength(1);
    expect((parsed as any).futurePlanField).toBe('keep-me');
    expect((parsed.runRef as any).futureRunRefField).toBe('keep-me');
    expect((parsed.sections[0] as any).futureSectionField).toBe('keep-me');
    expect((parsed.milestones?.[0] as any).futureMilestoneField).toBe('keep-me');
  });

  it('validates delegate_output.v1 structured payload', () => {
    const now = Date.now();
    const parsed = DelegateOutputV1Schema.parse({
      runRef: {
        runId: 'run_1',
        callId: 'subagent_run_1',
        backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        futureRunRefField: 'keep-me',
      },
      summary: 'Delegation summary.',
      deliverables: [
        { id: 'd1', title: 'Deliverable 1', details: 'Do it', futureDeliverableField: 'keep-me' },
      ],
      futureDelegateField: 'keep-me',
      generatedAtMs: now,
    });
    expect(parsed.deliverables).toHaveLength(1);
    expect((parsed as any).futureDelegateField).toBe('keep-me');
    expect((parsed.runRef as any).futureRunRefField).toBe('keep-me');
    expect((parsed.deliverables[0] as any).futureDeliverableField).toBe('keep-me');
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
