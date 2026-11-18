import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from './approvalRequestV1.js';
import { decideApprovalRequestTransition } from './approvalRequestTransition.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { ApprovalRequestPublicReadSchema } from './approvalRequestPublicRead.js';
import { ApprovalRequestDecideInputSchema } from '../actions/specs/approvals.js';
import { ActionAutomationConsentV1Schema } from './approvalAutomaticChecks.js';
import { createActionAutomationInvocationV1 } from '../actions/executor/actionSettlement.js';
import type { ActionAutomationPortV1, ActionAutomationSelectionV1 } from '../actions/executor/actionAutomationAdmission.js';
import { answerApprovalAutomaticConsentV1, createApprovalAutomaticChecksV1, createApprovalAutomaticContinuationV1,
  restoreApprovalAutomaticContextV1 } from '../actions/executor/automaticApprovalContinuation.js';

const selected = [{ automationId: 'automation', triggerId: 'check', triggerRevision: 3, ownerAccountId: 'actor',
  workflowId: 'workflow', workflowRevision: 7, actionIds: ['session.title.set'], phase: 'before', mode: 'wait', onFailure: 'ask' }];
const humanDecision = { kind: 'approve', authority: 'present_user', decidingAccountId: 'actor', decidedAtMs: 2 };
const request = { v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
  createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent',
  actionId: 'session.title.set', actionArgs: { sessionId: 'session', title: 'Release' }, summary: 'Rename Session',
  executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
    caller: { kind: 'session', sessionId: 'session', starterDepth: 0, turnDepth: 0 },
    accountId: 'actor', serverId: 'home', sessionId: 'session', actionId: 'session.title.set', requestId: 'request' } };
const subjects = [{ role: 'context', subject: { kind: 'approvalProfile', serverId: 'home', profileId: 'release' } }];
const checking = { phase: 'checking', humanApprovalRequired: true, humanDecision, subjects,
  selectionStatus: 'ready', notices: [],
  selected, consents: [], runs: [{ automationId: 'automation', triggerId: 'check', runId: 'run' }], results: [] };

