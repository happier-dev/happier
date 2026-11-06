import {
  type WorkflowCompareOperator,
  type WorkflowCondition,
  type WorkflowValueReference,
} from '@happier-dev/protocol/workflows/workflowReferenceV1';

/**
 * A condition as the person builds it: one sentence per rule ("Check the build · Passed is No"),
 * whose test follows the type of the value on its left.
 *
 * This is presentation over the authored `WorkflowCondition`, which stays the only stored shape:
 * "has no value" is `not(exists)`, and none and not-all are `not` over a group. `exists` means the
 * reference resolves, so a `false` or an empty list has a value; the copy says "has a value" and
 * "has no value" rather than "is empty".
 */
export type WorkflowConditionValueFacts = Readonly<{
  type: 'boolean' | 'number' | 'text' | 'choice' | 'list' | 'unknown';
  choices?: readonly string[];
}>;

export type WorkflowConditionTest =
  | 'exists'
  | 'not_exists'
  | WorkflowCompareOperator;

export type WorkflowConditionRule = Readonly<{
  left: WorkflowValueReference;
  test: WorkflowConditionTest;
  right?: WorkflowValueReference;
}>;

export type WorkflowConditionGroupMode =
  | 'single'
  | 'all'
  | 'any'
  | 'none'
  | 'not_all';

/** A rule with no value chosen yet. Authored as the always-true default a new If already starts from. */
export const WORKFLOW_CONDITION_UNSET: Extract<
  WorkflowCondition,
  { kind: 'exists' }
> = Object.freeze({
  kind: 'exists',
  value: Object.freeze({ kind: 'literal', value: true }),
});

export function isWorkflowConditionUnset(
  condition: WorkflowCondition,
): boolean {
  return (
    condition.kind === 'exists' &&
    condition.value.kind === 'literal' &&
    condition.value.value === true
  );
}

const PRESENCE: readonly WorkflowConditionTest[] = ['exists', 'not_exists'];
const EQUALITY: readonly WorkflowConditionTest[] = ['eq', 'neq'];
const ORDER: readonly WorkflowConditionTest[] = ['gt', 'gte', 'lt', 'lte'];

/** The tests a value of this type offers; a test already authored outside them stays offered. */
export function listWorkflowConditionTests(
  facts: WorkflowConditionValueFacts,
  current?: WorkflowConditionTest,
): readonly WorkflowConditionTest[] {
  const tests =
    facts.type === 'list'
      ? PRESENCE
      : facts.type === 'number' || facts.type === 'unknown'
        ? [...EQUALITY, ...ORDER, ...PRESENCE]
        : [...EQUALITY, ...PRESENCE];
  return current === undefined || tests.includes(current)
    ? tests
    : [...tests, current];
}

/** One rule, or `null` for a shape only a nested group or a negation can show. */
export function readWorkflowConditionRule(
  condition: WorkflowCondition,
): WorkflowConditionRule | null {
  if (condition.kind === 'exists')
    return { left: condition.value, test: 'exists' };
  if (condition.kind === 'compare')
    return {
      left: condition.left,
      test: condition.operator,
      right: condition.right,
    };
  if (condition.kind === 'not' && condition.condition.kind === 'exists')
    return { left: condition.condition.value, test: 'not_exists' };
  return null;
}

function defaultRightLiteral(
  facts: WorkflowConditionValueFacts,
): WorkflowValueReference {
  switch (facts.type) {
    case 'boolean':
      return { kind: 'literal', value: true };
    case 'number':
      return { kind: 'literal', value: 0 };
    case 'choice':
      return { kind: 'literal', value: facts.choices?.[0] ?? '' };
    default:
      return { kind: 'literal', value: '' };
  }
}

function defaultTest(
  facts: WorkflowConditionValueFacts,
): WorkflowConditionTest {
  return facts.type === 'list' || facts.type === 'unknown' ? 'exists' : 'eq';
}

