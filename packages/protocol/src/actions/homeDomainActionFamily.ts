import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { ACTION_ID_FAMILIES_V1 } from './actionIds.js';

import {
  HOME_GOVERNANCE_ACTION_IDS_V1,
  type HomeGovernanceActionIdV1,
} from '../home/governance/actionsV1.js';
import { TEAM_ACTION_IDS_V1, type TeamActionIdV1 } from '../teams/actionsV1.js';
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
import { TeamCredentialResourceErrorV1Schema } from '../teams/credentials/resourceV1.js';
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
export const HOME_DOMAIN_ACTION_IDS_V1 = [
  ...HOME_GOVERNANCE_ACTION_IDS_V1,
  ...HOME_IDENTITY_ACTION_IDS_V1,
  ...TEAM_ACTION_IDS_V1,
  ...MANAGED_IDENTITY_PROVIDER_ACTION_IDS_V1,
  ...MANAGED_GITHUB_APP_ACTION_IDS_V1,
  ...SHARED_SAVED_SECRET_ACTION_IDS_V1,
  ...ACTION_ID_FAMILIES_V1.session_organization_resources,
  'session.delete',
  'session.folder.set',
  'session.tags.set',
] as const;

export type HomeDomainActionIdV1 =
  | HomeGovernanceActionIdV1
  | HomeIdentityActionIdV1
  | TeamActionIdV1
  | ManagedIdentityProviderActionIdV1
  | ManagedGitHubAppActionIdV1
  | SharedSavedSecretActionIdV1
  | typeof ACTION_ID_FAMILIES_V1.session_organization_resources[number]
  | 'session.delete' | 'session.folder.set' | 'session.tags.set';

export const HomeDomainActionIdV1Schema = lazyZodSchema(() => z.enum(HOME_DOMAIN_ACTION_IDS_V1));

const HOME_DOMAIN_ACTION_ID_SET: ReadonlySet<string> = new Set(HOME_DOMAIN_ACTION_IDS_V1);

export function isHomeDomainActionIdV1(value: string): value is HomeDomainActionIdV1 {
  return HOME_DOMAIN_ACTION_ID_SET.has(value);
}

const HOME_DOMAIN_ERROR_SCHEMAS_V1 = [
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
  | 'session_absent' | 'session_delete_conflict';

// The session DELETE route predates typed error codes. Keep its exact released
// refusals at the same Home error boundary as the other domain envelopes.
const SessionDeleteRefusalSchema = lazyZodSchema(() => z.object({
  error: z.enum(['Session not found or not owned by user', 'Session delete condition was lost']),
}).strict());

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
      ? 'session_absent' : 'session_delete_conflict',
    details: sessionDelete.data,
  };
  const provider = ProviderErrorV1Schema.safeParse(value);
  return provider.success
    ? { code: provider.data.code, details: provider.data }
    : null;
}

export type HomeDomainActionTransportV1 = Readonly<{ method: string; path: string }>;

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
export function homeDomainActionOutputSchemaV1(actionId: HomeDomainActionIdV1): z.ZodTypeAny {
  const outputSchema = getActionSpec(actionId).outputSchema;
  if (!outputSchema) {
    throw new TypeError(`Home family Action declares no result schema: ${actionId}`);
  }
  return outputSchema;
}

/** The strict domain input this intent declared on its Action row. */
export function homeDomainActionInputSchemaV1(actionId: HomeDomainActionIdV1): z.ZodTypeAny {
  return getActionSpec(actionId).inputSchema;
}

/** Bind the exact Action row and strict input to its Home-local HTTP request. */
export function bindHomeDomainActionHttpRequestV1(
  actionId: HomeDomainActionIdV1,
  input: unknown,
): HomeDomainHttpRequestV1 {
  return bindHomeDomainHttpRequestV1({
    transport: homeDomainActionTransportV1(actionId),
    inputSchema: homeDomainActionInputSchemaV1(actionId),
    input,
  });
}
