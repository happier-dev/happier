import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';

import {
  EMPTY_WORKFLOW_TRIGGER_DRAFT,
  editWorkflowTriggerDraft,
} from './workflowTriggerDraft';
import {
  buildWorkflowTriggerStartOptions,
  commitWorkflowTriggerWhen,
  createWorkflowTriggerStartWhen,
  readWorkflowTriggerStart,
  readWorkflowTriggerStartId,
  removeWorkflowTriggerRow,
} from './workflowTriggerStarts';
import { buildTriggerDefinition, readTriggerWhen, type TriggerWhenValue } from './sessionTriggerForm';
import { formatTriggerSetSentence } from './formatTriggerSummary';

const start = (id: string, previous?: TriggerWhenValue): TriggerWhenValue => {
  const when = createWorkflowTriggerStartWhen(id, previous);
  if (when === null) throw new Error(`no start ${id}`);
  return when;
};

const savedId = AutomationTriggerIdSchema.parse('trigger-saved');

describe('workflow trigger starts (the "When it runs" card)', () => {
  it('lists Time, then Sessions, then each plugin\'s declared Events grouped by plugin, and reads every start back', () => {
    const options = buildWorkflowTriggerStartOptions([
      { eventRef: { pluginId: 'happier.github', localId: 'pr-opened' }, title: 'A pull request opens', pluginName: 'GitHub' },
      { eventRef: { pluginId: 'happier.sentry', localId: 'issue' }, title: 'A new issue appears', pluginName: 'Sentry' },
      { eventRef: { pluginId: 'happier.github', localId: 'issue-opened' }, title: 'An issue opens', pluginName: 'GitHub' },
    ]);
    expect(options.map((option) => [option.id, option.group])).toEqual([
      ['schedule', t('workflows.triggers.card.groupTime')],
      ['action:before', t('workflows.triggers.card.groupActions')],
      ['action:after', t('workflows.triggers.card.groupActions')],
      ['session:turnEnds', t('workflows.triggers.card.groupSessions')],
      ['session:needsYou', t('workflows.triggers.card.groupSessions')],
      ['session:sessionArchived', t('workflows.triggers.card.groupSessions')],
      ['event:happier.github/pr-opened', 'GitHub'],
      ['event:happier.github/issue-opened', 'GitHub'],
      ['event:happier.sentry/issue', 'Sentry'],
    ]);
    for (const option of options) expect(readWorkflowTriggerStartId(start(option.id))).toBe(option.id);
    expect(start('event:happier.sentry/issue')).toEqual({ kind: 'pluginEvent', value: null,
      eventRef: { pluginId: 'happier.sentry', localId: 'issue' } });
  });

  it('groups the built-in triggers first, then each plugin by plugin name, keeping declaration order within a plugin', () => {
    const options = buildWorkflowTriggerStartOptions([
      { eventRef: { pluginId: 'happier.sentry', localId: 'issue' }, title: 'A new issue appears', pluginName: 'Sentry' },
      { eventRef: { pluginId: 'happier.github', localId: 'pr-opened' }, title: 'A pull request opens', pluginName: 'GitHub' },
      { eventRef: { pluginId: 'happier.gitlab', localId: 'push' }, title: 'Someone pushes', pluginName: 'GitLab' },
      { eventRef: { pluginId: 'happier.github', localId: 'pr-merged' }, title: 'A pull request merges', pluginName: 'GitHub' },
    ]);
    expect(options.map((option) => [option.section, option.group, option.id])).toEqual([
      ['builtin', t('workflows.triggers.card.groupTime'), 'schedule'],
      ['builtin', t('workflows.triggers.card.groupActions'), 'action:before'],
      ['builtin', t('workflows.triggers.card.groupActions'), 'action:after'],
      ['builtin', t('workflows.triggers.card.groupSessions'), 'session:turnEnds'],
      ['builtin', t('workflows.triggers.card.groupSessions'), 'session:needsYou'],
      ['builtin', t('workflows.triggers.card.groupSessions'), 'session:sessionArchived'],
      ['plugins', 'GitHub', 'event:happier.github/pr-opened'],
      ['plugins', 'GitHub', 'event:happier.github/pr-merged'],
      ['plugins', 'GitLab', 'event:happier.gitlab/push'],
      ['plugins', 'Sentry', 'event:happier.sentry/issue'],
    ]);
  });

  it('leads with the resource\'s own group in a resource host, then everything else in the usual groups', () => {
    const options = buildWorkflowTriggerStartOptions([
      { eventRef: { pluginId: 'happier.github', localId: 'pr-opened' }, title: 'A pull request opens', pluginName: 'GitHub' },
      { eventRef: { pluginId: 'happier.deploy', localId: 'failed' }, title: 'A deploy fails', pluginName: 'Deployments' },
    ], undefined, { resource: { title: 'Production · happier-web', startIds: ['event:happier.deploy/failed', 'session:needsYou'] } });
    expect(options.map((option) => [option.section, option.group, option.id])).toEqual([
      ['resource', 'Production · happier-web', 'event:happier.deploy/failed'],
      ['resource', 'Production · happier-web', 'session:needsYou'],
      ['builtin', t('workflows.triggers.card.groupTime'), 'schedule'],
      ['builtin', t('workflows.triggers.card.groupActions'), 'action:before'],
      ['builtin', t('workflows.triggers.card.groupActions'), 'action:after'],
      ['builtin', t('workflows.triggers.card.groupSessions'), 'session:turnEnds'],
      ['builtin', t('workflows.triggers.card.groupSessions'), 'session:sessionArchived'],
      ['plugins', 'GitHub', 'event:happier.github/pr-opened'],
    ]);
  });

  it('starts before an Action waiting for its result, keeps the chosen Action across phases, and is set up only once an Action is chosen', () => {
    const before = start('action:before');
    expect(before).toEqual({ kind: 'action', phase: 'before', actionIds: [], mode: 'wait' });
    expect(buildTriggerDefinition({ when: before, enabled: true, sessionId: null })).toBeNull();
    expect(commitWorkflowTriggerWhen({ draft: EMPTY_WORKFLOW_TRIGGER_DRAFT, row: { kind: 'new', clientId: 'c1' }, when: before, enabled: true })).toBeNull();

    const chosen: TriggerWhenValue = { kind: 'action', phase: 'before', actionIds: ['deployments.deploy'], mode: 'wait', onFailure: 'ask' };
    const draft = commitWorkflowTriggerWhen({ draft: EMPTY_WORKFLOW_TRIGGER_DRAFT, row: { kind: 'new', clientId: 'c1' }, when: chosen, enabled: true });
    expect(draft?.adds).toEqual([expect.objectContaining({ clientId: 'c1', trigger: { ...chosen, enabled: true } })]);

    // After keeps the Action but never a wait policy (P02: after Actions do not wait for a check).
    expect(start('action:after', chosen)).toEqual({ kind: 'action', phase: 'after', actionIds: ['deployments.deploy'] });
    expect(readWorkflowTriggerStartId(chosen)).toBe('action:before');
    expect(readWorkflowTriggerStart(chosen)).toBe('action');
  });

  it('joins the triggers into one sentence: every summary after the first starts lowercase, a name keeps its capitals', () => {
    const turnEnds = { kind: 'sessionLifecycle' as const, sourceSessionId: 's', events: ['parentTurnCompleted' as const, 'parentTurnFailed' as const,
      'parentTurnCancelled' as const], policy: { kind: 'everyMatch' as const } };
    const daily = { kind: 'schedule' as const, schedule: { kind: 'cron' as const, scheduleExpr: '0 9 * * *', everyMs: null, timezone: null } };
    const sentence = formatTriggerSetSentence([turnEnds, daily]);
    expect(sentence.startsWith('When a turn ends')).toBe(true);
    expect(sentence).toMatch(/ and every day at /);
    const named = formatTriggerSetSentence([turnEnds, { kind: 'pluginEvent' as const, eventRef: { pluginId: 'p.github', localId: 'x' },
      displayLabel: 'GitHub releases' }]);
    expect(named).toMatch(/ and GitHub releases$/);
    expect(formatTriggerSetSentence([])).toBe('When you press Run now');
  });

  it('keeps a saved start the catalog no longer offers choosable as it is', () => {
    const options = buildWorkflowTriggerStartOptions([], { when: { kind: 'pluginEvent', value: null,
      eventRef: { pluginId: 'gone.plugin', localId: 'evt' } }, title: 'Old event' });
    expect(options.at(-1)).toMatchObject({ id: 'event:gone.plugin/evt', title: 'Old event' });
    expect(buildWorkflowTriggerStartOptions([], { when: { kind: 'sessionStarts' }, title: 'x' })
      .some((option) => option.id === 'session:sessionStarts')).toBe(true);
  });

  it('groups every trigger kind under the start it is edited with', () => {
    expect(
      readWorkflowTriggerStart(start('schedule')),
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
    const when = start('schedule');
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
    const pending = start('session:turnEnds');
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

  it('switching a session event keeps the chosen Session and How often', () => {
    expect(
      start('session:needsYou', {
        kind: 'turnEnds',
        subject: { kind: 'session', serverId: 'home', sessionId: 'session-a' },
        nextTimeOnly: true,
      }),
    ).toEqual({ kind: 'needsYou', subject: { kind: 'session', serverId: 'home', sessionId: 'session-a' }, nextTimeOnly: true });
  });

  it.each([
    { kind: 'session', serverId: 'home', sessionId: 'session-a' },
    { kind: 'project', serverId: 'home', projectKey: 'project-a' },
  ] as const)('changes the Event group without losing its $kind subject or retained match budget', subject => {
    const when = start('session:needsYou', { kind: 'turnEnds',
      subject,
      events: ['parentTurnFailed'], policy: { kind: 'nextMatches', count: 2 } });
    const draft = commitWorkflowTriggerWhen({ draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
      row: { kind: 'new', clientId: 'retained-project' }, when, enabled: true });
    expect(draft?.adds[0]?.trigger).toEqual({ kind: 'sessionLifecycle', enabled: true,
      subject,
      events: ['userActionRequired'], policy: { kind: 'nextMatches', count: 2 } });
  });

  it('How often "Next time" writes the first-match policy and reads back as it was written', () => {
    const trigger = buildTriggerDefinition({ when: { kind: 'turnEnds', sourceSessionId: 'session-a', nextTimeOnly: true },
      enabled: true, sessionId: null });
    expect(trigger).toMatchObject({ kind: 'sessionLifecycle', policy: { kind: 'firstMatch' } });
    expect(readTriggerWhen({ id: 'saved', revision: 1, enabled: true, createdAt: 1, updatedAt: 1, ...trigger } as never))
      .toEqual({ kind: 'turnEnds', sourceSessionId: 'session-a', nextTimeOnly: true });
    expect(buildTriggerDefinition({ when: { kind: 'turnEnds', sourceSessionId: 'session-a' }, enabled: true, sessionId: null }))
      .toMatchObject({ policy: { kind: 'everyMatch' } });
  });

  it('an edited saved trigger becomes an update without its enabled bit in the definition', () => {
    const draft = commitWorkflowTriggerWhen({
      draft: EMPTY_WORKFLOW_TRIGGER_DRAFT,
      row: { kind: 'saved', triggerId: savedId },
      when: start('schedule'),
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
      start('event:acme.github/issue-opened'),
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