function fitsType(
  right: WorkflowValueReference,
  facts: WorkflowConditionValueFacts,
): boolean {
  if (right.kind !== 'literal') return true;
  switch (facts.type) {
    case 'boolean':
      return typeof right.value === 'boolean';
    case 'number':
      return typeof right.value === 'number';
    case 'text':
      return typeof right.value === 'string';
    case 'choice':
      return (
        typeof right.value === 'string' &&
        (facts.choices === undefined || facts.choices.includes(right.value))
      );
    default:
      return true;
  }
}

function writeRule(
  left: WorkflowValueReference,
  test: WorkflowConditionTest,
  right: WorkflowValueReference | undefined,
  facts: WorkflowConditionValueFacts,
): WorkflowCondition {
  if (test === 'exists') return { kind: 'exists', value: left };
  if (test === 'not_exists')
    return { kind: 'not', condition: { kind: 'exists', value: left } };
  return {
    kind: 'compare',
    operator: test,
    left,
    right:
      right !== undefined && fitsType(right, facts)
        ? right
        : defaultRightLiteral(facts),
  };
}

/** Choosing the value keeps the test while the new type offers it, and a right side that still compares. */
export function workflowConditionWithValue(
  condition: WorkflowCondition,
  left: WorkflowValueReference,
  facts: WorkflowConditionValueFacts,
): WorkflowCondition {
  const rule = isWorkflowConditionUnset(condition)
    ? null
    : readWorkflowConditionRule(condition);
  const test =
    rule !== null && listWorkflowConditionTests(facts).includes(rule.test)
      ? rule.test
      : defaultTest(facts);
  return writeRule(left, test, rule?.right, facts);
}

export function workflowConditionWithTest(
  condition: WorkflowCondition,
  test: WorkflowConditionTest,
  facts: WorkflowConditionValueFacts,
): WorkflowCondition {
  const rule = readWorkflowConditionRule(condition);
  return rule === null
    ? condition
    : writeRule(rule.left, test, rule.right, facts);
}

export function readWorkflowConditionGroup(
  condition: WorkflowCondition,
): Readonly<{
  mode: WorkflowConditionGroupMode;
  rows: readonly WorkflowCondition[];
}> {
  if (condition.kind === 'all' || condition.kind === 'any')
    return { mode: condition.kind, rows: condition.conditions };
  if (
    condition.kind === 'not' &&
    (condition.condition.kind === 'all' || condition.condition.kind === 'any')
  ) {
    return {
      mode: condition.condition.kind === 'any' ? 'none' : 'not_all',
      rows: condition.condition.conditions,
    };
  }
  return { mode: 'single', rows: [condition] };
}

export function writeWorkflowConditionGroup(
  mode: WorkflowConditionGroupMode,
  rows: readonly WorkflowCondition[],
): WorkflowCondition {
  switch (mode) {
    case 'single':
      return rows[0] ?? WORKFLOW_CONDITION_UNSET;
    case 'all':
      return { kind: 'all', conditions: [...rows] };
    case 'any':
      return { kind: 'any', conditions: [...rows] };
    case 'none':
      return { kind: 'not', condition: { kind: 'any', conditions: [...rows] } };
    case 'not_all':
      return { kind: 'not', condition: { kind: 'all', conditions: [...rows] } };
  }
}

export function addWorkflowConditionRow(
  condition: WorkflowCondition,
): WorkflowCondition {
  const { mode, rows } = readWorkflowConditionGroup(condition);
  return writeWorkflowConditionGroup(mode === 'single' ? 'all' : mode, [
    ...rows,
    WORKFLOW_CONDITION_UNSET,
  ]);
}

/** Positive groups collapse to their remaining rule; negative groups keep their polarity. */
export function removeWorkflowConditionRow(
  condition: WorkflowCondition,
  index: number,
): WorkflowCondition | undefined {
  const { mode, rows } = readWorkflowConditionGroup(condition);
  const remaining = rows.filter((_, candidate) => candidate !== index);
  if (remaining.length === 0) return undefined;
  return remaining.length === 1 && mode !== 'none' && mode !== 'not_all'
    ? remaining[0]
    : writeWorkflowConditionGroup(mode, remaining);
}
