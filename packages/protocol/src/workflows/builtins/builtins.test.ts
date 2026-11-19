import { describe, expect, it } from 'vitest';
import * as catalog from './catalog.js';
import { WORKFLOW_STARTER_EXAMPLES_V1, materializeWorkflowStarterExample, workflowStarterRequiresSession } from './examples.js';
import { validateWorkflowDefinition } from '../workflowValidationV1.js';
import { parseWorkflowDefinitionRefV1 } from '../workflowDefinitionRefV1.js';
import { WorkflowDefinitionBaseSchema, type WorkflowBlock } from '../workflowV1.js';
import { AutomationTriggerDefinitionInputSchema } from '../../automations/automationTriggerDefinition.js';
import { WorkflowStartersListResultV1Schema, WorkflowStartersResolveResultV1Schema } from './starterActionsV1.js';

function listBlocks(blocks: readonly WorkflowBlock[]): WorkflowBlock[] {
  return blocks.flatMap((block) => {
    if (block.kind === 'parallel') return [block, ...block.branches.flatMap((branch) => listBlocks(branch.blocks))];
    if (block.kind === 'if') return [block, ...listBlocks(block.then), ...listBlocks(block.otherwise)];
    if (block.kind === 'loop') return [block, ...listBlocks(block.body),
      ...(block.repetition.kind === 'evaluate' ? [block.repetition.evaluator] : [])];
    return [block];
  });
}

