import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';

import {
  WorkflowContainerClosingV1Schema,
  WorkflowActionFailureV1Schema,
  WorkflowExecutionCorrespondenceV1Schema,
  WorkflowConversationRefV1Schema,
  areWorkflowRetainedRuntimeSelectionsEqualV1,
  projectWorkflowRetainedRuntimeSelectionV1,
  projectWorkflowBigIntV1,
  WorkflowFinalResultV1Schema,
  projectWorkflowFinalResultDeliverableTextV1,
  WorkflowInvocationLifecycleV1Schema,
  WorkflowControlV1Schema,
  WorkflowProgressEnvelopeV1Schema,
  WorkflowInvocationPathV1Schema,
  WorkflowRecoveryChoiceV1Schema,
  WorkflowResultRefV1Schema,
  WorkflowRunInvocationIndexV1Schema,
  WorkflowRunOriginV1Schema,
  WorkflowRunSummaryV1Schema,
  WorkflowRunAvailabilityV1Schema,
  WorkflowInvocationRecoveryAvailabilityV1Schema,
  WorkflowStepObservationV1Schema,
  classifyWorkflowHoldV1,
  applyWorkflowInvocationFactV1,
} from './workflowProgressV1.js';

describe('workflow progress v1', () => {
  it('retains destination labels and exact last-observed invocation facts in private root progress', () => {
    const progress = { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
      attempt: '0', logicalInvocationRecordId: 'root', stepProgress: { completed: 0, total: 1, destinations: [
        { sourceKey: '$root', blockId: 'write', sessionIds: ['session-1'], ordinal: 1, name: 'Write',
          observation: { recordId: 'writer', sequence: '3', attempt: '0', contentRevision: '4', lifecycle: 'running' } },
        { sourceKey: 'builtin:child', blockId: 'later', sessionIds: ['session-2'], ordinal: 1, name: 'Later' },
      ] } };
    expect(WorkflowProgressEnvelopeV1Schema.parse(progress)).toEqual(progress);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...progress, stepProgress: { completed: 0, total: 1 } }).success).toBe(true);
  });
  it('retains exact result condition annotations on the root, merges reported results, and tolerates only stored extras', () => {
    const root = { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
      attempt: '0', logicalInvocationRecordId: 'root', resultProvenance: { report: { notificationCondition: 'suppressed' } } };
    const parsed = WorkflowProgressEnvelopeV1Schema.parse(root);
    const updated = applyWorkflowInvocationFactV1(parsed, { resultProvenance: {
      report: { notificationCondition: 'matched' }, other: { notificationCondition: 'suppressed' },
    } });
    const replay = applyWorkflowInvocationFactV1(updated, { resultProvenance: { report: { notificationCondition: 'suppressed' } } });
    expect(replay).toMatchObject({ resultProvenance: { report: { notificationCondition: 'matched' }, other: { notificationCondition: 'suppressed' } } });
    const extended = { ...root, resultProvenance: { report: { notificationCondition: 'suppressed', future: true } } };
    expect(WorkflowProgressEnvelopeV1Schema.safeParse(extended).success).toBe(false);
    expect(createStoredReadSchema(WorkflowProgressEnvelopeV1Schema).parse(extended)).toEqual(parsed);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...root, blockKind: 'step', invocationPath: { blockId: 'report', scope: [] } }).success).toBe(false);
  });
  it('returns a typed review requirement without disclosing retained content', () => {
    expect(WorkflowActionFailureV1Schema.parse({ ok: false, errorCode: 'legacy_conversion_unsupported',
      error: 'legacy_conversion_unsupported', details: { reason: 'review_required' } })).toMatchObject({
      ok: false, errorCode: 'legacy_conversion_unsupported', details: { reason: 'review_required' },
    });
  });
  it('records an inputless Session creation without claiming an input receipt', () => {
    expect(WorkflowExecutionCorrespondenceV1Schema.parse({ kind: 'session_ready', sessionId: 'session-1' }))
      .toEqual({ kind: 'session_ready', sessionId: 'session-1' });
    expect(WorkflowExecutionCorrespondenceV1Schema.safeParse({ kind: 'session_ready', sessionId: 'session-1', localInputId: 'fake' }).success).toBe(false);
  });
  it('retains classic nested JSON projection and refinement error identity', () => {
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
      expect(zodSchemaToJsonSchemaObject(WorkflowProgressEnvelopeV1Schema, { target })).toMatchObject({
        type: 'object', additionalProperties: false,
        properties: {
          invocationPath: { type: 'object', additionalProperties: false, required: ['blockId', 'scope'] },
          attempt: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
        },
      });
    }
    const invalid = WorkflowProgressEnvelopeV1Schema.safeParse({ kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: '$root', scope: [] }, blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'invocation' });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error).toBeInstanceOf(z.ZodError);
      expect(invalid.error.issues).toContainEqual(expect.objectContaining({ code: 'custom', path: ['invocationPath', 'blockId'] }));
    }
  });
  it('rejects the retired older-daemon input-admission update requirement', () => {
    expect(WorkflowActionFailureV1Schema.safeParse({ ok: false,
      errorCode: 'workflow_input_admission_update_required',
      error: 'workflow_input_admission_update_required',
    }).success).toBe(false);
  });
  it('requires the current invocation restoration decision and rejects retired Run recovery flags', () => {
    const unavailable = { kind: 'unavailable', reason: 'run_not_interrupted' };
    const recovery = { reattach: unavailable, retry: unavailable,
      continueSameConversation: unavailable, continueFreshAgent: unavailable };
    expect(WorkflowInvocationRecoveryAvailabilityV1Schema.safeParse(recovery).success).toBe(false);
    expect(WorkflowInvocationRecoveryAvailabilityV1Schema.safeParse({ ...recovery, restoreWorkspace: unavailable }).success).toBe(true);
    const availability = { pause: false, resumeBoundary: false, restoreWorkspace: false,
      cancel: false, inspectExecution: true, disabledReasons: [] };
    expect(WorkflowRunAvailabilityV1Schema.safeParse(availability).success).toBe(true);
    for (const field of ['recoverSameConversation', 'recoverFreshAgent', 'retry']) {
      expect(WorkflowRunAvailabilityV1Schema.safeParse({ ...availability, [field]: false }).success).toBe(false);
    }
  });

  it('requires current Run ownership and visibility facts while attention remains operation-specific', () => {
    const summary = { id: 'run-1', sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      origin: { kind: 'direct' }, state: 'queued', revision: 0, machineId: 'machine-1',
      workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false, restoreWorkspace: false,
        cancel: true, inspectExecution: true, disabledReasons: [] },
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' };
    expect(WorkflowRunSummaryV1Schema.safeParse(summary).success).toBe(true);
    for (const field of ['sourceArtifactId', 'ownerAccountId', 'visibleTeamId']) {
      const missing = Object.fromEntries(Object.entries(summary).filter(([key]) => key !== field));
      expect(WorkflowRunSummaryV1Schema.safeParse(missing).success).toBe(false);
    }
    expect(WorkflowRunSummaryV1Schema.safeParse({ ...summary, attentionRequired: true }).success).toBe(true);
  });
  it('preserves the existing typed Run access denial at the Workflow failure boundary', () => {
    expect(WorkflowActionFailureV1Schema.safeParse({
      ok: false, errorCode: 'run_access_denied', error: 'run_access_denied',
    }).success).toBe(true);
  });
  it('persists strict decision, stop-arm and exhaustion outcomes in the existing closing fact', () => {
    for (const outcome of [
      { kind: 'decision', value: 'stuck', reason: 'no progress' },
      { kind: 'stop_condition', arm: 2 },
      { kind: 'stop_condition' },
      { kind: 'exhausted', rounds: 3 },
    ]) expect(WorkflowContainerClosingV1Schema.parse({ code: 'loop_completed', outcome })).toEqual({ code: 'loop_completed', outcome });
    for (const outcome of [
      { kind: 'decision', value: 'done', hidden: true },
      { kind: 'stop_condition', arm: -1 },
      { kind: 'exhausted', rounds: 0 },
      { kind: 'unknown' },
    ]) expect(WorkflowContainerClosingV1Schema.safeParse({ code: 'loop_completed', outcome }).success).toBe(false);
  });
  it('round-trips admitted child inputs in the sealed frame progress', () => {
    const progress = { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'child', scope: [] },
      blockKind: 'workflow', attempt: '0', logicalInvocationRecordId: 'child-invocation',
      container: { kind: 'body', nextBlockOrdinal: '1', frameInputs: { rounds: 2 },
        frameProjectWorkspace: { descriptor: { machineId: 'machine', directory: '/repo/app', checkoutRootPath: '/repo' },
          creationIntent: { kind: 'git_worktree', sourceDirectory: '/source/app', baseRef: 'a'.repeat(40),
            displayName: 'workflow-frame', branchMode: 'new' } } } };
    expect(WorkflowProgressEnvelopeV1Schema.parse(JSON.parse(JSON.stringify(progress)))).toMatchObject(progress);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...progress,
      container: { ...progress.container, frameInputs: { 'invalid name': 2 } } }).success).toBe(false);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...progress, container: { ...progress.container,
      frameProjectWorkspace: { ...progress.container.frameProjectWorkspace, hiddenOwner: 'other' } } }).success).toBe(false);
  });
  it('retains the exact frozen nested Workflow scope without caller-owned ancestry fields', () => {
    const path = { blockId: 'child-leaf', scope: [{ kind: 'workflow', blockId: 'child' }] };
    expect(WorkflowInvocationPathV1Schema.safeParse(path).success).toBe(true);
    expect(WorkflowInvocationPathV1Schema.safeParse({ ...path,
      scope: [{ ...path.scope[0], sourceArtifactId: 'caller-chosen' }],
    }).success).toBe(false);
  });
  it('classifies pending generation intent as runnable and ignores historical holds', () => {
    const row = { isCurrent: true, lifecycle: 'waiting_for_review' as const, progress: {} };
    expect(classifyWorkflowHoldV1(row)).toBe('awaiting_person');
    const generate = { ...row, progress: { review: { decision: {
      kind: 'generate' as const, requestedFromContentRevision: '0',
    } } } };
    expect(classifyWorkflowHoldV1(generate)).toBe('generate');
    expect(classifyWorkflowHoldV1({ ...generate, isCurrent: false })).toBe('resolved');
    expect(classifyWorkflowHoldV1({ ...generate, lifecycle: 'completed' })).toBe('resolved');
  });
  it('rebases owned observations without replacing the published value or review reason', () => {
    const current = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'a', scope: [] },
      blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'inv-1', result: { version: 'published' },
      reason: { code: 'review_required' }, review: { resultSource: { kind: 'published', by: 'agent' } },
    });
    const next = applyWorkflowInvocationFactV1(current, { result: 'late prose', reason: 'stale',
      usage: { outputTokens: 9 }, interaction: { requests: {} } });
    expect(next.result).toEqual({ version: 'published' });
    expect(next.reason).toEqual(current.reason);
    expect(next.review).toEqual(current.review);
    expect(next.usage).toEqual({ outputTokens: 9 });
    expect(current.usage).toBeUndefined();
    expect(applyWorkflowInvocationFactV1({ ...current, result: undefined, reason: undefined }, {
      result: null, reason: 'input_failed', reasonMessage: 'visible',
    })).toMatchObject({ result: null, reason: { code: 'input_failed', message: 'visible' } });
  });
  it('keeps review intent private and requires a row content token', () => {
    expect(WorkflowInvocationLifecycleV1Schema.safeParse('waiting_for_review').success).toBe(true);
    const index = { id: 'inv-1', runId: 'run-1', sequence: '0', parentRecordId: null,
      memberOrdinal: '0', attempt: '0', lifecycle: 'waiting_for_review',
      createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' };
    expect(WorkflowRunInvocationIndexV1Schema.safeParse(index).success).toBe(false);
    expect(WorkflowRunInvocationIndexV1Schema.safeParse({ ...index, contentRevision: '3' }).success).toBe(true);
    const progress = { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'a', scope: [] },
      blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'inv-1',
      review: { decision: { kind: 'generate', requestedFromContentRevision: '2' } } };
    expect(WorkflowProgressEnvelopeV1Schema.safeParse(progress).success).toBe(true);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...progress,
      review: { decision: { kind: 'generate', requestedFromContentRevision: '2', followUp: { kind: 'editing' } } },
    }).success).toBe(false);
  });
  it('refuses retired Workflow attached correspondence and conversation identities', () => {
    expect(WorkflowExecutionCorrespondenceV1Schema.safeParse({
      kind: 'attached_run', sessionId: 'session-1', runId: 'execution-1', localInputId: 'input-1',
    }).success).toBe(false);
    expect(WorkflowConversationRefV1Schema.safeParse({
      kind: 'attached_run', machineId: 'machine-1', sessionId: 'session-1', runId: 'execution-1',
    }).success).toBe(false);
  });
  it('represents exact recorded-workspace restoration as an explicit recovery choice', () => {
    expect(WorkflowRecoveryChoiceV1Schema.parse({
      kind: 'restore_workspace', invocation: { recordId: 'inv-1' },
      conversation: 'fresh_agent', input: { kind: 'original' },
    })).toEqual({
      kind: 'restore_workspace', invocation: { recordId: 'inv-1' },
      conversation: 'fresh_agent', input: { kind: 'original' },
    });
    expect(WorkflowRecoveryChoiceV1Schema.safeParse({
      kind: 'restore_workspace', invocation: { recordId: 'inv-1' },
      conversation: 'fresh_agent', input: { kind: 'original' }, targetPath: '/different',
    }).success).toBe(false);
  });
  it('projects database BigInts as canonical nonnegative decimal strings', () => {
    const base = {
      id: 'inv-1', runId: 'run-1', sequence: '0', parentRecordId: null,
      memberOrdinal: '12', attempt: '2', contentRevision: '0', lifecycle: 'running',
      createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    };
    expect(WorkflowRunInvocationIndexV1Schema.safeParse(base).success).toBe(true);
    for (const invalid of ['01', '-1', '1.0', 1]) {
      expect(WorkflowRunInvocationIndexV1Schema.safeParse({ ...base, sequence: invalid }).success).toBe(false);
    }
    expect(projectWorkflowBigIntV1(0n)).toBe('0');
    expect(projectWorkflowBigIntV1(12345678901234567890n)).toBe('12345678901234567890');
    expect(BigInt(projectWorkflowBigIntV1(42n))).toBe(42n);
    expect(() => projectWorkflowBigIntV1(-1n)).toThrow(TypeError);
  });

  it('keeps lifecycle in the public index and out of the sealed progress payload', () => {
    expect(WorkflowInvocationLifecycleV1Schema.options).toHaveLength(14);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'a', scope: [] },
      blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'inv-1',
      lifecycle: 'running',
    }).success).toBe(false);
  });

  it('records only the private proven-stopped marker for uncertain prior effects', () => {
    const base = {
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'a', scope: [] },
      blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'inv-1',
    } as const;
    expect(WorkflowProgressEnvelopeV1Schema.parse({
      ...base,
      uncertainPriorEffects: { activity: 'stopped' },
    }).uncertainPriorEffects).toEqual({ activity: 'stopped' });
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      uncertainPriorEffects: { activity: 'possibly_active' },
    }).success).toBe(false);
  });

  it('keeps the derived control projection closed to FLOW failure reasons', () => {
    expect(WorkflowControlV1Schema.parse({
      kind: 'interrupted',
      reason: 'invocation_failed',
    })).toEqual({ kind: 'interrupted', reason: 'invocation_failed' });
    expect(WorkflowControlV1Schema.safeParse({
      kind: 'interrupted',
      reason: 'generic_failure',
    }).success).toBe(false);
    expect(WorkflowControlV1Schema.safeParse({
      kind: 'terminal',
      outcome: 'failed',
    }).success).toBe(false);
  });

  it('reserves the private root path for the structural root frame', () => {
    const base = {
      kind: 'happier.workflow-progress.v1',
      attempt: '0',
      logicalInvocationRecordId: 'inv-root',
    } as const;
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      invocationPath: { blockId: '$root', scope: [] },
      blockKind: 'root',
    }).success).toBe(true);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      invocationPath: { blockId: 'authored-step', scope: [] },
      blockKind: 'root',
    }).success).toBe(false);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      invocationPath: { blockId: '$root', scope: [] },
      blockKind: 'step',
    }).success).toBe(false);
  });

  it('uses the same nonnegative attempt identity for initial and recovered structural frames', () => {
    const structural = {
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'parallel-1', scope: [] },
      blockKind: 'parallel',
      logicalInvocationRecordId: 'logical-parallel-1',
      container: { kind: 'parallel', nextBranchOrdinal: '0' },
    } as const;
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...structural, attempt: '0' }).success).toBe(true);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...structural,
      attempt: '1',
      previousAttemptRecordId: 'prior-parallel-1',
    }).success).toBe(true);
    for (const attempt of ['-1', '01', '1.0']) {
      expect(WorkflowProgressEnvelopeV1Schema.safeParse({ ...structural, attempt }).success).toBe(false);
    }
  });

  it('keeps provider resume identity private to detached execution correspondence', () => {
    const base = {
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'a', scope: [] },
      blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'inv-1',
    } as const;
    expect(WorkflowProgressEnvelopeV1Schema.parse({
      ...base,
      execution: { kind: 'session', sessionId: 'session-1', localInputId: 'input-1' },
    }).execution).toEqual({ kind: 'session', sessionId: 'session-1', localInputId: 'input-1' });
    expect(WorkflowProgressEnvelopeV1Schema.parse({
      ...base,
      execution: {
        kind: 'detached_run',
        runId: 'run-1',
        localInputId: 'input-1',
        turnId: 'turn-1',
        runtimeSelection: {},
        providerResumeIdentity: {
          kind: 'provider_session.v1',
          backendTarget: {
            kind: 'backend',
            backendId: 'claude',
            sourceKind: 'built_in',
          },
          providerSessionId: 'provider-session-1',
        },
      },
    }).execution).toEqual({
      kind: 'detached_run',
      runId: 'run-1',
      localInputId: 'input-1',
      turnId: 'turn-1',
      runtimeSelection: {},
      providerResumeIdentity: {
        kind: 'provider_session.v1',
        backendTarget: {
          kind: 'backend',
          backendId: 'claude',
          sourceKind: 'built_in',
        },
        providerSessionId: 'provider-session-1',
      },
    });
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      execution: {
        kind: 'session',
        sessionId: 'session-1',
        localInputId: 'input-1',
        providerResumeIdentity: {
          kind: 'provider_session.v1',
          backendTarget: {
            kind: 'backend',
            backendId: 'claude',
            sourceKind: 'built_in',
          },
          providerSessionId: 'provider-session-1',
        },
      },
    }).success).toBe(false);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      execution: { kind: 'detached_run', runId: 'run-1', localInputId: 'input-1', providerSessionId: 'secret' },
    }).success).toBe(false);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      execution: { kind: 'detached_run', runId: 'run-1', localInputId: 'input-1' },
    }).success).toBe(false);
  });

  it('persists only the canonical safe runtime selection needed to reuse a detached conversation', () => {
    const runtimeSelection = projectWorkflowRetainedRuntimeSelectionV1({
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.claude/claude',
          providerConnectionId: 'provider-1',
          modelId: 'claude-opus',
        },
        updatedAt: 41,
      },
      profileId: 'reviewer',
      permissionMode: 'safe-yolo',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 43,
        overrides: { reasoning: { value: 'high', updatedAt: 42 } },
      },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['review'],
        forceExcludeServerIds: [],
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'happier.test.connected/service': { source: 'native' },
        },
      },
      conversation: { kind: 'shared_run' },
      workspace: { kind: 'reuse_original' },
    });

    expect(runtimeSelection).toEqual({
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'agent:happier.agent.claude/claude',
          providerConnectionId: 'provider-1',
          modelId: 'claude-opus',
        },
        updatedAt: 41,
      },
      profileId: 'reviewer',
      permissionMode: 'safe-yolo',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 43,
        overrides: { reasoning: { value: 'high', updatedAt: 42 } },
      },
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['review'],
        forceExcludeServerIds: [],
      },
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.test.connected/service': { source: 'native' },
        },
      },
    });

    const progress = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'a', scope: [] },
      blockKind: 'step',
      attempt: '0',
      logicalInvocationRecordId: 'inv-1',
      execution: {
        kind: 'detached_run',
        runId: 'run-1',
        localInputId: 'input-1',
        runtimeSelection,
      },
    });
    expect(progress.execution).toMatchObject({ runtimeSelection });
  });

  it('compares retained runtime selections canonically and fails closed for missing or invalid witnesses', () => {
    const selected = projectWorkflowRetainedRuntimeSelectionV1({
      permissionMode: 'safe-yolo',
      profileId: 'reviewer',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'happier.test.connected/service': { source: 'native' },
        },
      },
    });
    const reordered = {
      connectedServices: {
        bindingsByServiceId: {
          'happier.test.connected/service': { source: 'native' },
        },
        v: 1,
      },
      profileId: 'reviewer',
      permissionMode: 'safe-yolo',
    };

    expect(areWorkflowRetainedRuntimeSelectionsEqualV1(selected, reordered)).toBe(true);
    expect(areWorkflowRetainedRuntimeSelectionsEqualV1(undefined, selected)).toBe(false);
    expect(areWorkflowRetainedRuntimeSelectionsEqualV1(selected, {
      ...reordered,
      permissionMode: 'read-only',
    })).toBe(false);
    expect(areWorkflowRetainedRuntimeSelectionsEqualV1(selected, {
      ...reordered,
      environmentVariables: { TOKEN: 'secret' },
    })).toBe(false);
    expect(areWorkflowRetainedRuntimeSelectionsEqualV1(selected, {
      ...reordered,
      profileId: undefined,
    })).toBe(false);
  });

  it('keeps container recovery state scalar and row-local', () => {
    const parsed = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'inspect', scope: [{ kind: 'iteration', blockId: 'files', index: 3 }] },
      frame: { ownerBlockId: 'files', source: { kind: 'item', index: '3' } },
      blockKind: 'loop', attempt: '0', logicalInvocationRecordId: 'inv-loop',
      container: {
        kind: 'loop', mode: 'items',
        source: { kind: 'result', recordId: 'inv-source', path: ['files'] },
        itemCount: '500', nextMemberIndex: '4', nextBodyBlockOrdinal: '1',
        closing: { code: 'fail_stop', causeInvocationRecordId: 'inv-failed' },
      },
      containerResult: { kind: 'container', containerRecordId: 'inv-loop' },
    });
    expect(parsed.container).toMatchObject({ kind: 'loop', nextMemberIndex: '4' });
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...parsed,
      container: { ...parsed.container, members: ['inv-1', 'inv-2'] },
    }).success).toBe(false);
  });

  it('persists an explicit retry conversation and original or replacement input', () => {
    const base = {
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'repair', scope: [] },
      blockKind: 'step', attempt: '1', logicalInvocationRecordId: 'inv-original',
      previousAttemptRecordId: 'inv-previous',
    } as const;
    expect(WorkflowProgressEnvelopeV1Schema.parse({
      ...base,
      recovery: { conversation: 'same_conversation', input: { kind: 'original' } },
    }).recovery).toEqual({ conversation: 'same_conversation', input: { kind: 'original' } });
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      recovery: { conversation: 'fresh_agent', input: { kind: 'replacement', value: { document: { text: 'retry', references: [], attachments: [] }, input: [] } }, providerHandle: 'private' },
    }).success).toBe(false);
  });

  it('keeps direct and Automation origins closed and distinct', () => {
    expect(WorkflowRunOriginV1Schema.parse({ kind: 'direct' })).toEqual({ kind: 'direct' });
    expect(WorkflowRunOriginV1Schema.safeParse({ kind: 'automation', automationId: 'a', extra: true }).success).toBe(false);
  });

  it('projects the origin delivery acknowledgement separately from terminal Run lifecycle', () => {
    const summary = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
      id: 'run-1',
      origin: { kind: 'direct', originSessionId: 'session-1' },
      state: 'succeeded',
      revision: 3,
      machineId: 'machine-1',
      workflowCustodyState: 'settled',
      originDeliveryAckRevision: 2,
      availability: {
        pause: false, resumeBoundary: false,
          restoreWorkspace: false, cancel: false,
        inspectExecution: true, disabledReasons: [],
      },
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:01:00.000Z',
    });
    expect(summary).toMatchObject({
      state: 'succeeded',
      originDeliveryAckRevision: 2,
    });
    expect(WorkflowRunSummaryV1Schema.safeParse({
      ...summary,
      originDeliveryAckRevision: -1,
    }).success).toBe(false);
    expect(WorkflowRunSummaryV1Schema.safeParse({
      ...summary,
      availability: {
        pause: false, resumeBoundary: false,
          cancel: false,
        inspectExecution: true, disabledReasons: [],
      },
    }).success).toBe(false);
    expect(WorkflowRunSummaryV1Schema.safeParse({
      ...summary,
      availability: {
        pause: false, resumeBoundary: false,
          restoreWorkspace: false,
        cancel: false, inspectExecution: true,
      },
    }).success).toBe(false);
    expect(WorkflowRunSummaryV1Schema.parse({ ...summary, originDeliveryAckRevision: null }).originDeliveryAckRevision).toBeNull();
    expect(WorkflowRunSummaryV1Schema.safeParse({ ...summary, originDeliveryAckRevision: 1.5 }).success).toBe(false);
    expect(WorkflowRunSummaryV1Schema.safeParse({ ...summary, workflowResultDeliveryState: 'pending' }).success).toBe(false);
  });

  it('requires the exact Run handle on the self-dependency failure and forbids details elsewhere', () => {
    expect(WorkflowActionFailureV1Schema.safeParse({
      ok: false,
      errorCode: 'workflow_wait_self_dependency',
      error: 'The calling Session is an execution target',
      details: { runId: 'run-1' },
    }).success).toBe(true);

    // Without the Run id a blocked agent has no stable handle to release its
    // turn and rejoin, so a conforming failure must not validate.
    expect(WorkflowActionFailureV1Schema.safeParse({
      ok: false,
      errorCode: 'workflow_wait_self_dependency',
      error: 'The calling Session is an execution target',
    }).success).toBe(false);

    for (const errorCode of ['run_not_found', 'currentness_conflict', 'ineligible_state']) {
      expect(WorkflowActionFailureV1Schema.safeParse({
        ok: false, errorCode, error: 'failed', details: { runId: 'run-1' },
      }).success, errorCode).toBe(false);
      expect(WorkflowActionFailureV1Schema.safeParse({
        ok: false, errorCode, error: 'failed',
      }).success, errorCode).toBe(true);
    }
  });

  it('couples the Workflow result value type to its kind', () => {
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'text', value: 'done' }).success).toBe(true);
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'decision', value: 'continue' }).success).toBe(true);
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'json', value: null }).success).toBe(true);
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'json', value: { ok: true } }).success).toBe(true);
    // A text result carries prose, never a bare number; a decision result
    // carries one authored decision string, never a structured object. The
    // authored result contract still owns which decision strings are allowed.
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'text', value: 42 }).success).toBe(false);
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'decision', value: { choice: 'continue' } }).success).toBe(false);
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'text', value: 'done', extra: true }).success).toBe(false);
    expect(WorkflowResultRefV1Schema.safeParse({ kind: 'unknown', value: 'done' }).success).toBe(false);
  });

  it('validates step observations and final results against the coupled result contract', () => {
    const input = {
      conversation: { kind: 'session', machineId: 'machine-1', sessionId: 'session-1' },
      localId: 'local-1',
    } as const;
    expect(WorkflowStepObservationV1Schema.safeParse({
      kind: 'completed', input, result: { kind: 'text', value: 'done' },
    }).success).toBe(true);
    expect(WorkflowStepObservationV1Schema.safeParse({
      kind: 'completed', input, result: { kind: 'json', value: null },
    }).success).toBe(true);
    expect(WorkflowStepObservationV1Schema.safeParse({
      kind: 'completed', input, result: { kind: 'text', value: 42 },
    }).success).toBe(false);
    expect(WorkflowStepObservationV1Schema.safeParse({
      kind: 'completed', input, result: { kind: 'decision', value: { choice: 'continue' } },
    }).success).toBe(false);
    expect(WorkflowFinalResultV1Schema.safeParse({
      kind: 'happier.workflow-final-result.v1',
      result: { kind: 'json', value: { ok: true } },
      producerInvocation: { recordId: 'inv-final' },
    }).success).toBe(true);
    expect(WorkflowFinalResultV1Schema.safeParse({
      kind: 'happier.workflow-final-result.v1',
      result: { kind: 'text', value: 'legacy result' },
    }).success).toBe(false);
    expect(WorkflowFinalResultV1Schema.safeParse({
      kind: 'happier.workflow-final-result.v1', result: { kind: 'decision', value: { choice: 'stop' } },
    }).success).toBe(false);
  });

  it('keeps workflow interaction state distinct from the selected step result', () => {
    const parsed = WorkflowProgressEnvelopeV1Schema.parse({
      kind: 'happier.workflow-progress.v1',
      invocationPath: { blockId: 'work', scope: [] },
      blockKind: 'step',
      attempt: '0',
      logicalInvocationRecordId: 'invocation-1',
      result: { changed: true },
      usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.04 },
      interaction: {
        requests: {
          permission_1: {
            tool: 'Write',
            arguments: { path: '/repo/file.txt' },
            createdAt: 1,
            turnId: 'turn-1',
          },
        },
      },
    });

    expect(parsed.interaction).toEqual(expect.objectContaining({
      requests: expect.objectContaining({ permission_1: expect.objectContaining({ tool: 'Write' }) }),
    }));
    expect(parsed.result).toEqual({ changed: true });
    expect(parsed.usage).toEqual({ inputTokens: 120, outputTokens: 30, costUsd: 0.04 });
  });

  it('projects the one direct-delivery representation from every final result variant', () => {
    const finalResult = (result: Parameters<typeof WorkflowFinalResultV1Schema.parse>[0]) =>
      WorkflowFinalResultV1Schema.parse(result);
    const producerInvocation = { recordId: 'inv-final' };

    expect(projectWorkflowFinalResultDeliverableTextV1(finalResult({
      kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'done' }, producerInvocation,
    }))).toBe('done');
    expect(projectWorkflowFinalResultDeliverableTextV1(finalResult({
      kind: 'happier.workflow-final-result.v1', result: { kind: 'decision', value: 'continue' }, producerInvocation,
    }))).toBe('continue');
    expect(projectWorkflowFinalResultDeliverableTextV1(finalResult({
      kind: 'happier.workflow-final-result.v1', result: { kind: 'json', value: 'json-text' }, producerInvocation,
    }))).toBe('json-text');
    expect(projectWorkflowFinalResultDeliverableTextV1(finalResult({
      kind: 'happier.workflow-final-result.v1', result: { kind: 'json', value: { ok: true } }, producerInvocation,
    }))).toBeNull();
  });

  it('rejects usage values that the canonical runtime usage owner cannot represent', () => {
    const base = {
      kind: 'happier.workflow-progress.v1' as const,
      invocationPath: { blockId: 'work', scope: [] },
      blockKind: 'step' as const,
      attempt: '0',
      logicalInvocationRecordId: 'invocation-1',
    };

    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      usage: { inputTokens: 1.5 },
    }).success).toBe(false);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      usage: { outputTokens: Number.MAX_SAFE_INTEGER + 1 },
    }).success).toBe(false);
    expect(WorkflowProgressEnvelopeV1Schema.safeParse({
      ...base,
      usage: { costUsd: Number.POSITIVE_INFINITY },
    }).success).toBe(false);
  });
});
