import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { agent, input, literal, result, SECOND_OPINION_RESULT_V1 } from './definitionParts.js';

export const KEEP_GOING_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {},
  inputs: [
    { name: 'maxRounds', valueType: 'number', required: false, default: 4 },
    { name: 'strikes', valueType: 'number', required: false, default: 3 },
    { name: 'secondOpinion', valueType: 'boolean', required: false, default: false },
    { name: 'triggerId', valueType: 'string', required: false },
  ],
  blocks: [
    {
      kind: 'loop', id: 'turns', name: 'Keep going until done',
      repetition: { kind: 'until', maxIterations: { kind: 'input', name: 'maxRounds' },
        stopWhen: { kind: 'any', conditions: [
          { kind: 'compare', operator: 'eq', left: result('check', ['verdict']), right: literal('done') },
          { kind: 'all', conditions: [
            { kind: 'exists', value: { kind: 'session_context_field', field: 'usage.tokensUsed' } },
            { kind: 'exists', value: { kind: 'session_context_field', field: 'goal.tokenBudget' } },
            { kind: 'compare', operator: 'gte', left: { kind: 'session_context_field', field: 'usage.tokensUsed' },
              right: { kind: 'session_context_field', field: 'goal.tokenBudget' } },
          ] },
          { kind: 'compare', operator: 'gte', left: { kind: 'loop_trailing_count', producer: result('check').producer,
            path: ['verdict'], equals: 'no_progress' }, right: input('strikes') },
        ] } },
      body: [
        { kind: 'step', id: 'continue', name: 'Keep going toward your goal', document: { text: 'Keep going toward your goal.', references: [], attachments: [] },
          execution: { conversation: { kind: 'origin_session' } },
          onlyWhen: { kind: 'compare', operator: 'gt', left: { kind: 'iteration', field: 'index' }, right: literal(0) },
          input: [{ kind: 'session_context', recentTurns: 0 }], result: { kind: 'text' } },
        {
          ...agent('check', 'Check progress', 'judge',
            'Check the supplied goal and most recent turn. Return progress, no_progress, or done with an evidence-based reason. Mark done only when the goal is met.',
            [{ kind: 'session_context', recentTurns: 1 }], true),
          execution: { engine: { role: 'judge' }, executionTarget: { kind: 'detached_run' },
            conversation: { kind: 'fresh' }, permissionMode: 'read-only' },
          result: { kind: 'json', schema: { type: 'object', required: ['verdict'], additionalProperties: false,
            properties: { verdict: { type: 'string', enum: ['progress', 'no_progress', 'done'] }, reason: { type: 'string' } } } },
        },
      ],
    },
    {
      kind: 'if', id: 'goal-met', name: 'If the goal is met', when: { kind: 'compare', operator: 'eq', left: result('turns', ['outcome']),
        right: literal({ kind: 'stop_condition', arm: 0 }) },
      then: [
        {
          ...agent('second-opinion', 'Ask for a second opinion', 'second_opinion', 'Before this goal is marked complete, check whether it is really met.',
            [{ kind: 'session_context', recentTurns: 0 }], true),
          onlyWhen: { kind: 'compare', operator: 'eq', left: input('secondOpinion'), right: literal(true) },
          execution: { engine: { role: 'second_opinion' }, executionTarget: { kind: 'detached_run' },
            conversation: { kind: 'fresh' }, permissionMode: 'read-only' }, result: SECOND_OPINION_RESULT_V1,
        },
        {
          kind: 'if', id: 'second-opinion-disagreed', name: 'If the second opinion disagrees', when: { kind: 'all', conditions: [
            { kind: 'exists', value: result('second-opinion') },
            { kind: 'compare', operator: 'neq', left: result('second-opinion', ['verdict']), right: literal('agree') },
          ] },
          then: [{ kind: 'action', id: 'notify', name: 'Tell me about it', actionId: 'notifications.notify_me', input: {
            title: literal('Second opinion disagreed'), message: literal('The goal is still open. Open the run to see why.'),
          } }],
          otherwise: [
            { kind: 'action', id: 'complete-goal', name: 'Mark the goal complete', actionId: 'session.goal.set', input: {
              sessionId: { kind: 'origin_session_id' }, status: literal('complete'),
            } },
            { kind: 'action', id: 'detach', name: 'Stop keeping going', actionId: 'session.trigger.remove',
              onlyWhen: { kind: 'exists', value: input('triggerId') }, input: {
                sessionId: { kind: 'origin_session_id' }, triggerId: input('triggerId'),
              } },
          ],
        },
      ], otherwise: [],
    },
  ],
  finalOutput: result('turns', ['outcome']),
};
