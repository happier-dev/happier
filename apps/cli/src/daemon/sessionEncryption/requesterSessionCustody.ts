import { join } from 'node:path';
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
  scope: z.optional(z.enum(['workflow_trigger'])),
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
});

export const CustodyStoredReadSchema = createStoredReadSchema(CustodySchema);

export type RequesterSessionCredentialBinding = Readonly<{
  happyHomeDir: string;
  sessionId: string;
  scope?: 'workflow_trigger';
  attribution: RequesterWorkAttributionV1;
}>;

/** Local private state, not a Session lifecycle ledger or an authority witness. */
export function requesterSessionCredentialPath(binding: Pick<RequesterSessionCredentialBinding, 'happyHomeDir' | 'sessionId' | 'scope'>
  & Readonly<{ attribution: Pick<RequesterWorkAttributionV1, 'serverId'> }>): string {
  const prefix = binding.scope === 'workflow_trigger' ? 'workflow-trigger' : 'session';
  return join(binding.happyHomeDir, 'requester-session-credentials',
    `home-${encodeURIComponent(binding.attribution.serverId)}`,
    `${prefix}-${encodeURIComponent(binding.sessionId)}.json`);
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
