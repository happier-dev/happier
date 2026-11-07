import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { TEAM_CREDENTIAL_ACTION_IDS_V1, TEAM_CREDENTIAL_HOME_ACTION_IDS_V1,
  type TeamCredentialActionIdV1, type TeamCredentialHomeActionIdV1 } from './actionIdsV1.js';
export { TEAM_CREDENTIAL_ACTION_IDS_V1, TEAM_CREDENTIAL_HOME_ACTION_IDS_V1,
  type TeamCredentialActionIdV1, type TeamCredentialHomeActionIdV1 } from './actionIdsV1.js';

import {
  TeamCredentialResourceAudienceInputV1Schema,
  TeamCredentialResourceDeleteInputV1Schema,
  TeamCredentialResourceEntitledPageV1Schema,
  TeamCredentialResourceGetInputV1Schema,
  TeamCredentialResourceMutationResultV1Schema,
  TeamCredentialResourceListInputV1Schema,
  TeamCredentialResourcePageV1Schema,
  TeamCredentialResourceReadInputV1Schema,
  TeamCredentialResourceDiscoverInputV1Schema,
  TeamCredentialResourceDiscoveryPageV1Schema,
  TeamCredentialResourceSummaryV1Schema,
  TeamCredentialResourceCreateInputV1Schema,
  TeamCredentialResourceUpdateInputV1Schema,
  TeamCredentialResourceActivityReadInputV1Schema,
  TeamCredentialResourceActivityPageV1Schema,
  TeamCredentialRequestPolicySupportInputV1Schema,
  TeamCredentialRequestPolicySupportOutputV1Schema,
} from './resourceV1.js';
import {
  TeamCredentialUsageLimitDeleteInputV1Schema,
  TeamCredentialUsageLimitListInputV1Schema,
  TeamCredentialUsageLimitListOutputV1Schema,
  TeamCredentialUsageLimitUpsertInputV1Schema,
  TeamCredentialUsageLimitUpsertOutputV1Schema,
  TeamCredentialUsageQueryInputV1Schema,
  TeamCredentialUsageQueryResultV1Schema,
} from './usageV1.js';
import {
  TeamCredentialExternalApiKeyCreateInputV1Schema,
  TeamCredentialExternalApiKeyAuthorizeInputV1Schema,
  TeamCredentialExternalApiKeyAuthorizeOutputV1Schema,
  TeamCredentialExternalApiKeyCreateOutputV1Schema,
  TeamCredentialExternalApiKeyListInputV1Schema,
  TeamCredentialExternalApiKeyListOutputV1Schema,
  TeamCredentialExternalApiKeyRevokeInputV1Schema,
  TeamCredentialExternalApiKeyRevokeOutputV1Schema,
  TeamCredentialExternalApiKeyRevokeAllInputV1Schema,
  TeamCredentialExternalApiKeyRevokeAllOutputV1Schema,
} from './externalApiKeyV1.js';
import {
  TeamCredentialSourceCandidateListInputV1Schema,
  TeamCredentialSourceCandidateListOutputV1Schema,
  TeamCredentialSourceResourceListInputV1Schema,
  TeamCredentialSourceResourceListOutputV1Schema,
} from './sourceCandidatesV1.js';
import { TeamCredentialResourceReadinessV1Schema } from './resourceReadinessV1.js';
import { TeamCredentialUsageExportInputV1Schema } from './usageExportV1.js';
import { UsageFileResultSchema } from '../../usage/usageExport.js';
import { TeamCredentialBrokerApplicationFailureCodeV1Schema, TeamCredentialExternalProviderErrorCodeV1Schema } from './externalProviderApiV1.js';

export const TeamCredentialTestActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1), z.maxLength(256)),
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
}));
export type TeamCredentialTestActionInputV1 = z.infer<typeof TeamCredentialTestActionInputV1Schema>;

export const TeamCredentialTestActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  result: z.enum(['available', 'needs_attention', 'partially_available']),
  readiness: TeamCredentialResourceReadinessV1Schema,
  requestId: z.optional(z.string()),
  failureDetail: z.optional(z.strictObject({
    code: z.optional(TeamCredentialBrokerApplicationFailureCodeV1Schema),
    stage: z.enum(['feature', 'signing', 'relay_authorization', 'relay_admission', 'request_write',
      'response_headers', 'application_response', 'dispatch', 'response_body']),
    httpStatus: z.optional(z.number().check(z.int())),
  })),
  code: z.optional(z.union([TeamCredentialBrokerApplicationFailureCodeV1Schema, TeamCredentialExternalProviderErrorCodeV1Schema])),
  recovery: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(240))),
}));
export type TeamCredentialTestActionOutputV1 = z.infer<typeof TeamCredentialTestActionOutputV1Schema>;

