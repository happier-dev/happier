import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { document, input, literal, result } from './definitionParts.js';

export const FRESH_OPINIONS_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [
    { name: 'question', valueType: 'string', required: true },
    { name: 'participants', valueType: 'json', multiple: true, minItems: 2, uniqueItems: true, inputType: { hostType: 'agentParticipant' }, required: true },
    { name: 'synthesis', valueType: 'boolean', required: false, default: false },
    { name: 'synthesizer', valueType: 'json', inputType: { hostType: 'agentParticipant' }, required: false },
    { name: 'previousRoundContext', valueType: 'json', required: false, default: null },
  ], blocks: [
    { kind: 'loop', id: 'opinions', name: 'Everyone answers on their own', repetition: { kind: 'items', items: input('participants'),
      execution: 'parallel', failurePolicy: 'collect_outcomes' }, body: [
      { kind: 'step', id: 'answer', name: 'Fresh opinions', document: document('Answer the question independently using the supplied starting context.'),
        execution: { participant: { kind: 'item', field: 'value' } },
        input: [input('question'), input('previousRoundContext')], result: { kind: 'text' } },
    ] },
    // Conditions cannot quantify over a variable-size collection. This read
    // projects exact typed pass/failure outcomes for the all-pass condition and synthesis.
    { kind: 'action', id: 'outcomes', name: 'Answer outcomes', actionId: 'workflow.discussion.round.project',
      input: { collections: literal(['opinions']) } },
    { kind: 'if', id: 'synthesize', name: 'A synthesis', when: { kind: 'all', conditions: [
      { kind: 'compare', operator: 'eq', left: input('synthesis'), right: literal(true) },
      { kind: 'compare', operator: 'eq', left: result('outcomes', ['allPassed']), right: literal(false) },
    ] }, then: [{ kind: 'if', id: 'choose-synthesizer', name: 'Use the chosen synthesizer', when: { kind: 'exists', value: input('synthesizer') },
      then: [{ kind: 'step', id: 'selected-synthesis', name: 'Synthesis by your chosen participant',
        document: document('Synthesize the exact outcomes. Preserve disagreement, pass, failure and missing coverage; do not invent agreement.'),
        execution: { participant: { kind: 'input', name: 'synthesizer' } }, input: [input('question'), result('outcomes', [], { kind: 'outer', levels: 2 })], result: { kind: 'text' } }],
      otherwise: [{ kind: 'step', id: 'synthesis', name: 'Synthesis by the first participant',
        document: document('Synthesize the exact outcomes. Preserve disagreement, pass, failure and missing coverage; do not invent agreement.'),
        execution: { participant: { kind: 'input', name: 'participants', path: [0] } },
        input: [input('question'), result('outcomes', [], { kind: 'outer', levels: 2 })], result: { kind: 'text' } }],
    }], otherwise: [] },
  ], finalOutput: result('outcomes'),
};
