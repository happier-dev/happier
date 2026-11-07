import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, ScmHostingRepositoryIdentityV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';
import { GithubWorkflowShaV1Schema } from './identity.js';

export const GITHUB_OVERVIEW_TARGET_ACTION_ID = 'github/actions/overview-target-read';
export const GithubOverviewTargetInputV1Schema = defineProtocolObject({ repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
  ref: defineProtocolString({ minLength: 1 }).optional(),
}, { policy: 'closed' });
export const GithubOverviewTargetResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('value'), value: defineProtocolObject({
    repository: ScmHostingRepositoryIdentityV1ProtocolSchema, branch: defineProtocolString({ minLength: 1 }), headSha: GithubWorkflowShaV1Schema,
  }, { policy: 'closed' }) }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
