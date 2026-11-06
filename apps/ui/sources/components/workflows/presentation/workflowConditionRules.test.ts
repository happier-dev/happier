import { describe, expect, it } from 'vitest';

import type {
  WorkflowCondition,
  WorkflowValueReference,
} from '@happier-dev/protocol/workflows/workflowReferenceV1';

import {
  addWorkflowConditionRow,
  isWorkflowConditionUnset,
  listWorkflowConditionTests,
  readWorkflowConditionGroup,
  readWorkflowConditionRule,
  removeWorkflowConditionRow,
  workflowConditionWithTest,
  workflowConditionWithValue,
  writeWorkflowConditionGroup,
  WORKFLOW_CONDITION_UNSET,
} from './workflowConditionRules';

const passed: WorkflowValueReference = {
  kind: 'result',
  producer: { blockId: 'check', scope: { kind: 'current' } },
  path: ['passed'],
};
const count: WorkflowValueReference = {
  kind: 'result',
  producer: { blockId: 'check', scope: { kind: 'current' } },
  path: ['count'],
};
const isNo: WorkflowCondition = {
  kind: 'compare',
  operator: 'eq',
  left: passed,
  right: { kind: 'literal', value: false },
};

describe('the tests a value can have', () => {
  it('follow the value type, so a list is never compared and a number can be ordered', () => {
    expect(listWorkflowConditionTests({ type: 'list' })).toEqual([
      'exists',
      'not_exists',
    ]);
    expect(listWorkflowConditionTests({ type: 'boolean' })).toEqual([
      'eq',
      'neq',
      'exists',
      'not_exists',
    ]);
    expect(listWorkflowConditionTests({ type: 'number' })).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'exists',
      'not_exists',
    ]);
    expect(listWorkflowConditionTests({ type: 'text' })).toEqual([
      'eq',
      'neq',
      'exists',
      'not_exists',
    ]);
  });

  it('keep an authored test the type would not offer, so an existing rule stays readable and repairable', () => {
    expect(listWorkflowConditionTests({ type: 'text' }, 'gt')).toEqual([
      'eq',
      'neq',
      'exists',
      'not_exists',
      'gt',
    ]);
  });
});

describe('one rule', () => {
  it('reads "has no value" from its authored negation and writes it back the same way', () => {
    const none: WorkflowCondition = {
      kind: 'not',
      condition: { kind: 'exists', value: passed },
    };
    expect(readWorkflowConditionRule(none)).toEqual({
      left: passed,
      test: 'not_exists',
    });
    expect(
      workflowConditionWithTest(isNo, 'not_exists', { type: 'boolean' }),
    ).toEqual(none);
  });

  it('starts with no value chosen, and choosing one gives the test its type asks for', () => {
    expect(isWorkflowConditionUnset(WORKFLOW_CONDITION_UNSET)).toBe(true);
    expect(isWorkflowConditionUnset(isNo)).toBe(false);
    expect(
      workflowConditionWithValue(WORKFLOW_CONDITION_UNSET, passed, {
        type: 'boolean',
      }),
    ).toEqual({
      kind: 'compare',
      operator: 'eq',
      left: passed,
      right: { kind: 'literal', value: true },
    });
    expect(
      workflowConditionWithValue(WORKFLOW_CONDITION_UNSET, count, {
        type: 'number',
      }),
    ).toEqual({
      kind: 'compare',
      operator: 'eq',
      left: count,
      right: { kind: 'literal', value: 0 },
    });
    expect(
      workflowConditionWithValue(WORKFLOW_CONDITION_UNSET, count, {
        type: 'choice',
        choices: ['ship', 'hold'],
      }),
    ).toEqual({
      kind: 'compare',
      operator: 'eq',
      left: count,
      right: { kind: 'literal', value: 'ship' },
    });
    expect(
      workflowConditionWithValue(WORKFLOW_CONDITION_UNSET, count, {
        type: 'list',
      }),
    ).toEqual({ kind: 'exists', value: count });
  });

  it('keeps the test and its value when another value of the same type is chosen', () => {
    const next: WorkflowValueReference = { kind: 'input', name: 'approved' };
    expect(workflowConditionWithValue(isNo, next, { type: 'boolean' })).toEqual(
      {
        kind: 'compare',
        operator: 'eq',
        left: next,
        right: { kind: 'literal', value: false },
      },
    );
  });

  it('resets a literal that cannot be compared with the new value, never leaving a number against "Yes"', () => {
    expect(workflowConditionWithValue(isNo, count, { type: 'number' })).toEqual(
      {
        kind: 'compare',
        operator: 'eq',
        left: count,
        right: { kind: 'literal', value: 0 },
      },
    );
  });

  it('keeps a reference on the right when the value changes', () => {
    const right: WorkflowValueReference = { kind: 'input', name: 'expected' };
    const authored: WorkflowCondition = {
      kind: 'compare',
      operator: 'gt',
      left: count,
      right,
    };
    expect(
      workflowConditionWithValue(
        authored,
        { kind: 'input', name: 'seen' },
        { type: 'number' },
      ),
    ).toEqual({
      kind: 'compare',
      operator: 'gt',
      left: { kind: 'input', name: 'seen' },
      right,
    });
  });

  it('moves between a comparison and a presence test without losing the chosen value', () => {
    const present = workflowConditionWithTest(isNo, 'exists', {
      type: 'boolean',
    });
    expect(present).toEqual({ kind: 'exists', value: passed });
    expect(
      workflowConditionWithTest(present, 'neq', { type: 'boolean' }),
    ).toEqual({
      kind: 'compare',
      operator: 'neq',
      left: passed,
      right: { kind: 'literal', value: true },
    });
  });
});

