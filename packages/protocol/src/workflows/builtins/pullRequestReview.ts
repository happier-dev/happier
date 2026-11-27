import type { WorkflowBlock, WorkflowDefinitionV1 } from '../workflowV1.js';
import type { WorkflowTriggerEventIdentityV1, WorkflowValueReference } from '../workflowReferenceV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { rewriteWorkflowBlockReferences } from '../workflowDefinitionEditV1.js';
import { document, input, literal, result } from './definitionParts.js';
import { SCM_HOSTING_PULL_REQUEST_ACTIVE_ACTIONS_V1 } from '../../scm/pullRequestLifecycleActionsV1.js';
import { PULL_REQUEST_REVIEW_TRIAGE_ACTION_IDS as triage } from '../workflowEffectActionIdsV1.js';

/** Authoring placeholder: choosing a source binds it to that source's declared lifecycle Event. */
export const PULL_REQUEST_REVIEW_SOURCE_EVENT_V1 = {
  pluginId: 'happier.workflows', localId: 'pull-request-review-source',
} as const;

function reviewSteps(name: 'quick' | 'standard', prepareInput: Record<string, WorkflowValueReference>,
  session: WorkflowValueReference): WorkflowBlock[] {
  return [
    { kind: 'action', id: `${name}-prepare`, name: 'Prepare the selected pull request',
      actionId: triage.prepare, input: prepareInput },
    { kind: 'action', id: `${name}-review`, name: name === 'quick' ? 'Quick review' : 'Standard review',
      onlyWhen: { kind: 'compare', operator: 'eq', left: result(`${name}-prepare`, ['status']), right: literal('prepared') },
      actionId: triage.review,
      input: { v: literal(1), sessionId: session, review: result(`${name}-prepare`, ['review']),
        reviewInput: input(name === 'quick' ? 'quickReview' : 'standardReview'), comparisonId: result(`${name}-prepare`, ['comparisonId']) } },
  ];
}

/** Quick and Standard are editable Review inputs, with no implicit reviewer or round policy. */
export function createPullRequestReviewWorkflowV1(
  event: WorkflowTriggerEventIdentityV1 = PULL_REQUEST_REVIEW_SOURCE_EVENT_V1,
  actions: typeof SCM_HOSTING_PULL_REQUEST_ACTIVE_ACTIONS_V1 = SCM_HOSTING_PULL_REQUEST_ACTIVE_ACTIONS_V1,
): WorkflowDefinitionV1 {
  const occurrence = (field: string, ...path: string[]): WorkflowValueReference => ({ kind: 'trigger_event', event, path: ['pullRequest', field, ...path] });
  const reviewBranch = (name: 'quick' | 'standard'): WorkflowBlock[] => [
    ...(name === 'standard' ? [{ kind: 'wait' as const, id: 'approve-pr-setup', name: 'Approve pull request setup',
      document: document('This pull request has an external or unknown author. Review the author, repository and Standard review composition below. Approve to prepare its workspace and run the Standard review. Deny by stopping this Run; no workspace preparation or review will run.'),
      input: [occurrence('author', 'login'), occurrence('author', 'id'), occurrence('authorAssociation'),
        occurrence('baseRepository', 'repository'), occurrence('number'), occurrence('headSha'),
        input('standardReview')] }] : []),
    ...reviewSteps(name, { v: literal(1), request: input('request'),
      prepareReviewWorkspaceSelection: input('prepareReviewWorkspaceSelection'), sessionId: input('sessionId'),
      reviewTarget: { kind: 'trigger_event', event, path: ['reviewTarget'] }, expectedHeadSha: occurrence('headSha'),
      reviewRules: input('reviewRules'), ruleOccurrence: { kind: 'trigger_event', event, path: ['pullRequest'] },
    }, input('sessionId')),
  ];
  return { version: 1, defaults: {}, inputs: [
    { name: 'request', valueType: 'json', required: true },
    { name: 'prepareReviewWorkspaceSelection', valueType: 'json', required: true },
    { name: 'sessionId', valueType: 'string', required: true },
    { name: 'reviewRules', valueType: 'json', required: false, default: {}, description: 'Options for ignored paths and inline comment severity.' },
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

const manualReviewSession = input('session', ['sessionId']);
const exactManualEntry = {
  v: literal(1), forSessionPullRequest: literal(true), entryRef: result('resolve-pr', ['entryRef']),
  sourceInstanceId: result('resolve-pr', ['sourceInstance', 'sourceInstanceId']),
};
export const REVIEW_PULL_REQUEST_WORKFLOW_V1: WorkflowDefinitionV1 = {
  version: 1,
  defaults: {},
  inputs: [
    { name: 'pullRequest', valueType: 'string', required: true,
      presentation: { title: { key: 'workflows.examples.reviewPullRequest.inputs.pullRequest', fallback: 'Pull request link or number' } } },
    { name: 'session', valueType: 'json', required: true, inputType: { hostType: 'session' }, defaultFrom: 'origin_session',
      presentation: { title: { key: 'workflows.examples.reviewPullRequest.inputs.session', fallback: 'Session with the repository checkout' } } },
    { name: 'quickReview', valueType: 'json', required: true,
      presentation: { title: { key: 'workflows.examples.reviewPullRequest.inputs.quickReview', fallback: 'Quick review composition' } } },
  ],
  blocks: [
    { kind: 'action', id: 'resolve-pr', name: 'Find the pull request in PRs & Issues', actionId: triage.resolve,
      input: { v: literal(1), kind: literal('pullRequestForSession'), reference: input('pullRequest'), sessionId: manualReviewSession } },
    { kind: 'action', id: 'read-pr-source', name: 'Read the connected source', actionId: triage.detail, input: exactManualEntry },
    { kind: 'action', id: 'observe-pr', name: 'Read the pull request head', actionId: triage.reobserve,
      input: { ...exactManualEntry, lastKnownLocator: result('resolve-pr', ['locator']), includeComparisonSource: literal(true) } },
    ...reviewSteps('quick', {
      v: literal(1), kind: literal('resolvedPullRequestForSession'), sessionId: manualReviewSession,
      instance: result('read-pr-source', ['instance']), entryRef: result('observe-pr', ['entryRef']),
      observation: result('observe-pr', ['observation']), comparisonSource: result('observe-pr', ['comparisonSource']),
    }, manualReviewSession),
  ],
};

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
