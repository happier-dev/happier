import { describe, expect, it } from 'vitest';
import * as catalog from './catalog.js';
import { validateWorkflowDefinition } from '../workflowValidationV1.js';
import { parseWorkflowDefinitionRefV1 } from '../workflowDefinitionRefV1.js';
import { WorkflowDefinitionBaseSchema, type WorkflowBlock } from '../workflowV1.js';

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
  it('makes built-ins discoverable without a saved Artifact or UI loader', () => {
    expect(catalog.getBuiltinWorkflowCatalogV1().map((entry) => entry.id)).toEqual([
      'builtin:keep-going',
      'builtin:review-and-converge', 'builtin:plan-with-a-panel', 'builtin:open-a-pull-request',
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

  it.each(['keep-going', 'review-and-converge', 'plan-with-a-panel', 'open-a-pull-request'])('ships a strict, semantically valid %s definition', (id) => {
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
      'ask-once', 'review-pull-request', 'work-through-each-file', 'repair-until-it-passes', 'triage-an-issue', 'morning-digest',
      'notify-when-agent-waits', 'daily-summary-in-session', 'memory-upkeep-in-session', 'install-deps-in-worktree', 'test-after-every-turn',
    ]);
    for (const example of examples) {
      expect(WorkflowDefinitionBaseSchema.safeParse(example.definition).success, example.key).toBe(true);
      expect(validateWorkflowDefinition(example.definition).issues, example.key).toEqual([]);
      expect(example.definition.finalOutput, example.key).toBeDefined();
      expect(parseWorkflowDefinitionRefV1(example.key)).toBeNull();
      expect(catalog.resolveBuiltinWorkflowDefinitionV1(example.key)).toBeNull();
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
