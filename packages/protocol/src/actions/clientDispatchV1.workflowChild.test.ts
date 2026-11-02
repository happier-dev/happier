import { describe, expect, it } from 'vitest';
import type { ActionId } from './actionIds.js';
import {
  isWorkflowHostAdmittedChildActionIdV1,
  UiActionChildExecuteRequestV1Schema,
} from './clientDispatchV1.js';

const ADMITTED: readonly ActionId[] = [
  'workflow.definition.create',
  'workflow.definition.update',
  'workflow.definition.edit',
  'workflow.definition.delete',
  'workflow.trigger.list',
  'workflow.trigger.add',
  'workflow.trigger.update',
  'workflow.trigger.remove',
  'workflow.trigger.test',
  'session.trigger.list',
  'session.trigger.add',
  'session.trigger.update',
  'session.trigger.remove',
];
// A future trigger-prefixed Action must be listed deliberately, never admitted by its prefix.
const UNLISTED_TRIGGER_IDS = [
  'workflow.trigger.export',
  'session.trigger.export',
] as unknown as readonly ActionId[];
const request = (actionId: string) => ({
  v: 1,
  parentRequestId: 'parent',
  sessionId: 'session',
  actionId,
  input: {},
});

describe('admitted client Action Workflow child family', () => {
  it('admits exactly the listed definition and trigger Actions', () => {
    for (const actionId of ADMITTED) {
      expect(isWorkflowHostAdmittedChildActionIdV1(actionId)).toBe(true);
      expect(
        UiActionChildExecuteRequestV1Schema.safeParse(request(actionId))
          .success,
      ).toBe(true);
    }
  });

  it('refuses run_now and an unlisted trigger-prefixed Action', () => {
    expect(
      isWorkflowHostAdmittedChildActionIdV1('workflow.trigger.run_now'),
    ).toBe(false);
    expect(
      UiActionChildExecuteRequestV1Schema.safeParse(
        request('workflow.trigger.run_now'),
      ).success,
    ).toBe(false);
    for (const actionId of UNLISTED_TRIGGER_IDS)
      expect(isWorkflowHostAdmittedChildActionIdV1(actionId)).toBe(false);
  });
});
