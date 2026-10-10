import { describe, expect, it } from 'vitest';

import * as leaves from './workflowLeafV1.js';
import { WorkflowDefinitionV1Schema } from './workflowV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import { applyWorkflowDefinitionEditsV1, WorkflowInsertBlockV1Schema } from './workflowDefinitionEditV1.js';

const agent = { kind: 'step', id: 'agent', document: { text: 'Work', references: [], attachments: [] } };
const action = { kind: 'action', id: 'notify', actionId: 'notify', input: { message: { kind: 'literal', value: 'Done' }, engines: { kind: 'list', items: [{ kind: 'item', field: 'value' }] } } };
const workflow = { kind: 'workflow', id: 'child', workflowRef: 'builtin:review-and-converge', input: {} };
const wait = { kind: 'wait', id: 'review', document: { text: 'Choose a value', references: [], attachments: [] }, result: { kind: 'text' } };

describe('workflow leaf seam', () => {
  it('reports missing and invalid literal Action inputs through canonical validity', () => {
    const check = (input: unknown) => validateWorkflowDefinition({ blocks: [{
      kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input,
    }] });
    for (const input of [
      {},
      { message: { kind: 'literal', value: 42 } },
      { message: { kind: 'literal', value: '' } },
      { message: { kind: 'literal', value: ' \t\n ' } },
    ]) {
      expect(check(input).valid).toBe(false);
      expect(check(input).issues).toEqual(expect.arrayContaining([expect.objectContaining({
        code: 'invalid_input', blockId: 'notify', path: '/blocks/0/input/message',
      })]));
    }
    expect(check({ message: { kind: 'literal', value: 'Done' } }).valid).toBe(true);
    expect(check({
      message: { kind: 'literal', value: 'Done' },
      title: { kind: 'literal', value: '' },
    }).valid).toBe(true);
  });

  it('keeps future Action bindings valid while checking other known fields', () => {
    const check = (input: unknown) => validateWorkflowDefinition({
      inputs: [{ name: 'message', valueType: 'string', required: true }],
      blocks: [{ kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input }],
    });
    expect(check({ message: { kind: 'input', name: 'message' } }).valid).toBe(true);
    expect(check({ message: { kind: 'input', name: 'message' }, title: { kind: 'literal', value: 42 } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '/blocks/0/input/title', code: 'invalid_input' })]));
    expect(check({ title: { kind: 'input', name: 'message' } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '/blocks/0/input/message', code: 'invalid_input' })]));
  });

  it('checks required built-in child bindings and literal values without requiring optional defaults', () => {
    const check = (input: unknown) => validateWorkflowDefinition({
      inputs: [{ name: 'engines', valueType: 'json', required: true }],
      blocks: [{ kind: 'workflow', id: 'child', workflowRef: 'builtin:review-and-converge', input }],
    });
    expect(check({}).issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'invalid_input', blockId: 'child', path: '/blocks/0/input/engines',
    })]));
    expect(check({ engines: { kind: 'input', name: 'engines' } }).valid).toBe(true);
    expect(check({ engines: { kind: 'literal', value: ['engine'] }, maxRounds: { kind: 'literal', value: 'three' } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '/blocks/0/input/maxRounds', code: 'invalid_input' })]));
    expect(check({ engines: { kind: 'literal', value: ['engine'] }, apply: { kind: 'literal', value: 'other' } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '/blocks/0/input/apply', code: 'invalid_input' })]));
  });

  it('validates Action inputs after the canonical Workflow selection projection', () => {
    const definition = { defaults: { permissionMode: 'yolo' }, inputs: [{ name: 'agent', valueType: 'json', required: true }],
      blocks: [{ kind: 'action', id: 'start', actionId: 'execution.run.start', input: {
        backendTarget: { kind: 'input', name: 'agent' }, intent: { kind: 'literal', value: 'delegate' },
        retentionPolicy: { kind: 'literal', value: 'ephemeral' }, runClass: { kind: 'literal', value: 'bounded' },
        ioMode: { kind: 'literal', value: 'request_response' },
      } }] };
    expect(validateWorkflowDefinition(definition).valid).toBe(true);
    const { retentionPolicy: _retentionPolicy, ...missingRequired } = definition.blocks[0]!.input;
    expect(validateWorkflowDefinition({ ...definition, blocks: [{ ...definition.blocks[0], input: missingRequired }] }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: '/blocks/0/input/retentionPolicy', code: 'invalid_input' })]));
  });

  it('leaves non-built-in child contract resolution to materialization', () => {
    for (const workflowRef of ['builtin:external', 'plugin:example.plugin/child', '11111111-1111-4111-8111-111111111111']) {
      expect(validateWorkflowDefinition({ blocks: [{ kind: 'workflow', id: 'child', workflowRef, input: {} }] }).valid).toBe(true);
    }
  });

  it('leaves role resolution at admission while validating Action bindings', () => {
    expect(validateWorkflowDefinition({ defaults: { engine: { role: 'account_builder' } }, blocks: [{
      kind: 'action', id: 'notify', actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Done' } },
    }] }).valid).toBe(true);
  });

  it('defers only missing role-selected Action targets to admission', () => {
    const check = (input: unknown) => validateWorkflowDefinition({ defaults: { engine: { role: 'account_builder' } }, blocks: [{
      kind: 'action', id: 'review', actionId: 'review.start', input,
    }] });
    expect(check({ instructions: { kind: 'literal', value: 'Review the changes' } }).valid).toBe(true);
    expect(check({}).issues).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'invalid_input', path: '/blocks/0/input/instructions',
    })]));
    expect(check({ instructions: { kind: 'literal', value: 'Review the changes' }, engineIds: { kind: 'literal', value: 42 } }).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_input', path: '/blocks/0/input/engineIds' })]));
  });

  it('accepts native Action targets supplied by the canonical Workflow selection', () => {
    const defaults = { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, permissionMode: 'yolo' };
    expect(validateWorkflowDefinition({ defaults, blocks: [{ kind: 'action', id: 'review', actionId: 'review.start',
      input: { instructions: { kind: 'literal', value: 'Review the changes' } },
    }] }).valid).toBe(true);
    expect(validateWorkflowDefinition({ defaults, blocks: [{ kind: 'action', id: 'start', actionId: 'execution.run.start', input: {
      intent: { kind: 'literal', value: 'delegate' }, retentionPolicy: { kind: 'literal', value: 'ephemeral' },
      runClass: { kind: 'literal', value: 'bounded' }, ioMode: { kind: 'literal', value: 'request_response' },
    } }] }).valid).toBe(true);
  });

  it('admits an Action evaluator through the frozen definition owner', () => {
    const evaluator = { ...action, input: { message: { kind: 'literal', value: 'Done' } }, pauseForReview: true };
    const loop = {
      kind: 'loop', id: 'evaluate', body: [agent], repetition: {
        kind: 'evaluate', maxIterations: 2, history: 'none', evaluator,
      },
    };
    const definition = { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
    }, blocks: [loop] };
    expect(WorkflowDefinitionV1Schema.safeParse(definition).success).toBe(true);
    expect(validateWorkflowDefinition(definition).valid).toBe(true);
    expect(WorkflowInsertBlockV1Schema.safeParse({ ...loop, id: undefined,
      repetition: { ...loop.repetition, evaluator: { ...evaluator, id: undefined } },
    }).success).toBe(true);
    const normalized = WorkflowDefinitionV1Schema.parse(definition);
    const edited = applyWorkflowDefinitionEditsV1({ name: 'Evaluator', ...normalized }, [{
      kind: 'replace_block', blockId: evaluator.id,
      block: leaves.WorkflowEvaluatorLeafV1Schema.parse({ ...evaluator, pauseForReview: false }),
    }]);
    if (!edited.ok) throw new Error('Expected evaluator replacement');
    expect(edited.draft.blocks[0]).toMatchObject({ repetition: { evaluator: { kind: 'action', pauseForReview: false } } });
  });
  it('preserves fieldless Wait omission without changing explicit result contracts', () => {
    const { result: _result, ...fieldless } = wait;
    expect(leaves.WorkflowLeafV1Schema.parse(fieldless)).not.toHaveProperty('result');
    expect(leaves.WorkflowLeafV1Schema.parse(wait)).toHaveProperty('result', { kind: 'text' });
  });
  it('preserves optional review on Agent and Action leaves and evaluators', () => {
    for (const leaf of [agent, action]) {
      for (const pauseForReview of [true, false]) {
        expect(leaves.WorkflowLeafV1Schema.parse({ ...leaf, pauseForReview })).toMatchObject({ pauseForReview });
        expect(leaves.WorkflowEvaluatorLeafV1Schema.parse({ ...leaf, pauseForReview })).toMatchObject({ pauseForReview });
      }
      expect(leaves.WorkflowLeafV1Schema.parse(leaf)).not.toHaveProperty('pauseForReview');
    }
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...workflow, pauseForReview: true }).success).toBe(false);
  });
  it('exports the strict leaf and evaluator contracts', () => {
    expect(leaves).toHaveProperty('WorkflowLeafV1Schema');
    expect(leaves).toHaveProperty('WorkflowEvaluatorLeafV1Schema');
  });

  it('parses Agent, Action, Workflow and Wait leaves and rejects unknown executable fields', () => {
    for (const leaf of [agent, action, workflow, wait]) {
      expect(leaves.WorkflowLeafV1Schema.safeParse(leaf).success).toBe(true);
      expect(leaves.WorkflowLeafV1Schema.safeParse({ ...leaf, unknown: true }).success).toBe(false);
    }
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...action, input: { field: { kind: 'literal', value: true, unknown: true } } }).success).toBe(false);
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...workflow, result: { kind: 'text' } }).success).toBe(false);
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...action, actionId: 'workflow.run.start' }).success).toBe(false);
  });

  it('allows only Agent or Action evaluators', () => {
    expect(leaves.WorkflowEvaluatorLeafV1Schema.safeParse(agent).success).toBe(true);
    expect(leaves.WorkflowEvaluatorLeafV1Schema.safeParse(action).success).toBe(true);
    expect(leaves.WorkflowEvaluatorLeafV1Schema.safeParse(workflow).success).toBe(false);
    expect(leaves.WorkflowEvaluatorLeafV1Schema.safeParse(wait).success).toBe(false);
  });

  it('accepts only session or detached targets and exactly one engine arm', () => {
    for (const kind of ['session', 'detached_run']) {
      expect(leaves.WorkflowLeafV1Schema.safeParse({ ...agent, execution: { executionTarget: { kind }, engine: { role: 'reviewer' } } }).success).toBe(true);
    }
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...agent, execution: { executionTarget: { kind: 'attached_run' } } }).success).toBe(false);
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...agent, execution: { engine: { role: 'reviewer', agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } } }).success).toBe(false);
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...agent, execution: { engine: { role: 'reviewer' }, agentTarget: null } }).success).toBe(false);
    expect(leaves.WorkflowLeafV1Schema.safeParse({ ...agent, execution: { engine: { role: 'reviewer', unknown: true } } }).success).toBe(false);
  });
});