describe('built-in workflow catalog', () => {
  it('offers a schedulable Hunt through one repository-scoped review admission', () => {
    const entry = catalog.getBuiltinWorkflowCatalogV1().find(entry => entry.id === 'builtin:repository-review');
    expect(entry).toBeDefined();
    expect(entry?.requiresOriginSession).toBe(false);
    expect(validateWorkflowDefinition(entry?.definition).issues).toEqual([]);
    const choice = entry?.definition.blocks[0];
    expect(choice?.kind).toBe('if');
    if (choice?.kind !== 'if') throw new Error('missing_hunt_composition');
    for (const branch of [choice.then, choice.otherwise]) expect(branch).toEqual([
      expect.objectContaining({ kind: 'action', actionId: 'review.start', input: expect.objectContaining({
        scope: { kind: 'literal', value: 'repository' }, reviewers: { kind: 'input', name: 'reviewers' },
      }) }),
    ]);
    expect(choice.then[0]).toMatchObject({ input: { steps: { kind: 'input', name: 'steps' } } });
    expect(choice.otherwise[0]).not.toHaveProperty('input.steps');
  });
  // F5 (owner 2026-11-12): each built-in carries its own presentation mark; several share a purpose.
  it('gives every built-in its own mark', () => {
    const icons = catalog.getBuiltinWorkflowCatalogV1().map((entry) => entry.icon);
    expect(icons.every((icon) => typeof icon === 'string' && icon.length > 0)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('offers independent implementation worktrees followed by read-only human review', () => {
    const definition = catalog.resolveBuiltinWorkflowDefinitionV1('parallel-implementations')?.definition;
    expect(definition).toBeDefined();
    if (!definition) throw new Error('missing_parallel_implementations');
    expect(validateWorkflowDefinition(definition).issues).toEqual([]);
    expect(definition.inputs.filter(input => input.inputType && 'hostType' in input.inputType
      && input.inputType.hostType === 'agentParticipant'))
      .toHaveLength(3);
    const implementations = definition.blocks[0];
    expect(implementations?.kind).toBe('parallel');
    if (implementations?.kind !== 'parallel') throw new Error('missing_parallel_branches');
    expect(implementations.branches).toHaveLength(3);
    for (const branch of implementations.branches) {
      expect(branch.blocks).toHaveLength(1);
      expect(branch.blocks[0]).toMatchObject({ kind: 'step', execution: {
        participant: { kind: 'input', name: branch.id },
        workspace: { kind: 'new_worktree', source: { kind: 'original' } },
      } });
    }
    expect(definition.blocks.at(-1)).toMatchObject({ kind: 'step', pauseForReview: true,
      execution: { permissionMode: 'read-only', workspace: { kind: 'project_checkout' } } });
  });
  it('binds round presentation only to the accepted catalog version and originating Discussion', () => {
    const resultDelivery = { kind: 'originating_discussion' as const,
      discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq: 1 };
    expect(catalog.readWorkflowDiscussionRoundBindingV1({ source: { kind: 'catalog', ref: 'builtin:answer-and-review', version: 1 }, resultDelivery }))
      .toEqual({ discussionId: 'discussion', pattern: 'answer_and_review' });
    for (const source of [
      { kind: 'inline' as const },
      { kind: 'catalog' as const, ref: 'builtin:fresh-opinions', version: 2 },
      { kind: 'catalog' as const, ref: 'plugin:external/fresh-opinions', version: '1' },
      { kind: 'catalog' as const, ref: 'builtin:debate', version: 1 },
    ]) expect(catalog.readWorkflowDiscussionRoundBindingV1({ source, resultDelivery })).toBeUndefined();
    expect(catalog.readWorkflowDiscussionRoundBindingV1({ source: { kind: 'catalog', ref: 'builtin:fresh-opinions', version: 1 } })).toBeUndefined();
  });
  it('binds the review publication to its exact answer, and rejects an unavailable parent', () => {
    const definition = catalog.resolveBuiltinWorkflowDefinitionV1('answer-and-review')!.definition;
    const review = listBlocks(definition.blocks).find(block => block.id === 'review');
    expect(review).toMatchObject({ discussionReplyTo: { blockId: 'answer', scope: { kind: 'outer', levels: 1 } } });
    const invalid = structuredClone(definition);
    const invalidReview = listBlocks(invalid.blocks).find(block => block.id === 'review')!;
    Object.assign(invalidReview, { discussionReplyTo: { blockId: 'missing', scope: { kind: 'outer', levels: 1 } } });
    expect(validateWorkflowDefinition(invalid).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_reference', blockId: 'review' }),
    ]));
  });
  it('makes built-ins discoverable without a saved Artifact or UI loader', () => {
    expect(catalog.getBuiltinWorkflowCatalogV1().map((entry) => entry.id)).toEqual([
      'builtin:keep-going',
      'builtin:review-and-converge', 'builtin:plan-with-a-panel', 'builtin:open-a-pull-request',
      'builtin:fresh-opinions', 'builtin:parallel-implementations', 'builtin:answer-and-review', 'builtin:debate', 'builtin:repository-review', 'builtin:review-pull-request',
    ]);
  });

  it('resolves a catalog reference through the canonical parser into a valid portable plan', () => {
    const ref = parseWorkflowDefinitionRefV1('builtin:plan-with-a-panel');
    expect(ref?.kind).toBe('builtin');
    if (ref?.kind !== 'builtin') throw new Error('Expected the canonical builtin arm');
    const resolved = catalog.resolveBuiltinWorkflowDefinitionV1(ref.id);
    expect(resolved?.version).toBe(1);
    expect(validateWorkflowDefinition(resolved?.definition).issues).toEqual([]);
  });

  it('supplies the portable body directly when a consumer duplicates a runnable catalog row', () => {
    const entry = catalog.getBuiltinWorkflowCatalogV1().find((item) => item.id === 'builtin:plan-with-a-panel');
    expect(entry).toHaveProperty('definition');
    const definition: unknown = entry && 'definition' in entry ? entry.definition : undefined;
    expect(WorkflowDefinitionBaseSchema.safeParse(definition).success).toBe(true);
  });

  it.each(['keep-going', 'review-and-converge', 'plan-with-a-panel', 'open-a-pull-request',
    'fresh-opinions', 'parallel-implementations', 'answer-and-review', 'debate', 'repository-review', 'review-pull-request'])('ships a strict, semantically valid %s definition', (id) => {
    const resolved = catalog.resolveBuiltinWorkflowDefinitionV1(id);
    expect(resolved).not.toBeNull();
    expect(WorkflowDefinitionBaseSchema.safeParse(resolved?.definition).success).toBe(true);
    expect(validateWorkflowDefinition(resolved?.definition).issues).toEqual([]);
  });

  it('does not route malformed, plugin or Artifact references as built-ins', () => {
    for (const id of ['plan-with-a-panel ', 'builtin:plan-with-a-panel', 'plugin:example/workflow',
      '00000000-0000-4000-8000-000000000000', 'keep-going-until-done', 'unknown']) {
      expect(catalog.resolveBuiltinWorkflowDefinitionV1(id)).toBeNull();
    }
  });

  it('offers portable examples through Protocol as unsaved seeds', () => {
    const examples = catalog.getWorkflowStarterExamplesV1();
    expect(examples.map((entry) => entry.key)).toEqual([
      'ask-once', 'review-pull-request', 'work-through-each-file', 'repair-until-it-passes', 'triage-an-issue', 'morning-digest', 'deploy-on-push',
      'notify-when-agent-waits', 'daily-summary-in-session', 'memory-upkeep-in-session', 'install-deps-in-worktree', 'test-after-every-turn',
      'check-for-drift', 'run-a-job-on-a-schedule',
      'backup-verify', 'nightly-backups', 'deployment-move', 'deployment-data-move', 'restore-drill', 'daily-health-digest', 'restart-when-needed',
      'investigate-failing-pr-check', 'review-opened-pull-request', 'weekly-dependency-check', 'investigate-new-sentry-issue',
    ]);
    for (const example of examples) {
      expect(WorkflowDefinitionBaseSchema.safeParse(example.definition).success, example.key).toBe(true);
      expect(validateWorkflowDefinition(example.definition).issues, example.key).toEqual([]);
      expect(parseWorkflowDefinitionRefV1(example.key)).toBeNull();
      if (example.key !== 'review-pull-request' && example.key !== 'review-opened-pull-request'
        && example.key !== 'investigate-new-sentry-issue') {
        expect(example.definition.finalOutput, example.key).toBeDefined();
      }
      if (example.key !== 'review-pull-request') {
        expect(catalog.resolveBuiltinWorkflowDefinitionV1(example.key)).toBeNull();
      } else {
        expect(catalog.resolveBuiltinWorkflowDefinitionV1(example.key)?.definition).toEqual(example.definition);
      }
    }
  });

  it('carries deferred Event setup through the list and resolve Actions without fabricating a configured trigger', () => {
    const { examples } = WorkflowStartersListResultV1Schema.parse({ examples: catalog.getWorkflowStarterExamplesV1() });
    for (const [key, pluginId, localId] of [
      ['investigate-failing-pr-check', 'happier.scm.forge.github', 'automation/pull-request-checks-failed-v1'],
      ['review-opened-pull-request', 'happier.scm.forge.github', 'automation/pull-request-lifecycle-v1'],
      ['investigate-new-sentry-issue', 'happier.sentry', 'issue-transition'],
    ] as const) {
      const example = examples.find(entry => entry.key === key)!;
      const resolved = WorkflowStartersResolveResultV1Schema.parse(materializeWorkflowStarterExample(example));
      expect(resolved).toMatchObject({ status: 'ready', example: { eventSeed: { eventRef: { pluginId, localId }, setupInput: {} } } });
      expect(resolved).not.toHaveProperty('example.trigger');
    }
  });

  it('seeds notification and test habits with the actual lifecycle events, rather than only example bodies', () => {
    const examples = catalog.getWorkflowStarterExamplesV1();
    const notify = examples.find((entry) => entry.key === 'notify-when-agent-waits');
    const tests = examples.find((entry) => entry.key === 'test-after-every-turn');
    expect(notify).toMatchObject({ triggerSeed: { kind: 'sessionLifecycle', enabled: true,
      events: ['userActionRequired'], policy: { kind: 'everyMatch' } },
      definition: { blocks: [{ kind: 'action', actionId: 'notifications.notify_me' }] } });
    expect(tests).toMatchObject({ triggerSeed: { kind: 'sessionLifecycle', enabled: true,
      events: ['parentTurnCompleted', 'parentTurnFailed', 'parentTurnCancelled'], policy: { kind: 'everyMatch' } },
      definition: { blocks: [{ kind: 'action', actionId: 'machines.command.run', input: { command: { kind: 'literal' } } }] } });
  });

  it('makes the daily summary a session conversation and installation a real new-worktree command', () => {
    const examples = catalog.getWorkflowStarterExamplesV1();
    expect(examples.find((entry) => entry.key === 'daily-summary-in-session')).toMatchObject({
      triggerSeed: { kind: 'schedule', enabled: true, schedule: { kind: 'cron', everyMs: null } },
      definition: { defaults: { conversation: { kind: 'origin_session' } }, blocks: [{ kind: 'step' }] },
    });
    const install = examples.find((entry) => entry.key === 'install-deps-in-worktree');
    expect(install).toMatchObject({ definition: { blocks: [{ kind: 'action', actionId: 'machines.command.run',
      input: { command: { kind: 'literal' } }, execution: { workspace: { kind: 'new_worktree', source: { kind: 'original' } } } }] } });
    expect(install).not.toHaveProperty('triggerSeed');
  });

  it('preserves authored block names when built-ins and starter examples cross the definition boundary', () => {
    const seeds = [
      ...catalog.getBuiltinWorkflowCatalogV1().map((entry) => ({ key: entry.id, definition: entry.definition })),
      ...catalog.getWorkflowStarterExamplesV1(),
    ];
    for (const seed of seeds) {
      const authoredBlocks = listBlocks(seed.definition.blocks);
      const parsed = WorkflowDefinitionBaseSchema.parse(JSON.parse(JSON.stringify(seed.definition)));
      const parsedBlocks = listBlocks(parsed.blocks);
      for (const [index, block] of authoredBlocks.entries()) {
        const name = 'name' in block ? block.name : undefined;
        expect(name, `${seed.key}/${block.id}`).toEqual(expect.any(String));
        expect(name, `${seed.key}/${block.id}`).toBeTruthy();
        expect(parsedBlocks[index], `${seed.key}/${block.id}`).toMatchObject({ id: block.id, name });
      }
    }
  });
});

describe('workflow starter lifecycle subjects', () => {
  const lifecycle = WORKFLOW_STARTER_EXAMPLES_V1.find(entry => entry.key === 'notify-when-agent-waits')!;
  it('binds the selected Session using its portable Home identity', () => {
    const selection = materializeWorkflowStarterExample(lifecycle, {
      session: { sessionId: 'session-one', machineId: 'machine-one', serverId: 'home-one' },
    });
    expect(selection.status).toBe('ready');
    if (selection.status !== 'ready') throw new Error('Expected a bound lifecycle starter');
    expect(AutomationTriggerDefinitionInputSchema.parse(selection.example.trigger)).toMatchObject({
      kind: 'sessionLifecycle', subject: { kind: 'session', serverId: 'home-one', sessionId: 'session-one' },
    });
    expect(selection.example.trigger).not.toHaveProperty('sourceSessionId');
  });
  it('requires the Session Home before binding a lifecycle source', () => {
    expect(materializeWorkflowStarterExample(lifecycle, {
      session: { sessionId: 'session-one', machineId: 'machine-one' },
    })).toEqual({ status: 'requires_session' });
  });
});

describe('workflow starter schedules without a Session', () => {
  const byKey = (key: string) => WORKFLOW_STARTER_EXAMPLES_V1.find((entry) => entry.key === key)!;
  it.each([undefined, { sessionId: 'session-once', machineId: 'machine-once' }])(
    'materializes an absolute schedule without adding timezone fields (Session: %j)', (session) => {
      const schedule = { kind: 'once' as const, scheduledAt: 1_800_000_000_000 };
      const selection = materializeWorkflowStarterExample({ ...byKey('nightly-backups'),
        triggerSeed: { kind: 'schedule', enabled: true, schedule } }, { session, timezone: 'Europe/Zurich' });
      expect(selection.status).toBe('ready');
      if (selection.status !== 'ready') throw new Error('Expected a ready absolute schedule');
      expect(AutomationTriggerDefinitionInputSchema.parse(selection.example.trigger)).toEqual({
        kind: 'schedule', enabled: true, schedule,
      });
    });
  it.each([['nightly-backups', '0 2 * * *'], ['run-a-job-on-a-schedule', '0 3 * * *'],
    ['weekly-dependency-check', '0 9 * * 1']] as const)(
    '%s opens with its schedule off, needing no Session', (key, scheduleExpr) => {
      const selection = materializeWorkflowStarterExample(byKey(key), { timezone: 'Europe/Zurich' });
      expect(workflowStarterRequiresSession(byKey(key))).toBe(false);
      expect(selection).toMatchObject({ status: 'ready', example: { trigger: { kind: 'schedule', enabled: false,
        schedule: { kind: 'cron', scheduleExpr, everyMs: null, timezone: 'Europe/Zurich' } } } });
      expect(selection).not.toHaveProperty('example.sessionTarget');
    });
  it('still asks for a Session when the template runs in one', () => {
    for (const key of ['daily-summary-in-session', 'memory-upkeep-in-session', 'notify-when-agent-waits']) {
      expect(workflowStarterRequiresSession(byKey(key))).toBe(true);
      expect(materializeWorkflowStarterExample(byKey(key)).status).toBe('requires_session');
    }
  });
});
