import type { WorkflowBlock, WorkflowDefinitionV1 } from '../workflowV1.js';
import type { WorkflowTriggerEventIdentityV1, WorkflowValueReference } from '../workflowReferenceV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { rewriteWorkflowBlockReferences } from '../workflowDefinitionEditV1.js';
import { document, input, literal, result } from './definitionParts.js';
import { SCM_HOSTING_PULL_REQUEST_ACTIVE_ACTIONS_V1 } from '../../scm/pullRequestLifecycleActionsV1.js';

/** Authoring placeholder: choosing a source binds it to that source's declared lifecycle Event. */
export const PULL_REQUEST_REVIEW_SOURCE_EVENT_V1 = {
  pluginId: 'happier.workflows', localId: 'pull-request-review-source',
} as const;

/** Quick and Standard are editable Review inputs, with no implicit reviewer or round policy. */
export function createPullRequestReviewWorkflowV1(
  event: WorkflowTriggerEventIdentityV1 = PULL_REQUEST_REVIEW_SOURCE_EVENT_V1,
  actions: typeof SCM_HOSTING_PULL_REQUEST_ACTIVE_ACTIONS_V1 = SCM_HOSTING_PULL_REQUEST_ACTIVE_ACTIONS_V1,
): WorkflowDefinitionV1 {
  const occurrence = (field: string): WorkflowValueReference => ({ kind: 'trigger_event', event, path: ['pullRequest', field] });
  const reviewBranch = (name: 'quick' | 'standard'): WorkflowBlock[] => [
    ...(name === 'standard' ? [{ kind: 'wait' as const, id: 'approve-pr-setup', name: 'Approve pull request setup',
      document: document('This pull request has an external or unknown author. Continue to prepare its workspace and run the Standard review, or stop this run.') }] : []),
    { kind: 'action', id: `${name}-prepare`, name: 'Prepare the selected pull request',
      actionId: 'happier.triage/actions/entries/prepare-pull-request-review-v1',
      input: { v: literal(1), request: input('request'), prepareReviewWorkspaceSelection: input('prepareReviewWorkspaceSelection'),
        sessionId: input('sessionId'), reviewTarget: { kind: 'trigger_event', event, path: ['reviewTarget'] },
        expectedHeadSha: occurrence('headSha') } },
    { kind: 'action', id: `${name}-review`, name: name === 'quick' ? 'Quick review' : 'Standard review',
      onlyWhen: { kind: 'compare', operator: 'eq', left: result(`${name}-prepare`, ['status']), right: literal('prepared') },
      actionId: 'happier.triage/actions/sessions/start-pull-request-review-v1',
      input: { v: literal(1), sessionId: input('sessionId'), review: result(`${name}-prepare`, ['review']),
        reviewInput: input(name === 'quick' ? 'quickReview' : 'standardReview'), comparisonId: result(`${name}-prepare`, ['comparisonId']) } },
  ];
  return { version: 1, defaults: {}, inputs: [
    { name: 'request', valueType: 'json', required: true },
    { name: 'prepareReviewWorkspaceSelection', valueType: 'json', required: true },
    { name: 'sessionId', valueType: 'string', required: true },
    { name: 'quickReview', valueType: 'json', required: true, description: 'The reviewers, steps and launch choices for internal authors.' },
    { name: 'standardReview', valueType: 'json', required: true, description: 'The reviewers, steps and launch choices used after approval for other authors.' },
  ], blocks: [{ kind: 'if', id: 'pr-lifecycle', name: 'Review an active pull request',
    when: { kind: 'any', conditions: actions.map(action => ({
      kind: 'compare', operator: 'eq', left: occurrence('action'), right: literal(action),
    })) },
    then: [{ kind: 'if', id: 'author-route', name: 'Choose the review composition',
      when: { kind: 'compare', operator: 'eq', left: occurrence('authorAssociation'), right: literal('internal') },
      then: reviewBranch('quick'), otherwise: reviewBranch('standard') }], otherwise: [] }] };
}

export const REVIEW_PULL_REQUEST_WORKFLOW_V1 = createPullRequestReviewWorkflowV1();

/** Bind the starter's source operands without replacing the author's composition. */
export function bindPullRequestReviewSourceEventV1<T extends Readonly<{ blocks: readonly WorkflowBlock[] }>>(
  draft: T, event: WorkflowTriggerEventIdentityV1,
): T {
  let changed = false;
  const keep = <Value>(value: Value): Value => value;
  const visit = (block: WorkflowBlock): WorkflowBlock => rewriteWorkflowBlockReferences(block, {
    producer: keep, inputName: keep, child: visit,
    reference: reference => {
      if (reference.kind !== 'trigger_event' || !sameStrictJsonValue(reference.event, PULL_REQUEST_REVIEW_SOURCE_EVENT_V1)) return reference;
      changed = true;
      return { ...reference, event };
    },
  });
  const blocks = draft.blocks.map(visit);
  return changed ? { ...draft, blocks } : draft;
}
