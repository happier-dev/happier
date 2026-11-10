import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import { document, input, literal, result } from './definitionParts.js';

const implementationParticipants = ['first', 'second', 'third'];

/** Three editable branches; add or remove a branch and its participant input to change the count. */
export const PARALLEL_IMPLEMENTATIONS_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {}, inputs: [
    { name: 'request', valueType: 'string', required: true },
    ...implementationParticipants.map(name => ({ name, valueType: 'json' as const, required: true,
      description: 'Choose a model to start in a new worktree.', inputType: { hostType: 'agentParticipant' as const } })),
  ], blocks: [
    { kind: 'parallel', id: 'implementations', name: 'Implement independently', failurePolicy: 'collect_outcomes',
      branches: implementationParticipants.map(name => ({ id: name, name, blocks: [
        { kind: 'step' as const, id: `implement-${name}`, name: 'Implement the task',
          document: document('Implement the supplied task independently in your assigned worktree and run relevant checks. Preserve unrelated work. Return your exact working directory, a summary of your changes and checks, and any failures. Do not merge, apply another candidate or remove any worktree.'),
          execution: { participant: { kind: 'input' as const, name },
            workspace: { kind: 'new_worktree' as const, source: { kind: 'original' as const } } },
          input: [input('request')], result: { kind: 'text' as const } },
      ] })) },
    { kind: 'step', id: 'compare', name: 'Compare implementations and choose',
      document: document('Compare the candidate implementations against the original task. Use the existing SCM diff and review tools to inspect each reported worktree, including staged, unstaged and untracked changes; do not rely on summaries alone. Preserve failed or missing coverage. Recommend one candidate with evidence and tradeoffs, and list every candidate directory so the person can open its diff. Wait for the person to choose. Applying the winner and keeping or removing other worktrees are explicit choices through existing SCM and workspace controls. Do not apply, merge, delete or clean up any candidate.'),
      execution: { participant: { kind: 'input', name: 'first' }, permissionMode: 'read-only',
        workspace: { kind: 'project_checkout' } },
      input: [input('request'), result('implementations')], result: { kind: 'text' }, pauseForReview: true },
  ], finalOutput: result('compare'),
};

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
