import {
  getBuiltinWorkflowCatalogV1,
  type BuiltinWorkflowPurposeV1,
} from '@happier-dev/protocol/workflows/builtins/catalog';
import type {
  WorkflowRunStateV1,
  WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import { t, tLoose } from '@/text';

import { describeWorkflowRunState } from './workflowLifecyclePresentation';

type AutomationRunCause = NonNullable<
  Extract<WorkflowRunSummaryV1['origin'], { kind: 'automation' }>['cause']
>;

export type WorkflowTriggerRunFoldInput = Readonly<{
  /** The accepted catalog source (`builtin:keep-going`), null for any other source or while unread. */
  catalogRef: string | null;
  /** The accepted private title of a non-catalog workflow. */
  workflowTitle: string | null;
  /** Origin-session turns the run wrote, from the transcript provenance reader. */
  turnCount: number;
  run: Readonly<{
    state: WorkflowRunStateV1;
    workflowCustodyState: WorkflowRunSummaryV1['workflowCustodyState'];
  }> | null;
  /** The run's final output; for both built-ins it is the `turns`/`rounds` loop's recorded outcome (08 §3.5, §4.4). */
  result: unknown;
  inputs: Readonly<Record<string, unknown>> | null;
  /** The settled Notify me node of Keep going's second opinion (08 §3.1). */
  secondOpinionDisagreed: boolean;
  trigger: AutomationRunCause | null | undefined;
}>;

export type WorkflowTriggerRunFoldPresentation = Readonly<{
  verb: string;
  /** "· {detail}" segments after the verb, outcome last. */
  details: readonly string[];
  /** The trailing fact: the workflow and its trigger ("Keep going until done · on turn end"). */
  meta: string | null;
  purpose: BuiltinWorkflowPurposeV1 | null;
}>;

type LoopOutcome =
  | Readonly<{ kind: 'stop_condition'; arm: number }>
  | Readonly<{ kind: 'exhausted'; rounds: number }>;

function readLoopOutcome(value: unknown): LoopOutcome | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'stop_condition' && typeof record.arm === 'number')
    return { kind: 'stop_condition', arm: record.arm };
  if (record.kind === 'exhausted' && typeof record.rounds === 'number')
    return { kind: 'exhausted', rounds: record.rounds };
  return null;
}

function readCount(
  inputs: WorkflowTriggerRunFoldInput['inputs'],
  name: string,
  fallback: number,
): number {
  const value = inputs?.[name];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function describeTrigger(
  cause: WorkflowTriggerRunFoldInput['trigger'],
): string | null {
  if (cause?.kind !== 'trigger') return null;
  if (cause.triggerKind === 'schedule')
    return t('workflows.triggerRunFold.trigger.schedule');
  if (cause.triggerKind !== 'sessionLifecycle') return null;
  switch (cause.evidence.event) {
    case 'parentTurnCompleted':
      return t('workflows.triggerRunFold.trigger.turnEnds');
    case 'sessionStarted':
      return t('workflows.triggerRunFold.trigger.sessionStarts');
    case 'userActionRequired':
      return t('workflows.triggerRunFold.trigger.needsYou');
    case 'sessionArchived':
      return t('workflows.triggerRunFold.trigger.sessionArchived');
    default:
      return null;
  }
}

/**
 * One folded line for a run that continued this session (07 S15, U9).
 *
 * Outcomes come from the run's own recorded result and are always neutral; a
 * run that is not settled, or whose result is not read yet, says only its run
 * state word from the one run-state presenter, never a guessed arm.
 */
export function describeWorkflowTriggerRunFold(
  input: WorkflowTriggerRunFoldInput,
): WorkflowTriggerRunFoldPresentation {
  const entry =
    input.catalogRef === null
      ? undefined
      : getBuiltinWorkflowCatalogV1().find(
          (item) => item.id === input.catalogRef,
        );
  const workflowName = entry ? tLoose(entry.titleKey) : input.workflowTitle;
  const trigger = describeTrigger(input.trigger);
  const meta =
    workflowName && trigger
      ? t('workflows.triggerRunFold.meta', { workflow: workflowName, trigger })
      : workflowName;
  const outcome =
    input.run?.state === 'succeeded' ? readLoopOutcome(input.result) : null;
  const stateWord = input.run
    ? describeWorkflowRunState(input.run.state, {
        workflowCustodyState: input.run.workflowCustodyState,
      }).label
    : null;
  // One anatomy for every fold: "{n} turns · {outcome}". No turns yet is not a fact worth saying.
  const turns = input.turnCount > 0 ? t('workflows.triggerRunFold.turns', { count: input.turnCount }) : null;
  const line = (...parts: readonly (string | null)[]) => parts.filter((part): part is string => part !== null && part !== '');

  if (entry?.id === 'builtin:keep-going') {
    const said =
      outcome === null
        ? stateWord
        : outcome.kind === 'exhausted'
          ? t('workflows.triggerRunFold.stoppedAfterRounds', {
              count: outcome.rounds,
            })
          : outcome.arm === 0
            ? t(
                input.secondOpinionDisagreed
                  ? 'workflows.triggerRunFold.secondOpinionDisagreed'
                  : 'workflows.triggerRunFold.goalReached',
              )
            : outcome.arm === 1
              ? t('workflows.triggerRunFold.outOfBudget')
              : outcome.arm === 2
                ? t('workflows.triggerRunFold.noProgress', {
                    count: readCount(input.inputs, 'strikes', 3),
                  })
                : stateWord;
    return {
      verb: t('workflows.triggerRunFold.keptGoing'),
      // A round limit is counted in rounds alone; turns beside it read as a second, disagreeing count.
      details: outcome?.kind === 'exhausted' ? line(said) : line(turns, said),
      meta,
      purpose: entry.purpose,
    };
  }
  if (entry?.id === 'builtin:review-and-converge') {
    // Its origin-session turns are the "Verify in this session" steps, which run before every round but the first.
    const said =
      outcome === null
        ? stateWord
        : outcome.kind === 'exhausted'
          ? t('workflows.triggerRunFold.reviewDidNotConverge', {
              count: outcome.rounds,
            })
          : outcome.arm === 0
            ? t('workflows.triggerRunFold.convergedInRounds', {
                count: input.turnCount + 1,
              })
            : outcome.arm === 1
              ? t('workflows.triggerRunFold.findingsReported')
              : stateWord;
    return {
      verb: t('workflows.triggerRunFold.reviewed'),
      details: said ? [said] : [],
      meta,
      purpose: entry.purpose,
    };
  }
  return {
    verb: workflowName ?? t('workflows.run.untitled'),
    details: line(turns, stateWord),
    meta: trigger,
    purpose: entry?.purpose ?? null,
  };
}