describe('several rules', () => {
  const other: WorkflowCondition = { kind: 'exists', value: count };

  it('reads every authored grouping, including the negated ones', () => {
    expect(readWorkflowConditionGroup(isNo)).toEqual({
      mode: 'single',
      rows: [isNo],
    });
    expect(
      readWorkflowConditionGroup({ kind: 'any', conditions: [isNo, other] }),
    ).toEqual({ mode: 'any', rows: [isNo, other] });
    expect(
      readWorkflowConditionGroup({
        kind: 'not',
        condition: { kind: 'any', conditions: [isNo, other] },
      }),
    ).toEqual({ mode: 'none', rows: [isNo, other] });
    expect(
      readWorkflowConditionGroup({
        kind: 'not',
        condition: { kind: 'all', conditions: [isNo, other] },
      }),
    ).toEqual({ mode: 'not_all', rows: [isNo, other] });
  });

  it('writes each grouping back to the condition it read', () => {
    for (const condition of [
      { kind: 'all', conditions: [isNo, other] },
      { kind: 'any', conditions: [isNo, other] },
      { kind: 'not', condition: { kind: 'any', conditions: [isNo, other] } },
      { kind: 'not', condition: { kind: 'all', conditions: [isNo, other] } },
    ] satisfies WorkflowCondition[]) {
      const group = readWorkflowConditionGroup(condition);
      expect(writeWorkflowConditionGroup(group.mode, group.rows)).toEqual(
        condition,
      );
    }
  });

  it('adds a second rule as "all", with no value chosen yet', () => {
    expect(addWorkflowConditionRow(isNo)).toEqual({
      kind: 'all',
      conditions: [isNo, WORKFLOW_CONDITION_UNSET],
    });
  });

  it('adds to a group in place, keeping its mode', () => {
    expect(
      addWorkflowConditionRow({ kind: 'any', conditions: [isNo, other] }),
    ).toEqual({
      kind: 'any',
      conditions: [isNo, other, WORKFLOW_CONDITION_UNSET],
    });
  });

  it('collapses to the one rule left when a group shrinks to one, and a lone rule removes to nothing', () => {
    expect(
      removeWorkflowConditionRow({ kind: 'all', conditions: [isNo, other] }, 1),
    ).toEqual(isNo);
    expect(removeWorkflowConditionRow(isNo, 0)).toBeUndefined();
  });

  it.each(['any', 'all'] as const)('keeps the negation when removing from a negated %s group', (kind) => {
    const condition: WorkflowCondition = {
      kind: 'not',
      condition: { kind, conditions: [isNo, other] },
    };
    const remaining = removeWorkflowConditionRow(condition, 1);
    expect(remaining).toEqual({
      kind: 'not',
      condition: { kind, conditions: [isNo] },
    });
    expect(removeWorkflowConditionRow(remaining!, 0)).toBeUndefined();
  });
});