describe('automatic check approval invariants (PROGRAM D2/C3/D14)', () => {
  it.each(['some', 'all'] as const)('retains one settlement owner when Skip removes %s after checks', async removed => {
    const after = { automationId: 'shared', triggerId: 'after', triggerRevision: 1, ownerAccountId: 'other',
      workflowId: 'shared-workflow', workflowRevision: 1, actionIds: ['session.title.set'], phase: 'after' as const };
    const selection: ActionAutomationSelectionV1 = { status: 'ready', subjects: [], before: [],
      after: [{ ...after, consent: { status: 'missing' } }, ...(removed === 'some'
        ? [{ ...after, automationId: 'own', ownerAccountId: 'actor' }] : [])] };
    const published: string[][] = [];
    const port: ActionAutomationPortV1 = {
      select: async () => { throw new Error('An admitted continuation cannot select again'); },
      settle: async ({ selection: settled }) => { published.push(settled.after.map(row => row.automationId)); },
    };
    const context = { surface: 'agent' as const, actionRequestId: 'request' };
    const original = createActionAutomationInvocationV1({ actionId: 'session.title.set', context, selection, port });
    const checks = await answerApprovalAutomaticConsentV1({ artifactId: 'approval',
      checks: createApprovalAutomaticChecksV1(selection, false), answer: { automationId: 'shared', triggerId: 'after', decision: 'skip' },
      context, executionContext: context });
    if ('ok' in checks) throw new Error('Expected the selected consent to accept Skip');
    const restored = restoreApprovalAutomaticContextV1({ automaticChecks: checks,
      executionOriginV1: ApprovalRequestV2Schema.parse(request).executionOriginV1 }, 'session.title.set',
    { ...context, actionAutomationAdmission: original }, port);
    const result = await restored.actionAutomationAdmission!.settle({ ok: true, result: { renamed: true } }, restored);
    const completed = await original.settle(result, context);
    expect(published).toEqual(removed === 'some' ? [['own']] : []);
    expect(completed.automationNotices).toEqual([{ code: 'action_automation_skipped', reason: 'consentSkipped',
      automationId: 'shared', triggerId: 'after', workflowId: 'shared-workflow' }]);
  });

  it('keeps a different admitted request isolated from the carried settlement owner', async () => {
    const selection: ActionAutomationSelectionV1 = { status: 'ready', subjects: [], before: [],
      after: [{ ...selected[0]!, phase: 'after', mode: undefined, onFailure: undefined }] };
    const published: string[] = [];
    const port: ActionAutomationPortV1 = {
      select: async () => { throw new Error('An admitted continuation cannot select again'); },
      settle: async ({ event }) => { published.push(event.requestId); },
    };
    const context = { surface: 'agent' as const, actionRequestId: 'different-request' };
    const original = createActionAutomationInvocationV1({ actionId: 'session.title.set', context, selection, port });
    const restored = restoreApprovalAutomaticContextV1({ automaticChecks: createApprovalAutomaticChecksV1(selection, false),
      executionOriginV1: ApprovalRequestV2Schema.parse(request).executionOriginV1 }, 'session.title.set',
    { ...context, actionAutomationAdmission: original }, port);
    await restored.actionAutomationAdmission!.settle({ ok: true, result: {} }, restored);
    await original.settle({ ok: true, result: {} }, context);
    expect(published).toEqual(['request', 'different-request']);
  });

  it('accepts per-trigger Allow and Skip only as explicit approval decisions without narrowed operands', () => {
    const base = { artifactId: 'approval', decision: 'approve' };
    const trigger = { automationId: 'automation', triggerId: 'check' };
    const actorConsent = ActionAutomationConsentV1Schema.parse({ ...trigger, decision: 'allow', actorConsent: selected[0] }).actorConsent;
    for (const decision of ['allow', 'skip']) {
      const triggerConsent = { ...trigger, decision };
      expect(ApprovalRequestDecideInputSchema.parse({ ...base, triggerConsent })).toEqual({ ...base, triggerConsent });
      for (const invalid of [
        { ...base, decision: 'reject', triggerConsent },
        { ...base, decision: 'cancel', triggerConsent },
        { ...base, triggerConsent, narrowedInput: {} },
        { ...base, triggerConsent, narrowedInput: null },
        { ...base, triggerConsent: { ...triggerConsent, authority: 'present_user' } },
        { ...base, triggerConsent: { ...triggerConsent, actorConsent } },
      ]) expect(ApprovalRequestDecideInputSchema.safeParse(invalid).success).toBe(false);
    }
    for (const triggerConsent of [
      { ...trigger, decision: 'pending' }, { ...trigger, decision: 'allow', automationId: '' },
      { ...trigger, decision: 'allow', triggerId: '' }, { decision: 'allow', triggerId: 'check' },
    ]) expect(ApprovalRequestDecideInputSchema.safeParse({ ...base, triggerConsent }).success).toBe(false);
    expect(ApprovalRequestDecideInputSchema.parse(base)).toEqual(base);
    expect(ApprovalRequestDecideInputSchema.parse({ ...base, narrowedInput: { title: 'Narrowed' } }))
      .toEqual({ ...base, narrowedInput: { title: 'Narrowed' } });
  });

  it('retains human approval while pending checks and public reads retain the recorded Run ids', () => {
    const original = ApprovalRequestV2Schema.parse(request);
    const pending = ApprovalRequestV2Schema.parse({ ...original, automaticChecks: checking });
    expect(pending).not.toHaveProperty('decision');
    expect(pending.automaticChecks?.subjects).toEqual(subjects);
    expect(decideApprovalRequestTransition(pending, ApprovalRequestV2Schema.parse({ ...pending,
      automaticChecks: { ...checking, subjects: [{ ...subjects[0], role: 'operand' }] } })))
      .toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    expect(ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(pending)))
      .toMatchObject({ status: 'open', automaticChecks: { phase: 'checking', runs: checking.runs } });
  });

  it('admits automatic pass without inventing a human vote and keeps executing reserved for the effect', () => {
    const original = ApprovalRequestV2Schema.parse(request);
    const automaticChecks = { ...checking, humanApprovalRequired: false, humanDecision: undefined, phase: 'passed',
      results: [{ ...checking.runs[0], outcome: 'passed', resultId: 'result' }] };
    const approved = ApprovalRequestV2Schema.parse({ ...original, status: 'approved', automaticChecks });
    expect(approved).not.toHaveProperty('decision');
    const executing = ApprovalRequestV2Schema.parse({ ...approved, status: 'executing', updatedAtMs: 4 });
    expect(decideApprovalRequestTransition(approved, executing)).toEqual({ ok: true, changed: true });
    for (const phase of ['checking', 'consent', 'override', 'refused']) {
      expect(ApprovalRequestV2Schema.safeParse({ ...executing,
        automaticChecks: { ...automaticChecks, phase } }).success).toBe(false);
    }
    expect(ApprovalRequestV2Schema.safeParse({ ...approved,
      automaticChecks: { ...automaticChecks, humanApprovalRequired: true } }).success).toBe(false);
  });

  it('returns failed ask checks to the incumbent open human decision while preserving prior consent and Result refs', () => {
    const original = ApprovalRequestV2Schema.parse(request);
    const pending = ApprovalRequestV2Schema.parse({ ...original, automaticChecks: checking });
    const override = ApprovalRequestV2Schema.parse({ ...pending, updatedAtMs: 3,
      automaticChecks: { ...checking, phase: 'override',
        results: [{ ...checking.runs[0], outcome: 'failed', resultId: 'result', reason: 'Release check failed' }] } });
    expect(decideApprovalRequestTransition(pending, override)).toEqual({ ok: true, changed: true });
    expect(override).not.toHaveProperty('decision');
    expect(decideApprovalRequestTransition(override, { ...override, status: 'rejected', updatedAtMs: 4,
      decision: { kind: 'reject', decidedAtMs: 4 } })).toEqual({ ok: true, changed: true });
    const replacedRun = { ...override,
      automaticChecks: { ...checking, phase: 'override', runs: [{ ...checking.runs[0], runId: 'replacement' }],
        results: [{ ...checking.runs[0], outcome: 'failed', resultId: 'result', reason: 'Release check failed' }] } };
    expect(decideApprovalRequestTransition(pending, replacedRun))
      .toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
  });

  it('retains only the canonical workflow refusal message through terminal approval history', () => {
    const pending = ApprovalRequestV2Schema.parse({ ...request, automaticChecks: checking });
    const execution = projectApprovalExecutionFailureV2({ request: pending, executedAtMs: 3,
      effectAttempted: false, failure: { ok: false, errorCode: 'action_interception_rejected',
        error: 'action_interception_rejected', details: { message: 'Release check failed', privateDiagnostic: 'secret' } } });
    expect(execution.details).toEqual({ message: 'Release check failed' });
    const refused = ApprovalRequestV2Schema.parse({ ...pending, status: 'failed', updatedAtMs: 3, execution,
      automaticChecks: { ...checking, phase: 'refused', results: [{ ...checking.runs[0], outcome: 'failed', reason: 'Release check failed' }] } });
    expect(readApprovalExecutionFailure(refused)).toMatchObject({ errorCode: 'action_interception_rejected',
      details: { message: 'Release check failed' } });
  });

  it('keeps cancellation terminal against a late check result', () => {
    const original = ApprovalRequestV2Schema.parse(request);
    const pending = ApprovalRequestV2Schema.parse({ ...original, automaticChecks: checking });
    const canceled = ApprovalRequestV2Schema.parse({ ...pending, status: 'canceled', updatedAtMs: 3 });
    expect(decideApprovalRequestTransition(pending, canceled)).toEqual({ ok: true, changed: true });
    const lateResult = { ...canceled, status: 'approved' as const,
      automaticChecks: { ...checking, phase: 'passed', results: [{ ...checking.runs[0], outcome: 'passed' }] } };
    expect(decideApprovalRequestTransition(canceled, lateResult))
      .toMatchObject({ ok: false });
  });

  it('retains a skipped wait notice without fabricating a Run or its result', () => {
    const skipped = { ...checking, phase: 'passed', humanApprovalRequired: false, humanDecision: undefined,
      runs: [], results: [], notices: [{ code: 'action_automation_skipped', reason: 'causeSuppressed',
        automationId: selected[0]!.automationId, triggerId: selected[0]!.triggerId,
        workflowId: selected[0]!.workflowId }] };
    expect(ApprovalRequestV2Schema.parse({ ...request, status: 'approved', automaticChecks: skipped }))
      .toMatchObject({ automaticChecks: { runs: [], results: [], notices: skipped.notices } });
    expect(ApprovalRequestV2Schema.safeParse({ ...request, status: 'approved',
      automaticChecks: { ...skipped, notices: [] } }).success).toBe(false);
  });

  it('refuses admission when a selected wait check has neither a Run nor an explicit skip', async () => {
    const original = ApprovalRequestV2Schema.parse({ ...request,
      automaticChecks: createApprovalAutomaticChecksV1({ status: 'ready', subjects: [], before: selected, after: [] }, false),
    });
    const continuation = createApprovalAutomaticContinuationV1<ApprovalRequestV2, ApprovalRequestV2>({
      actionAutomations: {
        select: async () => { throw new Error('admission must use the retained selection'); },
        start: async () => ({ runs: [], notices: [] }),
      },
      parse: input => ApprovalRequestV2Schema.parse(input),
      invocation: () => ({ actionId: original.actionId, input: original.actionArgs }),
      write: async () => null,
      refusal: (current, updatedAtMs, checks, failure) => ApprovalRequestV2Schema.parse({ ...current,
        status: 'failed', updatedAtMs, automaticChecks: checks,
        execution: projectApprovalExecutionFailureV2({ request: current, executedAtMs: updatedAtMs,
          effectAttempted: false, failure }),
      }),
      readFailure: () => null,
    });
    await expect(continuation.admit('approval', original, { surface: 'cli', actionRequestId: 'request' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  });
});
