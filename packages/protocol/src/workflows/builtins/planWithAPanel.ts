import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { agent, input, literal, result } from './definitionParts.js';

export const PLAN_WITH_A_PANEL_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {},
  inputs: [
    { name: 'request', valueType: 'string', required: true },
    { name: 'engines', valueType: 'json', required: false, optionsSourceId: 'execution.backends.enabled' },
  ],
  blocks: [
    {
      kind: 'loop', id: 'planners', name: 'Plan with a panel', onlyWhen: { kind: 'exists', value: input('engines') },
      repetition: { kind: 'items', items: input('engines'), execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{
        kind: 'action', id: 'plan', name: 'Draft a plan', actionId: 'subagents.plan.start',
        input: {
          target: literal({ kind: 'detached' }),
          backendTargetKeys: { kind: 'list', items: [{ kind: 'item', field: 'value' }] },
          instructions: input('request'), permissionMode: literal('read_only'),
        },
      }],
    },
    {
      ...agent('synthesis', 'Synthesize the plan', 'planner',
        'Produce the requested plan. Treat planner results as evidence, preserve failed or missing coverage, and resolve disagreements or list them as open questions. Return a document explaining why, risks and open questions, plus a proposed workflow only if valid.',
        [input('request'), { ...result('planners'), optional: true }], true),
      execution: { engine: { role: 'planner' }, executionTarget: { kind: 'detached_run' }, permissionMode: 'read-only' },
      pauseForReview: true,
      result: { kind: 'json', schema: {
        type: 'object', required: ['document'], additionalProperties: false,
        properties: { document: { type: 'string' }, proposal: { type: 'object' } },
      } },
    },
  ],
  finalOutput: result('synthesis'),
};
