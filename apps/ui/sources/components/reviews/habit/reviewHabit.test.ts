import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowAttachedTriggerPageV1Schema,
  WorkflowTriggerAddRequestV1Schema,
  WorkflowTriggerSetV1Schema,
} from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

const {
  buildReviewHabitTriggerRequest,
  findAccountReviewHabit,
  findReviewHabitRow,
  projectReviewHabitPlacement,
  REVIEW_HABIT_WORKFLOW_ID,
} = await import('./reviewHabit');
const { projectAccountTriggerRows } =
  await import('@/components/workflows/triggers/accountTriggerRows');

const reviewer = { kind: 'engine' as const, engineId: 'coderabbit' };
const changedFiles = {
  v: 1,
  all: [{ op: 'eq', field: '/changedFiles', value: true }],
};

describe('buildReviewHabitTriggerRequest', () => {
  it("links this Session's turns that end with changes to the built-in review, with the reviewers chosen at setup", () => {
    const request = buildReviewHabitTriggerRequest(
      { kind: 'session', homeId: 'home-1', sessionId: 'session-1' },
      [reviewer],
    );
    expect(WorkflowTriggerAddRequestV1Schema.parse(request)).toMatchObject({
      workflow: REVIEW_HABIT_WORKFLOW_ID,
      lifetimeSession: { sessionId: 'session-1' },
      inputs: { reviewers: [reviewer] },
      trigger: {
        kind: 'sessionLifecycle',
        enabled: true,
        events: ['parentTurnCompleted'],
        filter: changedFiles,
        subject: {
          kind: 'session',
          serverId: 'home-1',
          sessionId: 'session-1',
        },
      },
    });
  });
  it('makes the all-sessions habit an Account trigger with no Session subject, placed where the reviewer runs', () => {
    const project = { machineId: 'machine-1', directory: '/code/app' };
    const request = buildReviewHabitTriggerRequest(
      { kind: 'account', project },
      [reviewer],
    );
    const parsed = WorkflowTriggerAddRequestV1Schema.parse(request);
    expect(parsed).toMatchObject({
      workflow: REVIEW_HABIT_WORKFLOW_ID,
      project,
      inputs: { reviewers: [reviewer] },
      trigger: {
        kind: 'sessionLifecycle',
        events: ['parentTurnCompleted'],
        filter: changedFiles,
      },
    });
    expect(parsed).not.toHaveProperty('lifetimeSession');
    expect((parsed as { trigger: object }).trigger).not.toHaveProperty(
      'subject',
    );
  });
});

describe('findReviewHabitRow', () => {
  const attached = (
    automationId: string,
    workflowDefinitionId: string,
    summary: object,
    enabled = true,
  ) => ({
    automationId,
    triggerId: `${automationId}-t`,
    workflowDefinitionId,
    relation: 'direct' as const,
    enabled,
    revision: 1,
    summary,
    setUpBy: { accountId: 'viewer', displayName: null },
  });
  const rows = (...attachedRows: ReturnType<typeof attached>[]) =>
    projectAccountTriggerRows({
      sets: [],
      accountId: 'viewer',
      attachedPage: WorkflowAttachedTriggerPageV1Schema.parse({
        attached: attachedRows,
        nextCursor: null,
        skippedNotSharedCount: 0,
      }),
      resolveWorkflowTitle: () => null,
    });
  const turnEnds = {
    kind: 'sessionLifecycle',
    events: ['parentTurnCompleted'],
  };

  it("reads the Session's review habit from its own trigger rows, off when its trigger is off", () => {
    const other = attached(
      'other',
      '00000000-0000-4000-8000-000000000001',
      turnEnds,
    );
    const habit = attached('habit', REVIEW_HABIT_WORKFLOW_ID, turnEnds, false);
    expect(findReviewHabitRow(rows(other, habit))).toMatchObject({
      automationId: 'habit',
      off: true,
    });
  });
  it('has no habit when the built-in review runs on something other than a turn ending', () => {
    const nightly = attached('nightly', REVIEW_HABIT_WORKFLOW_ID, {
      kind: 'schedule',
      schedule: {
        kind: 'cron',
        scheduleExpr: '0 3 * * *',
        everyMs: null,
        timezone: null,
      },
      remainingOccurrences: null,
    });
    expect(findReviewHabitRow(rows(nightly))).toBeNull();
  });
});

describe('the all-sessions review habit', () => {
    const modelReviewer = (directory: object) => ({ kind: 'model' as const, launch: {
        executionTarget: { serverId: 'home-1', machineId: 'machine-1' }, directory,
        agentTarget: { kind: 'builtIn', agentId: 'claude' } } }) as never;

    it('runs where its reviewer was set up: the reviewer\'s Machine and folder', () => {
        expect(projectReviewHabitPlacement(modelReviewer({ kind: 'path', path: '/code/app' })))
            .toEqual({ machineId: 'machine-1', directory: '/code/app' });
        expect(projectReviewHabitPlacement(modelReviewer({ kind: 'managed' }))).toBeNull();
    });
    it('is the Account trigger that runs the built-in review when any session\'s turn completes', () => {
        const set = (automationId: string, trigger: object, scopeSessionId: string | null = null) => WorkflowTriggerSetV1Schema.parse({
            automationId, revision: 1, enabled: true, health: 'available', scopeSessionId,
            target: { kind: 'workflow', ref: REVIEW_HABIT_WORKFLOW_ID }, triggers: [trigger] });
        const lifecycle = (id: string, extra: object = {}) => ({ id, revision: 1, enabled: true, createdAt: 1, updatedAt: 1,
            kind: 'sessionLifecycle', triggerDefinitionEnvelope: 'opened-definition', events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' },
            remainingOccurrences: null, status: { state: 'waiting', runId: null }, ...extra });
        const sessionScoped = set('session-habit', lifecycle('t1'), 'session-1');
        const accountHabit = set('account-habit', lifecycle('t2'));
        expect(findAccountReviewHabit([sessionScoped])).toBeNull();
        expect(findAccountReviewHabit([sessionScoped, accountHabit])).toMatchObject({ automationId: 'account-habit', triggerId: 't2', enabled: true });
    });
});
