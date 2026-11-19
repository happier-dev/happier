import type { WorkflowDefinitionV1 } from '../workflowV1.js';
import type { DiscussionRoundOutcomeV1 } from '../../discussions/models.js';
import type { WorkflowAcceptedSnapshotV1 } from '../workflowDefinitionV1.js';
import type { WorkflowDiscussionRoundBindingV1 } from '../workflowDiscussionRoundV1.js';
import { OPEN_A_PULL_REQUEST_WORKFLOW_V1 } from './openAPullRequest.js';
import { PLAN_WITH_A_PANEL_WORKFLOW_V1 } from './planWithAPanel.js';
import { KEEP_GOING_WORKFLOW_V1 } from './keepGoing.js';
import { REVIEW_AND_CONVERGE_WORKFLOW_V1 } from './reviewAndConverge.js';
import { FRESH_OPINIONS_WORKFLOW_V1, PARALLEL_IMPLEMENTATIONS_WORKFLOW_V1 } from './freshOpinions.js';
import { ANSWER_AND_REVIEW_WORKFLOW_V1 } from './answerAndReview.js';
import { DEBATE_WORKFLOW_V1 } from './debate.js';
import { REPOSITORY_REVIEW_WORKFLOW_V1 } from './repositoryReview.js';
import { REVIEW_PULL_REQUEST_WORKFLOW_V1 } from './pullRequestReview.js';

export { WORKFLOW_STARTER_EXAMPLE_KEYS_V1, WORKFLOW_STARTER_EXAMPLES_V1, getWorkflowStarterExamplesV1,
  type WorkflowStarterExampleKeyV1, type WorkflowStarterExampleV1 } from './examples.js';

/** What a built-in is for (lab `nav-N1`): it groups and describes built-ins; several share one purpose. */
export type BuiltinWorkflowPurposeV1 = 'goal' | 'review' | 'plan' | 'pull_request';

/**
 * Each built-in's own presentation mark (owner 2026-11-12), named in the shared glyph vocabulary; hosts map it to their
 * own glyph. Presentation only: it never decides behaviour.
 */
export type BuiltinWorkflowIconV1 = 'target' | 'shield-check' | 'list-checks' | 'git-pull-request' | 'users' | 'git-branch'
  | 'seal-check' | 'scales' | 'scan-search' | 'check-circle';

type CatalogEntryFieldsV1 = Readonly<{
  id: `builtin:${string}`;
  version: number;
  titleKey: string;
  descriptionKey: string;
  purpose: BuiltinWorkflowPurposeV1;
  icon: BuiltinWorkflowIconV1;
  requiresOriginSession: boolean;
  definition: WorkflowDefinitionV1;
  discussionRoundPattern?: DiscussionRoundOutcomeV1['pattern'];
}>;

