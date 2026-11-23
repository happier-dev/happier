import type { WorkflowDefinitionV1, WorkflowStep } from '../workflowV1.js';
import { document, input, literal, result } from './definitionParts.js';

const digest: WorkflowStep = { kind: 'step', id: 'default-digest', name: 'Summarize the completed round',
  document: document('Summarize this completed round as a digest for the next round. Retain dissent, pass, failures and missing coverage. Do not select speakers or infer consensus.'),
  execution: { participant: { kind: 'input', name: 'participants', path: [0] } },
  input: [input('question'), result('context', [], { kind: 'outer', levels: 2 }), result('outcomes', [], { kind: 'outer', levels: 2 })],
  result: { kind: 'text' } };

export const DEBATE_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [
    { name: 'question', presentation: { title: { key: 'workflows.builtins.patternInputs.question', fallback: 'Question' } }, valueType: 'string', required: true },
    { name: 'participants', presentation: { title: { key: 'workflows.builtins.patternInputs.participants', fallback: 'Participants' } }, valueType: 'json', multiple: true, uniqueItems: true, inputType: { hostType: 'agentParticipant' }, required: true },
    { name: 'rounds', presentation: { title: { key: 'workflows.builtins.patternInputs.rounds', fallback: 'Rounds' } }, valueType: 'number', required: true },
    { name: 'digestAuthor', presentation: { title: { key: 'workflows.builtins.patternInputs.digestAuthor', fallback: 'Who summarizes each round' } }, valueType: 'json', required: false, inputType: { hostType: 'agentParticipant' } },
    { name: 'previousRoundContext', presentation: { title: { key: 'workflows.builtins.patternInputs.previousRoundContext', fallback: 'Previous round' } }, valueType: 'json', required: false, default: null },
  ], blocks: [{ kind: 'loop', id: 'rounds', name: 'Debate the question',
    repetition: { kind: 'until', maxIterations: { kind: 'input', name: 'rounds' }, stopWhen: { kind: 'any', conditions: [
      { kind: 'compare', operator: 'eq', left: result('outcomes', ['allPassed']), right: literal(true) },
      { kind: 'compare', operator: 'eq', left: result('outcomes', ['hasNext']), right: literal(false) },
    ] } }, body: [
      { kind: 'action', id: 'context', name: 'Prepare this round', actionId: 'workflow.discussion.round.project', input: {
        collections: literal(['speakers']), phase: literal('prepare'), rosterInput: literal('participants'), previousProjectionBlockId: literal('outcomes'),
      } },
      { kind: 'loop', id: 'speakers', name: 'Hear the eligible participants', repetition: { kind: 'items', items: result('context', ['nextParticipants']),
        execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [{ kind: 'step', id: 'reply', name: 'Contribute to the debate',
        document: document('Address the question using the shared starting context and previous-round digest. Preserve disagreement; pass explicitly when you have nothing to add.'),
        execution: { participant: { kind: 'item', field: 'value', roster: 'participants' } }, input: [input('question'), input('previousRoundContext'),
          result('context', [], { kind: 'outer', levels: 1 }), { ...result('digest', [], { kind: 'previous_iteration', loopBlockId: 'rounds' }), optional: true }],
        result: { kind: 'text' } }] },
      { kind: 'action', id: 'outcomes', name: 'Read the round outcomes', actionId: 'workflow.discussion.round.project',
        input: { collections: literal(['speakers']), preparationBlockId: literal('context') } },
      { kind: 'if', id: 'digest', name: 'Summarize the completed round',
        when: { kind: 'all', conditions: [
          { kind: 'compare', operator: 'eq', left: result('outcomes', ['allPassed']), right: literal(false) },
          { kind: 'compare', operator: 'eq', left: result('outcomes', ['hasNext']), right: literal(true) },
        ] }, then: [{ kind: 'if', id: 'choose-digest-author', name: 'Use the chosen digest author',
          when: { kind: 'exists', value: input('digestAuthor') },
          then: [{ ...digest, id: 'selected-digest', execution: { participant: { kind: 'input', name: 'digestAuthor' } } }],
          otherwise: [digest] }], otherwise: [] },
    ] }], finalOutput: result('rounds'),
};
