import { expect, it } from 'vitest';
import { z } from 'zod/mini';
import { WorkflowRunSummaryV1Schema } from '../workflows/workflowProgressV1.js';
import { ActionCompletionStateV1Schema, freezeActionCompletionContractV1, prepareActionCompletionV1,
  resumeActionCompletionV1, type ActionCompletionDeclaration } from './actionCompletion.js';
import { ActionSpecSchema } from './specs/definition.js';
import { getActionSpec } from './actionSpecs.js';
import { withExecutionRunStartFailureDetails } from '../execution/runs/responseSchemas.js';

const declaration: ActionCompletionDeclaration = {
  awaits: 'workflow_runs',
  launched: () => ({ workflows: [{ key: 'review', runId: 'inner' }] }),
  terminalOutputSchema: z.strictObject({ findings: z.number() }),
  terminal: (_output, workflows) => workflows[0]?.workflow.result,
};
const run = WorkflowRunSummaryV1Schema.parse({ sourceArtifactId: null, ownerAccountId: 'owner', visibleTeamId: null,
  id: 'inner', origin: { kind: 'direct' }, state: 'succeeded', revision: 2, machineId: 'machine',
  workflowCustodyState: 'settled', originDeliveryAckRevision: null, finishedAt: '2026-01-01T00:00:00.000Z',
  attentionSeenFailureAt: null, failureUnseen: false, invocationAttentionRequired: false, attentionRequired: false,
  availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

it('retains the Workflow completion owner and native fallback when validating an authored Action spec', () => {
  const native = getActionSpec('subagents.plan.start').completion;
  if (native?.awaits !== 'execution_runs') throw new Error('Expected native completion declaration');
  const spec = ActionSpecSchema.parse({ ...getActionSpec('review.start'), completion: { ...declaration, executionRuns: native } });
  expect(spec.completion).toMatchObject({ awaits: 'workflow_runs', executionRuns: { awaits: 'execution_runs' } });
});

it('completes an admitted person-only Review without mistaking its empty executable roster for a launch failure', async () => {
  const completion = getActionSpec('review.start').completion;
  if (!completion) throw new Error('Expected Review completion declaration');
  const reviewRound = { reviewId: 'person-review', roundOrdinal: 1 };
  const receipt = { intent: 'review', sessionId: null, reviewRound, reviewedFingerprint: null, results: [] };
  const prepare = (result: unknown) => prepareActionCompletionV1(completion, { ok: true, result });

  expect(prepare(receipt)).toEqual({ kind: 'completed', value: receipt });
  const { reviewRound: _reviewRound, ...unadmitted } = receipt;
  expect(prepare(unadmitted)).toEqual({ kind: 'failed', errorCode: 'action_failed' });
  const failedReviewer = { key: 'reviewer-2', ok: false, errorCode: 'engine_unavailable',
    details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated') };
  expect(prepare({ ...receipt, results: [failedReviewer] })).toEqual({ kind: 'failed', errorCode: 'engine_unavailable', noRunsLaunched: true });

  const partial = prepare({ ...receipt, results: [{ key: 'reviewer-1', ok: true, result: { runId: 'native-review' } }, failedReviewer] });
  expect(partial).toMatchObject({ kind: 'awaiting', state: { awaitedRuns: [{ key: 'reviewer-1', runId: 'native-review' }] } });
  if (partial.kind !== 'awaiting') throw new Error('Expected native reviewer completion');
  expect(await resumeActionCompletionV1({ actionId: 'review.start', completion: freezeActionCompletionContractV1(completion),
    state: partial.state, resolveDeclaration: () => completion,
    observeRun: async () => ({ kind: 'completed', result: {}, commentIds: [], materialization: { kind: 'complete' } }),
  })).toMatchObject({ kind: 'completed', value: { reviewRound, perEngineOutcome: [
    { key: 'reviewer-1', outcome: 'completed' }, { key: 'reviewer-2', outcome: 'launch_failed', errorCode: 'engine_unavailable' },
  ] } });
});

it('retains the accepted workflow handle and waits for its terminal output once', async () => {
  const prepared = prepareActionCompletionV1(declaration, { ok: true, result: { workflowRunId: 'inner' } });
  expect(prepared).toEqual({ kind: 'awaiting', state: { output: { workflowRunId: 'inner' },
    awaitedWorkflows: [{ key: 'review', runId: 'inner' }] } });
  if (prepared.kind !== 'awaiting') throw new Error('Expected retained Workflow completion');
  let release!: (value: unknown) => void;
  let observations = 0;
  const observed = new Promise<unknown>(resolve => { release = resolve; });
  let observing!: () => void;
  const ready = new Promise<void>(resolve => { observing = resolve; });
  let settled = false;
  const completion = resumeActionCompletionV1({ actionId: 'fixture.start', completion: freezeActionCompletionContractV1(declaration),
    state: prepared.state, resolveDeclaration: () => declaration,
    observeWorkflow: async () => { observations++; observing(); return observed; },
  }).then(value => { settled = true; return value; });
  await ready;
  expect(settled).toBe(false);
  expect(observations).toBe(1);
  release({ observation: 'terminal', matchedCondition: 'terminal', run, result: { findings: 3 } });
  expect(await completion).toEqual({ kind: 'completed', value: { findings: 3 } });
  expect(observations).toBe(1);
});

it.each(['foreign', 'running', 'failed', 'cancelled'] as const)('does not report success for %s workflow evidence', async scenario => {
  const state = { output: {}, awaitedWorkflows: [{ key: 'review', runId: 'inner' }] };
  const completion = await resumeActionCompletionV1({ actionId: 'fixture.start', completion: freezeActionCompletionContractV1(declaration),
    state, resolveDeclaration: () => declaration, observeWorkflow: async () => ({ observation: 'terminal', matchedCondition: 'terminal',
      run: { ...run, ...(scenario === 'foreign' ? { id: 'foreign' } : { state: scenario }), errorCode: 'review_failed' },
      result: { findings: 0 } }) });
  expect(completion).toMatchObject(scenario === 'failed' ? { kind: 'failed', errorCode: 'review_failed' }
    : scenario === 'cancelled' ? { kind: 'cancelled' } : { kind: 'outcome_uncertain' });
});

it('retains exactly one observation owner and preserves the native execution fallback', async () => {
  expect(ActionCompletionStateV1Schema.safeParse({ output: {}, awaitedWorkflows: [{ key: 'review', runId: 'inner' }],
    awaitedRuns: [{ key: 'native', runId: 'native' }] }).success).toBe(false);
  const native: ActionCompletionDeclaration = { awaits: 'execution_runs', launched: () => ({ runs: [{ key: 'native', runId: 'native' }], failed: [] }),
    terminalOutputSchema: declaration.terminalOutputSchema, terminal: () => ({ findings: 1 }) };
  const combined: ActionCompletionDeclaration = { ...declaration, launched: () => ({ workflows: [] }), executionRuns: native };
  const prepared = prepareActionCompletionV1(combined, { ok: true, result: {} });
  expect(prepared).toMatchObject({ kind: 'awaiting', state: { awaitedRuns: [{ key: 'native', runId: 'native' }] } });
  if (prepared.kind !== 'awaiting') throw new Error('Expected native fallback');
  for (const completion of [freezeActionCompletionContractV1(native), freezeActionCompletionContractV1(combined)]) {
    expect(await resumeActionCompletionV1({ actionId: 'fixture.start', completion,
      state: prepared.state, resolveDeclaration: () => combined, observeRun: async () => ({ kind: 'completed', result: {} }) }))
      .toEqual({ kind: 'completed', value: { findings: 1 } });
  }
});
