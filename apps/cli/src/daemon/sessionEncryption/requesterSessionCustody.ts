import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { SessionRequesterBootstrapCredentialsV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import { configuration } from '@/configuration';
import { bindRequesterSessionCredentialScope, decodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readPrivateOwnerFile } from '../privateBearerFile';

// File custody is also read by the runner's first metadata write. Keep this
// codec and opener independent of daemon admission and provider services.
export const REQUESTER_SESSION_CREDENTIAL_FILE_ENV = 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE';

export const REQUESTER_SESSION_ID_ENV = 'HAPPIER_SESSION_REQUESTER_SESSION_ID';

export const CustodySchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().check(z.minLength(1)),
  scope: z.optional(z.enum(['workflow_trigger', 'workspace_sync_relationship'])),
  endpointRole: z.optional(z.literal('source')),
  executionIdentity: z.optional(z.strictObject({
    kind: z.literal('isolated'),
    requester: RequesterWorkAttributionV1Schema,
    separationRequired: z.boolean(),
    presentPerson: z.optional(z.literal(true)),
    accountAutomation: z.optional(z.literal(true)),
  })),
  automationId: z.optional(z.string().check(z.minLength(1))),
  retireWhenIdle: z.optional(z.literal(true)),
  attribution: RequesterWorkAttributionV1Schema,
  homeServerIdentityId: z.optional(z.string().check(z.minLength(1))),
  /** The daemon's Machine admission for this requester; the actor is attribution.accountId. */
  machineAdmission: z.optional(z.strictObject({
    custodianAccountId: z.string().check(z.minLength(1)),
    role: z.optional(z.enum(['use', 'manage'])),
  })),
  credentials: SessionRequesterBootstrapCredentialsV1Schema,
}).check(z.refine(value => value.scope === 'workspace_sync_relationship'
  ? value.endpointRole === 'source' ? value.executionIdentity === undefined
    : value.executionIdentity !== undefined && isDeepStrictEqual(value.executionIdentity.requester, value.attribution)
  : value.executionIdentity === undefined && value.endpointRole === undefined));

export const CustodyStoredReadSchema = createStoredReadSchema(CustodySchema);

export type RequesterSessionCredentialBinding = Readonly<{
  happyHomeDir: string;
  sessionId: string;
  scope?: 'workflow_trigger' | 'workspace_sync_relationship';
  endpointRole?: 'source';
  attribution: RequesterWorkAttributionV1;
}>;

/** Local private state, not a Session lifecycle ledger or an authority witness. */
export function requesterSessionCredentialDirectory(binding: Pick<RequesterSessionCredentialBinding, 'happyHomeDir' | 'endpointRole'>
  & Readonly<{ attribution: Pick<RequesterWorkAttributionV1, 'serverId'> }>): string {
  const root = join(binding.happyHomeDir, 'requester-session-credentials');
  // SOURCE Account custody and TARGET native identity are distinct records,
  // even when they belong to the same relationship on this Machine.
  return join(binding.endpointRole === 'source' ? join(root, 'source') : root,
    `home-${encodeURIComponent(binding.attribution.serverId)}`);
}

export function requesterSessionCredentialFilePrefix(binding: Pick<RequesterSessionCredentialBinding, 'scope'>): string {
  return binding.scope === 'workspace_sync_relationship' ? 'relationship-'
    : binding.scope === 'workflow_trigger' ? 'workflow-trigger-' : 'session-';
}

export function requesterSessionCredentialPath(binding: Pick<RequesterSessionCredentialBinding, 'happyHomeDir' | 'sessionId' | 'scope' | 'endpointRole'>
  & Readonly<{ attribution: Pick<RequesterWorkAttributionV1, 'serverId'> }>): string {
  return join(requesterSessionCredentialDirectory(binding),
    `${requesterSessionCredentialFilePrefix(binding)}${encodeURIComponent(binding.sessionId)}.json`);
}

/** Only a private path travels to the child; failure never selects a global credential. */
export async function readRequesterSessionCredentialsForChild(path: string): Promise<StoredCredentials | null> {
  try {
    if (!path || !process.env[REQUESTER_SESSION_ID_ENV]) return null;
    const value = CustodyStoredReadSchema.parse(JSON.parse(await readPrivateOwnerFile(path)) as unknown);
    if (value.scope || value.sessionId !== process.env[REQUESTER_SESSION_ID_ENV]
      || value.attribution.serverId !== configuration.activeServerId) return null;
    const credentials = decodeStoredCredentials(value.credentials);
    return credentials ? bindRequesterSessionCredentialScope(credentials, { serverId: value.attribution.serverId,
      serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      requesterSession: { sessionId: value.sessionId, attribution: value.attribution,
        ...(value.homeServerIdentityId ? { homeServerIdentityId: value.homeServerIdentityId } : {}),
        ...(value.machineAdmission ? { machineAdmission: value.machineAdmission } : {}) } }) : null;
  } catch { return null; }
}