/** Protocol discovery is available even when the Account library is offline. */
export const BUILTIN_WORKFLOW_CATALOG_V1 = Object.freeze([
  { id: 'builtin:keep-going', version: 1,
    titleKey: 'workflows.builtins.keepGoing.title',
    descriptionKey: 'workflows.builtins.keepGoing.description', purpose: 'goal', icon: 'target', requiresOriginSession: true,
    definition: KEEP_GOING_WORKFLOW_V1 },
  { id: 'builtin:review-and-converge', version: 1,
    titleKey: 'workflows.builtins.reviewAndConverge.title',
    descriptionKey: 'workflows.builtins.reviewAndConverge.description', purpose: 'review', icon: 'shield-check', requiresOriginSession: false,
    definition: REVIEW_AND_CONVERGE_WORKFLOW_V1 },
  { id: 'builtin:plan-with-a-panel', version: 1,
    titleKey: 'workflows.builtins.planWithAPanel.title',
    descriptionKey: 'workflows.builtins.planWithAPanel.description', purpose: 'plan', icon: 'list-checks', requiresOriginSession: false,
    definition: PLAN_WITH_A_PANEL_WORKFLOW_V1 },
  { id: 'builtin:open-a-pull-request', version: 1,
    titleKey: 'workflows.builtins.openAPullRequest.title',
    descriptionKey: 'workflows.builtins.openAPullRequest.description', purpose: 'pull_request', icon: 'git-pull-request', requiresOriginSession: false,
    definition: OPEN_A_PULL_REQUEST_WORKFLOW_V1 },
  { id: 'builtin:fresh-opinions', version: 1, titleKey: 'workflows.builtins.freshOpinions.title',
    descriptionKey: 'workflows.builtins.freshOpinions.description', purpose: 'review', icon: 'users', requiresOriginSession: false,
    discussionRoundPattern: 'fresh_opinions',
    definition: FRESH_OPINIONS_WORKFLOW_V1 },
  { id: 'builtin:parallel-implementations', version: 1, titleKey: 'workflows.builtins.parallelImplementations.title',
    descriptionKey: 'workflows.builtins.parallelImplementations.description', purpose: 'review', icon: 'git-branch', requiresOriginSession: false,
    definition: PARALLEL_IMPLEMENTATIONS_WORKFLOW_V1 },
  { id: 'builtin:answer-and-review', version: 1, titleKey: 'workflows.builtins.answerAndReview.title',
    descriptionKey: 'workflows.builtins.answerAndReview.description', purpose: 'review', icon: 'seal-check', requiresOriginSession: false,
    discussionRoundPattern: 'answer_and_review',
    definition: ANSWER_AND_REVIEW_WORKFLOW_V1 },
  { id: 'builtin:debate', version: 1, titleKey: 'workflows.builtins.debate.title',
    descriptionKey: 'workflows.builtins.debate.description', purpose: 'review', icon: 'scales', requiresOriginSession: false,
    definition: DEBATE_WORKFLOW_V1 },
  { id: 'builtin:repository-review', version: 1,
    titleKey: 'workflows.builtins.repositoryReview.title',
    descriptionKey: 'workflows.builtins.repositoryReview.description', purpose: 'review', icon: 'scan-search', requiresOriginSession: false,
    definition: REPOSITORY_REVIEW_WORKFLOW_V1 },
  { id: 'builtin:review-pull-request', version: 1,
    titleKey: 'workflows.examples.reviewPullRequest.title',
    descriptionKey: 'workflows.examples.reviewPullRequest.description', purpose: 'pull_request', icon: 'check-circle', requiresOriginSession: false,
    definition: REVIEW_PULL_REQUEST_WORKFLOW_V1 },
] satisfies readonly CatalogEntryFieldsV1[]);

export type BuiltinWorkflowIdV1 = (typeof BUILTIN_WORKFLOW_CATALOG_V1)[number]['id'];
export type BuiltinWorkflowCatalogEntryV1 = CatalogEntryFieldsV1 & Readonly<{ id: BuiltinWorkflowIdV1 }>;
export const BUILTIN_WORKFLOW_IDS_V1 = Object.freeze(BUILTIN_WORKFLOW_CATALOG_V1.map((entry) => entry.id));

export function getBuiltinWorkflowCatalogV1(): readonly BuiltinWorkflowCatalogEntryV1[] {
  return BUILTIN_WORKFLOW_CATALOG_V1;
}

/** Only a resolved, versioned catalog source supplies pattern identity; authored names and ids do not. */
export function readWorkflowDiscussionRoundBindingV1(accepted: Pick<WorkflowAcceptedSnapshotV1, 'source' | 'resultDelivery'>): WorkflowDiscussionRoundBindingV1 | undefined {
  const source = accepted.source;
  if (source.kind !== 'catalog' || accepted.resultDelivery?.kind !== 'originating_discussion') return undefined;
  const builtin = getBuiltinWorkflowCatalogV1().find(entry => entry.id === source.ref && entry.version === source.version);
  return builtin?.discussionRoundPattern ? { discussionId: accepted.resultDelivery.discussion.discussionId,
    pattern: builtin.discussionRoundPattern } : undefined;
}

/** The id is the parsed builtin arm's slug, not another reference grammar. */
export function resolveBuiltinWorkflowDefinitionV1(id: string): Readonly<{ definition: WorkflowDefinitionV1; version: number }> | null {
  const entry = getBuiltinWorkflowCatalogV1().find((item) => item.id === `builtin:${id}`);
  return entry?.definition ? { definition: entry.definition, version: entry.version } : null;
}