/** A user/Agent observation, never the daemon's recipient or envelope census. */
export const TeamCredentialPreparationInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: z.string().check(z.minLength(1), z.maxLength(256)),
  resourceId: z.string().check(z.minLength(1), z.maxLength(256)),
  view: z._default(z.literal('readiness'), 'readiness'),
}));
export type TeamCredentialPreparationInputV1 = z.infer<typeof TeamCredentialPreparationInputV1Schema>;

export const TeamCredentialPreparationOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    reason: z.null(),
    counts: z.strictObject({ pending: z.literal(0) }),
  }),
  z.strictObject({
    status: z.literal('not_ready'),
    reason: z.literal('preparation_pending'),
    counts: z.strictObject({ pending: z.number().check(z.int(), z.positive()) }),
  }),
]));
export type TeamCredentialPreparationOutputV1 = z.infer<typeof TeamCredentialPreparationOutputV1Schema>;

export const TeamCredentialActionIdV1Schema = lazyZodSchema(() => z.enum(TEAM_CREDENTIAL_ACTION_IDS_V1));

export const TEAM_CREDENTIAL_ACTION_PATHS_V1: Readonly<Record<TeamCredentialHomeActionIdV1, string>> = {
  'teams.credentials.list': '/v1/teams/credential-resources/list',
  'teams.credentials.sources.list': '/v1/teams/credential-resources/sources/list',
  'teams.credentials.requestPolicySupport.get': '/v1/teams/credential-resources/request-policy-support/get',
  'teams.credentials.sourceResources.list': '/v1/teams/credential-resources/source-resources/list',
  'teams.credentials.get': '/v1/teams/credential-resources/get',
  'teams.credentials.entitled.list': '/v1/teams/credential-resources/entitled/list',
  'teams.credentials.create': '/v1/teams/credential-resources/create',
  'teams.credentials.update': '/v1/teams/credential-resources/update',
  'teams.credentials.audience.set': '/v1/teams/credential-resources/audience/set',
  'teams.credentials.delete': '/v1/teams/credential-resources/delete',
  'teams.credentials.test': '/v1/teams/credential-resources/test',
  'teams.credentials.preparation.get': '/v2/teams/:teamId/credential-resources/:resourceId/direct-material',
  'teams.credentials.activity.list': '/v1/teams/credential-resources/activity/list',
  'teams.credentials.limits.list': '/v1/teams/credential-resources/limits/list',
  'teams.credentials.limits.upsert': '/v1/teams/credential-resources/limits/upsert',
  'teams.credentials.limits.delete': '/v1/teams/credential-resources/limits/delete',
  'teams.credentials.usage.query': '/v1/teams/credential-resources/usage/query',
  'teams.credentials.externalKeys.create': '/v1/teams/credential-resources/external-keys/create',
  'teams.credentials.externalKeys.authorize': '/v1/teams/credential-resources/external-keys/authorize',
  'teams.credentials.externalKeys.list': '/v1/teams/credential-resources/external-keys/list',
  'teams.credentials.externalKeys.revoke': '/v1/teams/credential-resources/external-keys/revoke',
  'teams.credentials.externalKeys.revokeAll': '/v1/teams/credential-resources/external-keys/revoke-all',
};

export const TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1 = lazyDefinition(() => ({
  'teams.credentials.list': TeamCredentialResourceListInputV1Schema,
  'teams.credentials.sources.list': TeamCredentialSourceCandidateListInputV1Schema,
  'teams.credentials.requestPolicySupport.get': TeamCredentialRequestPolicySupportInputV1Schema,
  'teams.credentials.sourceResources.list': TeamCredentialSourceResourceListInputV1Schema,
  'teams.credentials.get': TeamCredentialResourceGetInputV1Schema,
  'teams.credentials.entitled.list': z.union([TeamCredentialResourceReadInputV1Schema, TeamCredentialResourceDiscoverInputV1Schema]),
  'teams.credentials.create': TeamCredentialResourceCreateInputV1Schema,
  'teams.credentials.update': TeamCredentialResourceUpdateInputV1Schema,
  'teams.credentials.audience.set': TeamCredentialResourceAudienceInputV1Schema,
  'teams.credentials.delete': TeamCredentialResourceDeleteInputV1Schema,
  'teams.credentials.test': TeamCredentialTestActionInputV1Schema,
  'teams.credentials.preparation.get': TeamCredentialPreparationInputV1Schema,
  'teams.credentials.activity.list': TeamCredentialResourceActivityReadInputV1Schema,
  'teams.credentials.limits.list': TeamCredentialUsageLimitListInputV1Schema,
  'teams.credentials.limits.upsert': TeamCredentialUsageLimitUpsertInputV1Schema,
  'teams.credentials.limits.delete': TeamCredentialUsageLimitDeleteInputV1Schema,
  'teams.credentials.usage.query': TeamCredentialUsageQueryInputV1Schema,
  'teams.credentials.usage.export': TeamCredentialUsageExportInputV1Schema,
  'teams.credentials.externalKeys.create': TeamCredentialExternalApiKeyCreateInputV1Schema,
  'teams.credentials.externalKeys.authorize': TeamCredentialExternalApiKeyAuthorizeInputV1Schema,
  'teams.credentials.externalKeys.list': TeamCredentialExternalApiKeyListInputV1Schema,
  'teams.credentials.externalKeys.revoke': TeamCredentialExternalApiKeyRevokeInputV1Schema,
  'teams.credentials.externalKeys.revokeAll': TeamCredentialExternalApiKeyRevokeAllInputV1Schema,
} as const satisfies Readonly<Record<TeamCredentialActionIdV1, z.ZodMiniType>>));

