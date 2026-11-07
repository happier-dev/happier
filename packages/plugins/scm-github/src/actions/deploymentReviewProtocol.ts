import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, ScmHostingRepositoryIdentityV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { normalizePluginUiSubPathV1 } from '@happier-dev/plugin-sdk/ui';
import { TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';

export const GITHUB_DEPLOYMENT_REVIEW_PAGE_ID = 'deployment-review';
export const GITHUB_DEPLOYMENT_REVIEW_CATEGORY_ID = 'github-deployment-review';
export type GithubDeploymentReviewLocationV1 = Readonly<{ repositoryId: string; runId: string; attempt: string; environmentId: string }>;
const idSchema = defineProtocolString({ pattern: '^[1-9][0-9]*$' });
export const GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID = 'github/actions/deployment-review-target-read';
export const GithubDeploymentReviewTargetInputV1Schema = defineProtocolObject({
  location: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export const GithubDeploymentReviewTargetResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('ready'), repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
    location: defineProtocolObject({ repositoryId: idSchema, runId: idSchema, attempt: idSchema, environmentId: idSchema }, { policy: 'closed' }),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
const booleanSchema = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const noticeFields = {
  repositoryId: idSchema, runId: idSchema, attempt: idSchema, environmentId: idSchema,
  environmentName: defineProtocolString(), eligible: booleanSchema,
  waitUntilMs: defineProtocolNumber({ integer: true, minimum: 0 }).optional(), reviewers: defineProtocolArray(defineProtocolString()).optional(),
};
export const GithubDeploymentNoticeFactsV1Schema = defineProtocolObject(noticeFields, { policy: 'closed' });
export const GithubDeploymentReviewEventV1Schema = defineProtocolObject({ ...noticeFields, resolved: booleanSchema }, { policy: 'closed' });
export type GithubDeploymentNoticeFactsV1 = ReturnType<typeof GithubDeploymentNoticeFactsV1Schema.parse>;
const GithubDeploymentWaitingPageV1Schema = defineProtocolObject({
  url: defineProtocolString(), etag: defineProtocolString().optional(), nextUrl: defineProtocolString().nullable(),
  totalCount: defineProtocolNumber({ integer: true, minimum: 0 }),
  runs: defineProtocolArray(defineProtocolObject({ runId: idSchema, attempt: idSchema.optional(),
    updatedAt: defineProtocolString().optional() }, { policy: 'closed' })),
}, { policy: 'closed' });
export const GithubDeploymentMonitorCursorV1Schema = defineProtocolObject({ kind: defineProtocolLiteral('deploymentReview'), v: defineProtocolLiteral(1),
  pending: defineProtocolArray(GithubDeploymentNoticeFactsV1Schema),
  // Conditional page baselines belong to the existing source checkpoint.
  // Older development cursors establish these on their next complete read.
  waitingPages: defineProtocolArray(GithubDeploymentWaitingPageV1Schema).optional(),
  // Event admission compares immutable evidence, including occurredAt. Keep
  // the first observation in this existing checkpoint until publication settles.
  observation: defineProtocolObject({ id: defineProtocolString({ minLength: 1 }),
    factsKey: defineProtocolString({ pattern: '^[a-f0-9]{64}$' }),
    occurredAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
  }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
export type GithubDeploymentMonitorCursorV1 = ReturnType<typeof GithubDeploymentMonitorCursorV1Schema.parse>;

const decimal = /^[1-9][0-9]*$/u;
const locationPattern = /^repositories\/([1-9][0-9]*)\/runs\/([1-9][0-9]*)\/attempts\/([1-9][0-9]*)\/environments\/([1-9][0-9]*)$/u;

/** Locator data is never credential, repository admission or effect authority. */
export function encodeGithubDeploymentReviewLocationV1(value: GithubDeploymentReviewLocationV1): string | null {
  if (![value.repositoryId, value.runId, value.attempt, value.environmentId].every(id => typeof id === 'string' && decimal.test(id))) return null;
  return normalizePluginUiSubPathV1(`repositories/${value.repositoryId}/runs/${value.runId}/attempts/${value.attempt}/environments/${value.environmentId}`);
}

export function decodeGithubDeploymentReviewLocationV1(value: unknown): GithubDeploymentReviewLocationV1 | null {
  if (typeof value !== 'string' || normalizePluginUiSubPathV1(value) !== value) return null;
  const match = locationPattern.exec(value);
  return match ? { repositoryId: match[1]!, runId: match[2]!, attempt: match[3]!, environmentId: match[4]! } : null;
}
