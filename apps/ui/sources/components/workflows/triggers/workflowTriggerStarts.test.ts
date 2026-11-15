import { describe, expect, it } from 'vitest';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';

import {
  EMPTY_WORKFLOW_TRIGGER_DRAFT,
  editWorkflowTriggerDraft,
} from './workflowTriggerDraft';
import {
  commitWorkflowTriggerWhen,
  createWorkflowTriggerStartWhen,
  readWorkflowTriggerStart,
  removeWorkflowTriggerRow,
} from './workflowTriggerStarts';

const savedId = AutomationTriggerIdSchema.parse('trigger-saved');

describe('workflow trigger starts (the "When it runs" card)', () => {
  it('groups every trigger kind under the Starts choice it is edited with', () => {
    expect(
      readWorkflowTriggerStart(createWorkflowTriggerStartWhen('schedule')),
    ).toBe('schedule');
    expect(readWorkflowTriggerStart({ kind: 'pluginEvent', value: null })).toBe(
      'pluginEvent',
    );
    for (const kind of [
      'turnEnds',
      'needsYou',
      'sessionArchived',
      'sessionStarts',
    ] as const) {
      expect(readWorkflowTriggerStart({ kind })).toBe('sessionEvent');
    }
    expect(
      readWorkflowTriggerStart({ kind: 'ciFailed', pullRequest: null }),
    ).toBe('sessionPullRequest');
    expect(
      readWorkflowTriggerStart({
        kind: 'runLifecycle',
        condition: 'terminal',
        source: { kind: 'workflow_run', runId: 'run-1' },
      }),
    ).toBe('runEvent');
  });

  it('a new schedule is complete at once and joins the draft as an addition', () => {
    const when = createWorkflowTriggerStartWhen('schedule');
    const draft = commitWorkflowTriggerWhen({
      draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
      row: { kind: 'new', clientId: 'c1' },
      when,
      enabled: true,
    });
    expect(draft?.adds).toMatchObject([
      {
        clientId: 'c1',
        trigger: {
          kind: 'schedule',
          enabled: true,
          schedule: { kind: 'cron', scheduleExpr: '0 9 * * *' },
        },
      },
    ]);
  });

  it('a session event waits for its Session, then writes an Account lifecycle trigger on that Session', () => {
    const pending = createWorkflowTriggerStartWhen('sessionEvent');
    expect(
      commitWorkflowTriggerWhen({
        draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
        row: { kind: 'new', clientId: 'c1' },
        when: pending,
        enabled: true,
      }),
    ).toBeNull();
    const draft = commitWorkflowTriggerWhen({
      draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
      row: { kind: 'new', clientId: 'c1' },
      when: { kind: 'needsYou', sourceSessionId: 'session-a' },
      enabled: true,
    });
    expect(draft?.adds).toEqual([
      {
        clientId: 'c1',
        trigger: {
          kind: 'sessionLifecycle',
          enabled: true,
          sourceSessionId: 'session-a',
          events: ['userActionRequired'],
          policy: { kind: 'everyMatch' },
        },
      },
    ]);
  });

  it('switching a session event keeps the chosen Session', () => {
    expect(
      createWorkflowTriggerStartWhen('sessionEvent', {
        kind: 'turnEnds',
        sourceSessionId: 'session-a',
      }),
    ).toEqual({ kind: 'turnEnds', sourceSessionId: 'session-a' });
  });

  it('an edited saved trigger becomes an update without its enabled bit in the definition', () => {
    const draft = commitWorkflowTriggerWhen({
      draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
      row: { kind: 'saved', triggerId: savedId },
      when: createWorkflowTriggerStartWhen('schedule'),
      enabled: false,
    });
    expect(draft?.updates[savedId]).toEqual({
      enabled: false,
      trigger: {
        kind: 'schedule',
        schedule: {
          kind: 'cron',
          scheduleExpr: '0 9 * * *',
          everyMs: null,
          timezone: expect.anything(),
        },
      },
    });
  });

  it('an incomplete or listed-only When leaves the draft untouched (a Session PR trigger, an unset Event)', () => {
    for (const when of [
      { kind: 'ciFailed' as const, pullRequest: { repository: 'acme/widgets', number: 7 } },
      createWorkflowTriggerStartWhen('pluginEvent'),
    ]) {
      expect(
        commitWorkflowTriggerWhen({
          draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
          row: { kind: 'saved', triggerId: savedId },
          when,
          enabled: true,
        }),
      ).toBeNull();
    }
  });

  it('removing a saved trigger marks it removed; removing an unsaved one discards it', () => {
    const added = editWorkflowTriggerDraft(EMPTY_WORKFLOW_TRIGGER_DRAFT, {
      kind: 'add',
      clientId: 'c1',
      trigger: {
        kind: 'schedule',
        enabled: true,
        schedule: { kind: 'once', scheduledAt: 1 },
      },
    });
    expect(
      removeWorkflowTriggerRow(added, { kind: 'new', clientId: 'c1' }).adds,
    ).toEqual([]);
    expect(
      removeWorkflowTriggerRow(EMPTY_WORKFLOW_TRIGGER_DRAFT, {
        kind: 'saved',
        triggerId: savedId,
      }).removes,
    ).toEqual([savedId]);
  });
});