export const TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1 = lazyDefinition(() => ({
  'teams.credentials.list': TeamCredentialResourcePageV1Schema,
  'teams.credentials.sources.list': TeamCredentialSourceCandidateListOutputV1Schema,
  'teams.credentials.requestPolicySupport.get': TeamCredentialRequestPolicySupportOutputV1Schema,
  'teams.credentials.sourceResources.list': TeamCredentialSourceResourceListOutputV1Schema,
  'teams.credentials.get': TeamCredentialResourceSummaryV1Schema,
  'teams.credentials.entitled.list': z.union([TeamCredentialResourceEntitledPageV1Schema, TeamCredentialResourceDiscoveryPageV1Schema]),
  'teams.credentials.create': TeamCredentialResourceSummaryV1Schema,
  'teams.credentials.update': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.audience.set': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.delete': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.test': TeamCredentialTestActionOutputV1Schema,
  'teams.credentials.preparation.get': TeamCredentialPreparationOutputV1Schema,
  'teams.credentials.activity.list': TeamCredentialResourceActivityPageV1Schema,
  'teams.credentials.limits.list': TeamCredentialUsageLimitListOutputV1Schema,
  'teams.credentials.limits.upsert': TeamCredentialUsageLimitUpsertOutputV1Schema,
  'teams.credentials.limits.delete': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.usage.query': TeamCredentialUsageQueryResultV1Schema,
  'teams.credentials.usage.export': UsageFileResultSchema,
  'teams.credentials.externalKeys.create': TeamCredentialExternalApiKeyCreateOutputV1Schema,
  'teams.credentials.externalKeys.authorize': TeamCredentialExternalApiKeyAuthorizeOutputV1Schema,
  'teams.credentials.externalKeys.list': TeamCredentialExternalApiKeyListOutputV1Schema,
  'teams.credentials.externalKeys.revoke': TeamCredentialExternalApiKeyRevokeOutputV1Schema,
  'teams.credentials.externalKeys.revokeAll': TeamCredentialExternalApiKeyRevokeAllOutputV1Schema,
} as const satisfies Readonly<Record<TeamCredentialActionIdV1, z.ZodMiniType>>));

export const TEAM_CREDENTIAL_ACTION_METHODS_V1: Readonly<Record<TeamCredentialHomeActionIdV1, 'POST' | 'GET'>> = {
  'teams.credentials.list': 'POST',
  'teams.credentials.sources.list': 'POST',
  'teams.credentials.requestPolicySupport.get': 'POST',
  'teams.credentials.sourceResources.list': 'POST',
  'teams.credentials.get': 'POST',
  'teams.credentials.entitled.list': 'POST',
  'teams.credentials.create': 'POST',
  'teams.credentials.update': 'POST',
  'teams.credentials.audience.set': 'POST',
  'teams.credentials.delete': 'POST',
  'teams.credentials.test': 'POST',
  'teams.credentials.preparation.get': 'GET',
  'teams.credentials.activity.list': 'POST',
  'teams.credentials.limits.list': 'POST',
  'teams.credentials.limits.upsert': 'POST',
  'teams.credentials.limits.delete': 'POST',
  'teams.credentials.usage.query': 'POST',
  'teams.credentials.externalKeys.create': 'POST',
  'teams.credentials.externalKeys.authorize': 'POST',
  'teams.credentials.externalKeys.list': 'POST',
  'teams.credentials.externalKeys.revoke': 'POST',
  'teams.credentials.externalKeys.revokeAll': 'POST',
};
