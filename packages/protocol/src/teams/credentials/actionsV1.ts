import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { TEAM_CREDENTIAL_ACTION_IDS_V1, type TeamCredentialActionIdV1 } from './actionIdsV1.js';
export { TEAM_CREDENTIAL_ACTION_IDS_V1, type TeamCredentialActionIdV1 } from './actionIdsV1.js';

import {
  TeamCredentialResourceAudienceInputV1Schema,
  TeamCredentialResourceDeleteInputV1Schema,
  TeamCredentialResourceEntitledPageV1Schema,
  TeamCredentialResourceGetInputV1Schema,
  TeamCredentialResourceMutationResultV1Schema,
  TeamCredentialResourceListInputV1Schema,
  TeamCredentialResourcePageV1Schema,
  TeamCredentialResourceReadInputV1Schema,
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
import { TeamCredentialResourceReadinessV1Schema } from './readinessV1.js';

export const TeamCredentialTestActionInputV1Schema = lazyZodSchema(() => z.object({
  teamId: z.string().min(1).max(256),
  resourceId: z.string().min(1).max(256),
}).strict());
export type TeamCredentialTestActionInputV1 = z.infer<typeof TeamCredentialTestActionInputV1Schema>;

export const TeamCredentialTestActionOutputV1Schema = lazyZodSchema(() => z.object({
  result: z.enum(['available', 'needs_attention', 'partially_available']),
  readiness: TeamCredentialResourceReadinessV1Schema,
  recovery: z.string().trim().min(1).max(240).optional(),
}).strict());
export type TeamCredentialTestActionOutputV1 = z.infer<typeof TeamCredentialTestActionOutputV1Schema>;

export const TeamCredentialActionIdV1Schema = lazyZodSchema(() => z.enum(TEAM_CREDENTIAL_ACTION_IDS_V1));
export const TEAM_CREDENTIAL_HOME_ACTION_IDS_V1 = TEAM_CREDENTIAL_ACTION_IDS_V1;
export type TeamCredentialHomeActionIdV1 = typeof TEAM_CREDENTIAL_HOME_ACTION_IDS_V1[number];

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
  'teams.credentials.entitled.list': TeamCredentialResourceReadInputV1Schema,
  'teams.credentials.create': TeamCredentialResourceCreateInputV1Schema,
  'teams.credentials.update': TeamCredentialResourceUpdateInputV1Schema,
  'teams.credentials.audience.set': TeamCredentialResourceAudienceInputV1Schema,
  'teams.credentials.delete': TeamCredentialResourceDeleteInputV1Schema,
  'teams.credentials.test': TeamCredentialTestActionInputV1Schema,
  'teams.credentials.activity.list': TeamCredentialResourceActivityReadInputV1Schema,
  'teams.credentials.limits.list': TeamCredentialUsageLimitListInputV1Schema,
  'teams.credentials.limits.upsert': TeamCredentialUsageLimitUpsertInputV1Schema,
  'teams.credentials.limits.delete': TeamCredentialUsageLimitDeleteInputV1Schema,
  'teams.credentials.usage.query': TeamCredentialUsageQueryInputV1Schema,
  'teams.credentials.externalKeys.create': TeamCredentialExternalApiKeyCreateInputV1Schema,
  'teams.credentials.externalKeys.authorize': TeamCredentialExternalApiKeyAuthorizeInputV1Schema,
  'teams.credentials.externalKeys.list': TeamCredentialExternalApiKeyListInputV1Schema,
  'teams.credentials.externalKeys.revoke': TeamCredentialExternalApiKeyRevokeInputV1Schema,
  'teams.credentials.externalKeys.revokeAll': TeamCredentialExternalApiKeyRevokeAllInputV1Schema,
} as const satisfies Readonly<Record<TeamCredentialActionIdV1, z.ZodTypeAny>>));

export const TEAM_CREDENTIAL_ACTION_OUTPUT_SCHEMAS_V1 = lazyDefinition(() => ({
  'teams.credentials.list': TeamCredentialResourcePageV1Schema,
  'teams.credentials.sources.list': TeamCredentialSourceCandidateListOutputV1Schema,
  'teams.credentials.requestPolicySupport.get': TeamCredentialRequestPolicySupportOutputV1Schema,
  'teams.credentials.sourceResources.list': TeamCredentialSourceResourceListOutputV1Schema,
  'teams.credentials.get': TeamCredentialResourceSummaryV1Schema,
  'teams.credentials.entitled.list': TeamCredentialResourceEntitledPageV1Schema,
  'teams.credentials.create': TeamCredentialResourceSummaryV1Schema,
  'teams.credentials.update': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.audience.set': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.delete': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.test': TeamCredentialTestActionOutputV1Schema,
  'teams.credentials.activity.list': TeamCredentialResourceActivityPageV1Schema,
  'teams.credentials.limits.list': TeamCredentialUsageLimitListOutputV1Schema,
  'teams.credentials.limits.upsert': TeamCredentialUsageLimitUpsertOutputV1Schema,
  'teams.credentials.limits.delete': TeamCredentialResourceMutationResultV1Schema,
  'teams.credentials.usage.query': TeamCredentialUsageQueryResultV1Schema,
  'teams.credentials.externalKeys.create': TeamCredentialExternalApiKeyCreateOutputV1Schema,
  'teams.credentials.externalKeys.authorize': TeamCredentialExternalApiKeyAuthorizeOutputV1Schema,
  'teams.credentials.externalKeys.list': TeamCredentialExternalApiKeyListOutputV1Schema,
  'teams.credentials.externalKeys.revoke': TeamCredentialExternalApiKeyRevokeOutputV1Schema,
  'teams.credentials.externalKeys.revokeAll': TeamCredentialExternalApiKeyRevokeAllOutputV1Schema,
} as const satisfies Readonly<Record<TeamCredentialActionIdV1, z.ZodTypeAny>>));

export const TEAM_CREDENTIAL_ACTION_METHODS_V1: Readonly<Record<TeamCredentialHomeActionIdV1, 'POST'>> = {
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
