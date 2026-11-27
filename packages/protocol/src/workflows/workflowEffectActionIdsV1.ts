/** Id-only dependency: Action census construction must not evaluate Workflow schemas. */
export const WORKFLOW_EFFECT_ACTION_IDS_V1 = ['webhooks.call', 'machines.command.run', 'workflow.discussion.round.project'] as const;
export type WorkflowEffectActionIdV1 = typeof WORKFLOW_EFFECT_ACTION_IDS_V1[number];

export const PULL_REQUEST_REVIEW_TRIAGE_ACTION_IDS = {
  resolve: 'happier.triage/actions/entries/resolve-resource-v1',
  detail: 'happier.triage/actions/entries/read-detail-v1',
  reobserve: 'happier.triage/actions/entries/reobserve-v1',
  prepare: 'happier.triage/actions/entries/prepare-pull-request-review-v1',
  review: 'happier.triage/actions/sessions/start-pull-request-review-v1',
} as const;
