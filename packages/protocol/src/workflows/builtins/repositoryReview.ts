import type { WorkflowDefinitionV1, WorkflowActionLeafV1 } from '../workflowV1.js';
import { input, literal, result } from './definitionParts.js';

/** A Hunt uses ordinary saved workflows, placement, schedules and run controls. */
const review = (withSteps: boolean): WorkflowActionLeafV1 => ({
  kind: 'action', id: withSteps ? 'review-steps' : 'review', name: 'Review the repository', actionId: 'review.start', input: {
    target: literal({ kind: 'detached' }), cwd: input('cwd'), scope: literal('repository'),
    reviewers: input('reviewers'), instructions: input('instructions'), ...(withSteps ? { steps: input('steps') } : {}),
  },
});

export const REPOSITORY_REVIEW_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1, defaults: {},
  inputs: [
    { name: 'cwd', valueType: 'string', required: true },
    { name: 'reviewers', valueType: 'json', required: true },
    { name: 'steps', valueType: 'json', required: false },
    { name: 'instructions', valueType: 'string', required: true },
  ],
  blocks: [{ kind: 'if', id: 'review-composition', name: 'Review with the selected steps',
    when: { kind: 'exists', value: input('steps') }, then: [review(true)], otherwise: [review(false)] }],
  finalOutput: result('review-composition'),
};
