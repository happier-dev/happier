import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { agent, document, input, result } from './definitionParts.js';

const plannerPrompt = 'Draft a read-only plan for the supplied request. Explain the reasoning, evidence, risks and disagreements. Do not implement changes.';

export const PLAN_WITH_A_PANEL_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {},
  inputs: [
    { name: 'request', valueType: 'string', required: true },
    { name: 'engines', valueType: 'json', required: false, optionsSourceId: 'execution.backends.enabled' },
    { name: 'participants', valueType: 'json', required: false, multiple: true, inputType: { hostType: 'agentParticipant' }, conflictsWith: ['engines'] },
    { name: 'previousRoundContext', valueType: 'json', required: false, default: null },
  ],
  blocks: [
    {
      kind: 'loop', id: 'planners', name: 'Plan with a panel', onlyWhen: { kind: 'exists', value: input('engines') },
      repetition: { kind: 'items', items: input('engines'), execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ kind: 'step', id: 'plan', name: 'Draft a plan', document: document(plannerPrompt),
        execution: { engine: { kind: 'item', field: 'value' }, executionTarget: { kind: 'detached_run' }, conversation: { kind: 'fresh' }, permissionMode: 'read-only' },
        input: [input('request'), input('previousRoundContext')], result: { kind: 'text' } }],
    },
    { kind: 'loop', id: 'participant-planners', name: 'Plan with the selected participants', onlyWhen: { kind: 'exists', value: input('participants') },
      repetition: { kind: 'items', items: input('participants'), execution: 'parallel', failurePolicy: 'collect_outcomes' },
      body: [{ kind: 'step', id: 'participant-plan', name: 'Draft a plan', document: document(plannerPrompt),
        execution: { participant: { kind: 'item', field: 'value' }, permissionMode: 'read-only' },
        input: [input('request'), input('previousRoundContext')], result: { kind: 'text' } }] },
    {
      ...agent('synthesis', 'Synthesize the plan', 'planner',
        'Produce the requested plan. Treat planner results as evidence, preserve failed or missing coverage, and resolve disagreements or list them as open questions. Return a document explaining why, risks and open questions, plus a proposed workflow only if valid.',
        [input('request'), input('previousRoundContext'), { ...result('planners'), optional: true }, { ...result('participant-planners'), optional: true }], true),
      execution: { roleId: 'planner', executionTarget: { kind: 'detached_run' }, permissionMode: 'read-only' },
      pauseForReview: true,
      result: { kind: 'json', schema: {
        type: 'object', required: ['document'], additionalProperties: false,
        properties: { document: { type: 'string' }, proposal: { type: 'object' } },
      } },
    },
  ],
  finalOutput: result('synthesis'),
};
