import { lazyZodSchema } from '../lazyZodSchema.js';
import { AccountUsernameUpdateErrorV1Schema } from '../account/profile.js';
import { z } from 'zod/mini';
import { PublicProfilePreparedRequestV1Schema, PublicProfileMutationResultV1Schema,
  type PublicProfilePreparedRequestV1 } from '../account/publicProfilePublication.js';
import { ACTION_ID_FAMILIES_V1 } from './actionIds.js';
import { FriendsMutationErrorSchema } from '../social/friends.js';

import {
  HOME_GOVERNANCE_ACTION_IDS_V1,
  type HomeGovernanceActionIdV1,
} from '../home/governance/actionsV1.js';
import { TEAM_HOME_ACTION_IDS_V1 } from '../teams/actionsV1.js';
import {
  MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
  type ManagedIdentityProviderActionIdV1,
} from '../identity/providers.js';
import {
  MANAGED_GITHUB_APP_ACTION_IDS_V1,
  type ManagedGitHubAppActionIdV1,
} from '../identity/githubApps.js';
import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainHttpRequestV1, type HomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import { HomeGovernanceErrorV1Schema } from '../home/governance/errors.js';
import { HomeSettingsInvalidErrorV1Schema } from '../home/governance/settings.js';
import { TeamErrorV1Schema } from '../teams/errors.js';
import { TeamIdentityErrorV1Schema } from '../teams/identity/errors.js';
import { HOME_IDENTITY_ACTION_IDS_V1, type HomeIdentityActionIdV1 } from '../teams/identity/actionIds.js';
import { TeamDirectoryErrorV1Schema } from '../teams/directory/v1.js';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceErrorV1Schema } from '../teams/credentials/resourceV1.js';
import { ManagedIdentityProviderErrorV1Schema } from '../identity/providers.js';
import { ManagedGitHubAppErrorV1Schema } from '../identity/githubApps.js';
import { AccountDirectoryRouteErrorResponseV1Schema } from '../auth/accountDirectory.js';
import { ProviderErrorV1Schema } from '../providers/errors.js';
import {
  SHARED_SAVED_SECRET_ACTION_IDS_V1,
  SavedSecretResourceActionErrorV1Schema,
  type SharedSavedSecretActionIdV1,
} from '../account/settings/savedSecretResourceActionsV1.js';

/**
 * Home governance and Teams are two domains but one transport family: both are
 * carried to one exact Home over the same request authority, and both are
 * decided by that Home's transaction. Composing them here gives hosts a single
 * `homeDomainAction` dependency to wire instead of two nearly identical ones.
 *
 * Everything a host needs is read from the registered Action row, which is the
 * single declaration of each intent's path and codecs. This module keeps no
 * table of its own: a parallel path or schema map is exactly the split-brain
 * that lets a route and its catalog entry drift apart.
 */
type AccountProfileHomeDomainActionIdV1 = Exclude<typeof ACTION_ID_FAMILIES_V1.account_profile[number], 'account.public_profile.preview'>;
export const HOME_DOMAIN_ACTION_IDS_V1 = [
  ...ACTION_ID_FAMILIES_V1.account_profile.filter((id): id is AccountProfileHomeDomainActionIdV1 => id !== 'account.public_profile.preview'),
  ...ACTION_ID_FAMILIES_V1.friends,
  ...HOME_GOVERNANCE_ACTION_IDS_V1,
  ...HOME_IDENTITY_ACTION_IDS_V1,
  ...TEAM_HOME_ACTION_IDS_V1,
  ...MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
  ...MANAGED_GITHUB_APP_ACTION_IDS_V1,
  ...SHARED_SAVED_SECRET_ACTION_IDS_V1,
  ...ACTION_ID_FAMILIES_V1.session_organization_resources,
  'session.delete',
  'session.section.set',
  'session.tags.set',
] as const;

export type HomeDomainActionIdV1 =
  | AccountProfileHomeDomainActionIdV1
  | typeof ACTION_ID_FAMILIES_V1.friends[number]
  | HomeGovernanceActionIdV1
  | HomeIdentityActionIdV1
  | typeof TEAM_HOME_ACTION_IDS_V1[number]
  | ManagedIdentityProviderActionIdV1
  | ManagedGitHubAppActionIdV1
  | SharedSavedSecretActionIdV1
  | typeof ACTION_ID_FAMILIES_V1.session_organization_resources[number]
  | 'session.delete' | 'session.section.set' | 'session.tags.set';

export const HomeDomainActionIdV1Schema = lazyZodSchema(() => z.enum(HOME_DOMAIN_ACTION_IDS_V1));

const HOME_DOMAIN_ACTION_ID_SET: ReadonlySet<string> = new Set(HOME_DOMAIN_ACTION_IDS_V1);

export function isHomeDomainActionIdV1(value: string): value is HomeDomainActionIdV1 {
  return HOME_DOMAIN_ACTION_ID_SET.has(value);
}

const HOME_DOMAIN_ERROR_SCHEMAS_V1 = [
  AccountUsernameUpdateErrorV1Schema,
  FriendsMutationErrorSchema,
  HomeGovernanceErrorV1Schema,
  HomeSettingsInvalidErrorV1Schema,
  TeamErrorV1Schema,
  TeamIdentityErrorV1Schema,
  TeamDirectoryErrorV1Schema,
  TeamCredentialResourceErrorV1Schema,
  ManagedIdentityProviderErrorV1Schema,
  ManagedGitHubAppErrorV1Schema,
  AccountDirectoryRouteErrorResponseV1Schema,
  SavedSecretResourceActionErrorV1Schema,
] as const;

type HomeDomainActionObjectErrorV1 = z.infer<
  (typeof HOME_DOMAIN_ERROR_SCHEMAS_V1)[number]
>;

/** Every code accepted by the canonical Home-domain error reader. */
export type HomeDomainActionErrorCodeV1 =
  | HomeDomainActionObjectErrorV1['error']
  | z.infer<typeof ProviderErrorV1Schema>['code']
  | 'session_absent' | 'session_active' | 'session_delete_conflict';

// The session DELETE route predates typed error codes. Keep its exact released
// refusals at the same Home error boundary as the other domain envelopes.
const SessionDeleteRefusalSchema = lazyZodSchema(() => z.strictObject({
  error: z.enum(['Session not found or not owned by user', 'Session is active', 'Session delete condition was lost']),
}));

/**
 * Reads the existing answering domain's typed refusal without creating a
 * family-level error vocabulary. Authentication and absent-route handling stay
 * with each HTTP adapter and run only when no canonical domain schema matches.
 */
export function readHomeDomainActionErrorV1(value: unknown): Readonly<{
  code: HomeDomainActionErrorCodeV1;
  details: unknown;
}> | null {
  for (const schema of HOME_DOMAIN_ERROR_SCHEMAS_V1) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { code: parsed.data.error, details: parsed.data };
  }
  const sessionDelete = SessionDeleteRefusalSchema.safeParse(value);
  if (sessionDelete.success) return {
    code: sessionDelete.data.error === 'Session not found or not owned by user'
      ? 'session_absent'
      : sessionDelete.data.error === 'Session is active'
        ? 'session_active'
        : 'session_delete_conflict',
    details: sessionDelete.data,
  };
  const provider = ProviderErrorV1Schema.safeParse(value);
  return provider.success
    ? { code: provider.data.code, details: provider.data }
    : null;
}

export type HomeDomainActionTransportV1 = Readonly<{ method: string; path: string; preservePathFieldsInBody?: true }>;

/** The exact Home-local transport this intent declared on its Action row. */
export function homeDomainActionTransportV1(
  actionId: HomeDomainActionIdV1,
): HomeDomainActionTransportV1 {
  const transport = getActionSpec(actionId).serverTransport;
  if (!transport) {
    // A registered family row without a declared transport is a registry defect,
    // not a runtime condition a caller could recover from.
    throw new TypeError(`Home family Action declares no server transport: ${actionId}`);
  }
  return transport;
}

/** The strict domain result this intent declared on its Action row. */
export function homeDomainActionOutputSchemaV1(actionId: HomeDomainActionIdV1, preparedRequest?: PublicProfilePreparedRequestV1): z.ZodMiniType {
  if (preparedRequest) {
    bindPublicProfilePreparedHttpRequestV1(actionId, preparedRequest);
    return PublicProfileMutationResultV1Schema;
  }
  const outputSchema = getActionSpec(actionId).outputSchema;
  if (!outputSchema) {
    throw new TypeError(`Home family Action declares no result schema: ${actionId}`);
  }
  return outputSchema;
}

/** The strict domain input this intent declared on its Action row. */
export function homeDomainActionInputSchemaV1(actionId: HomeDomainActionIdV1): z.ZodMiniType {
  return getActionSpec(actionId).inputSchema;
}

/** Bind the exact Action row and strict input to its Home-local HTTP request. */
export function bindHomeDomainActionHttpRequestV1(
  actionId: HomeDomainActionIdV1,
  input: unknown,
): HomeDomainHttpRequestV1 {
  const request = bindHomeDomainHttpRequestV1({
    transport: homeDomainActionTransportV1(actionId),
    inputSchema: homeDomainActionInputSchemaV1(actionId),
    input,
  });
  // Both closed input shapes belong to the same admitted Action. Finite Team
  // probes keep their route; known catalog sets use the existing discovery route.
  return actionId === 'teams.credentials.entitled.list' && request.body
    && typeof request.body === 'object' && 'teamIds' in request.body
    ? { ...request, path: TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1 }
    : request;
}

/** Prepared disclosure bodies have a distinct closed grammar, using the same row's transport. */
export function bindPublicProfilePreparedHttpRequestV1(
  actionId: HomeDomainActionIdV1,
  input: unknown,
): HomeDomainHttpRequestV1 {
  const prepared = PublicProfilePreparedRequestV1Schema.parse(input);
  if (actionId !== `account.public_profile.${prepared.operation}`) {
    throw new TypeError('Prepared public-profile operation does not match its Action');
  }
  return bindHomeDomainHttpRequestV1({
    transport: homeDomainActionTransportV1(actionId),
    // The union above strictly validates the operation and its exact body;
    // the generic binder only consumes the already-validated object here.
    inputSchema: z.unknown(), input: prepared.body,
  });
}
