import { publishAccountServiceHomeLink } from '@happier-dev/cli-common/accountService';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';
import { ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1, ACCOUNT_DIRECTORY_ERROR_CODES_V1, AccountDirectoryHomePutRequestV1Schema, AccountDirectoryHomePutResponseV1Schema, AccountDirectoryLinkDeleteRequestV1Schema, AccountDirectoryLinkDeleteResponseV1Schema, AccountDirectoryLinkPutRequestV1Schema, AccountDirectoryLinkPutResponseV1Schema, AccountDirectoryMeResponseV1Schema, AccountDirectoryRouteErrorResponseV1Schema, buildAccountDirectoryHomeHttpPathV1, buildAccountDirectoryLinkHttpPathV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { AccountDirectoryCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/accountDirectoryCapabilities';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import { buildTerminalAuthorityCeilingHttpHeaders } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentialsForServerId } from '@/persistence';
import { getActiveServerProfile, getServerProfile, type ServerProfile } from '@/server/serverProfiles';

import {
  createCliAccountServiceSessionOwner,
  type CliAccountServiceRestrictedCredential,
  type CliAccountServiceSelectionAuthority,
} from './cliAccountServiceSession';

export type CliHomeLinkUnavailableReason =
  | 'home_profile_unavailable'
  | 'home_credentials_unavailable'
  | 'account_service_credentials_unavailable'
  | 'home_transport_unavailable';

export type CliHomeLinkResult =
  | Readonly<{ kind: 'linked'; homeServerIdentityId: string }>
  | Readonly<{ kind: 'relink_required'; homeServerIdentityId: string }>
  | Readonly<{
      kind: 'unavailable';
      reason: CliHomeLinkUnavailableReason;
      /** The selected sign-in service, when one is selected but not signed in. */
      selectedEndpoint?: string;
    }>
  | Readonly<{ kind: 'cancelled' | 'failed' }>;

export type CliHomeUnlinkResult =
  | Readonly<{ kind: 'unlinked'; homeServerIdentityId: string; issuerServerIdentityId: string }>
  | Readonly<{ kind: 'unavailable'; reason: CliHomeLinkUnavailableReason }>
  | Readonly<{ kind: 'cancelled' | 'failed' }>;

class CliHomeRelinkConflictError extends Error {}
class CliHomeTransportUnavailableError extends Error {}

function endpointUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/u, '')}${path}`;
}

/** The exact-authority Home profile a link operation may act on; null fails closed. */
async function resolveExactHomeProfile(homeServerIdentityId: string | undefined): Promise<Readonly<{
  profile: ServerProfile;
  descriptor: NonNullable<ServerProfile['homeConnectionDescriptor']>;
}> | null> {
  let profile: ServerProfile;
  try {
    profile = homeServerIdentityId
      ? await getServerProfile(homeServerIdentityId)
      : await getActiveServerProfile();
  } catch {
    return null;
  }
  const descriptor = profile.homeConnectionDescriptor;
  if (!descriptor || profile.homeConnectionDescriptorAuthority !== 'exact') return null;
  return { profile, descriptor };
}

async function parsedRequest<T>(input: Readonly<{
  url: string;
  token: string;
  serverHttpBaseUrl: string;
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } };
  init?: RequestInit;
  signal?: AbortSignal;
}>): Promise<T> {
  const headers = new Headers(input.init?.headers);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${input.token}`);
  for (const [key, value] of Object.entries(buildTerminalAuthorityCeilingHttpHeaders({ token: input.token, serverHttpBaseUrl: input.serverHttpBaseUrl }))) {
    headers.set(key, value);
  }
  const response = await fetch(input.url, { ...input.init, headers, signal: input.signal });
  if (!response.ok) {
    if (response.status === 409) {
      const payload: unknown = await response.json().catch(() => null);
      const parsed = AccountDirectoryRouteErrorResponseV1Schema.safeParse(payload);
      if (parsed.success && parsed.data.error === ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest) {
        throw new CliHomeRelinkConflictError();
      }
    }
    throw new Error(`Home-link request failed (${response.status})`);
  }
  const parsed = input.schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('Invalid Home-link response');
  return parsed.data;
}

export async function linkCliHomeToAccountService(input: Readonly<{
  homeServerIdentityId?: string;
  relink: boolean;
  signal?: AbortSignal;
  expectedAccountServiceSelection?: Readonly<{ endpoint: string; serverIdentityId: string }>;
}>): Promise<CliHomeLinkResult> {
  const linked = await resolveExactHomeProfile(input.homeServerIdentityId);
  if (!linked) return { kind: 'unavailable', reason: 'home_profile_unavailable' };
  const { profile, descriptor } = linked;

  const session = createCliAccountServiceSessionOwner({
    happyHomeDir: resolveHappyHomeDirFromEnvironment(process.env),
  });
  let selection: CliAccountServiceSelectionAuthority | null;
  try {
    selection = await session.readSelection();
  } catch {
    return { kind: 'failed' };
  }
  if (!selection) return { kind: 'unavailable', reason: 'account_service_credentials_unavailable' };
  if (
    input.expectedAccountServiceSelection
    && (
      selection.endpoint !== input.expectedAccountServiceSelection.endpoint
      || selection.serverIdentityId !== input.expectedAccountServiceSelection.serverIdentityId
    )
  ) {
    return { kind: 'failed' };
  }
  let accountServiceCredential: CliAccountServiceRestrictedCredential | null;
  try {
    accountServiceCredential = await session.readCredential(selection);
  } catch {
    return { kind: 'failed' };
  }
  if (!accountServiceCredential) {
    return { kind: 'unavailable', reason: 'account_service_credentials_unavailable', selectedEndpoint: selection.endpoint };
  }

  const snapshot = await fetchServerFeaturesSnapshot({
    serverUrl: selection.endpoint,
    token: accountServiceCredential.token,
    signal: input.signal,
  });
  const capability = snapshot.status === 'ready'
    ? AccountDirectoryCapabilitiesSchema.safeParse(snapshot.features.capabilities.accountDirectory)
    : null;
  const observedIdentity = snapshot.status === 'ready'
    ? normalizeServerIdentityIdCapability(snapshot.features.capabilities.serverIdentity.serverIdentityId)
    : null;
  if (!capability?.success || !capability.data.homeDirectory || observedIdentity !== selection.serverIdentityId) {
    return { kind: 'failed' };
  }

  const result = await publishAccountServiceHomeLink({
    home: {
      homeServerIdentityId: descriptor.homeServerIdentityId,
      canonicalServerUrl: descriptor.canonicalServerUrl,
      label: profile.name,
      connectionDescriptor: descriptor,
    },
    issuerServerIdentityId: selection.serverIdentityId,
    issuerSigningKeyId: capability.data.homeLoginAssertion.keyId,
    issuerSigningPublicKeyBase64Url: capability.data.homeLoginAssertion.publicKeyBase64Url,
    relink: input.relink,
    shouldCancel: () => input.signal?.aborted === true,
    adapters: {
      readHomeCredential: async () => await readStoredCredentialsForServerId(profile.id),
      readAccountServiceCredential: async (identity) => identity === selection.serverIdentityId
        ? accountServiceCredential
        : null,
      readAccountSubject: async (credential) => (await parsedRequest({
        url: endpointUrl(selection.endpoint, ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1),
        token: credential.token,
        serverHttpBaseUrl: selection.endpoint,
        schema: AccountDirectoryMeResponseV1Schema,
        signal: input.signal,
      })).accountId,
      publishLinkToHome: async ({ credential, issuerSubjectId, relink }) => {
        const acquired = await acquireTerminalAuthEnrollmentRuntime(descriptor, undefined, input.signal);
        if (!acquired.ok) throw new CliHomeTransportUnavailableError();
        try {
          const body = AccountDirectoryLinkPutRequestV1Schema.parse({
            v: 1,
            issuerServerIdentityId: selection.serverIdentityId,
            issuerSubjectId,
            issuerSigningKeyId: capability.data.homeLoginAssertion.keyId,
            issuerSigningPublicKeyBase64Url: capability.data.homeLoginAssertion.publicKeyBase64Url,
            relink,
          });
          await parsedRequest({
            url: endpointUrl(acquired.runtime.runtimeOrigin, buildAccountDirectoryLinkHttpPathV1(selection.serverIdentityId)),
            token: credential.token,
            serverHttpBaseUrl: acquired.runtime.runtimeOrigin,
            schema: AccountDirectoryLinkPutResponseV1Schema,
            init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
            signal: input.signal,
          });
        } finally {
          await acquired.close().catch(() => undefined);
        }
      },
      publishHomeToAccountService: async ({ home, credential }) => {
        const body = AccountDirectoryHomePutRequestV1Schema.parse({
          v: 1,
          label: home.label,
          connectionDescriptor: home.connectionDescriptor,
        });
        await parsedRequest({
          url: endpointUrl(selection.endpoint, buildAccountDirectoryHomeHttpPathV1(home.homeServerIdentityId)),
          token: credential.token,
          serverHttpBaseUrl: selection.endpoint,
          schema: AccountDirectoryHomePutResponseV1Schema,
          init: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        });
      },
    },
  });
  if (result.kind === 'linked') return result;
  if (result.kind === 'cancelled') return { kind: 'cancelled' };
  if (result.kind === 'unavailable') return { kind: 'unavailable', reason: result.reason };
  if (result.error instanceof CliHomeRelinkConflictError && !input.relink) {
    return { kind: 'relink_required', homeServerIdentityId: descriptor.homeServerIdentityId };
  }
  if (input.signal?.aborted) return { kind: 'cancelled' };
  if (result.error instanceof CliHomeTransportUnavailableError) {
    return { kind: 'unavailable', reason: 'home_transport_unavailable' };
  }
  return { kind: 'failed' };
}

/**
 * Stops the selected Account Service from signing in to this Home: deletes the Home's pinned trust
 * link with the Home's own credential only. Future delegated assertions from that service are
 * refused; Home credentials it already issued stay valid until revoked on the Home, and the
 * service's Directory row is left in place. Only the selected service identity is read — no
 * Account Service credential or feature probe is needed.
 */
export async function unlinkCliHomeFromAccountService(input: Readonly<{
  homeServerIdentityId?: string;
  signal?: AbortSignal;
}>): Promise<CliHomeUnlinkResult> {
  const linked = await resolveExactHomeProfile(input.homeServerIdentityId);
  if (!linked) return { kind: 'unavailable', reason: 'home_profile_unavailable' };

  const session = createCliAccountServiceSessionOwner({
    happyHomeDir: resolveHappyHomeDirFromEnvironment(process.env),
  });
  let selection: CliAccountServiceSelectionAuthority | null;
  try {
    selection = await session.readSelection();
  } catch {
    return { kind: 'failed' };
  }
  if (!selection) return { kind: 'unavailable', reason: 'account_service_credentials_unavailable' };

  const homeCredential = await readStoredCredentialsForServerId(linked.profile.id);
  if (!homeCredential) return { kind: 'unavailable', reason: 'home_credentials_unavailable' };
  if (input.signal?.aborted) return { kind: 'cancelled' };

  const acquired = await acquireTerminalAuthEnrollmentRuntime(linked.descriptor, undefined, input.signal);
  if (!acquired.ok) return { kind: 'unavailable', reason: 'home_transport_unavailable' };
  try {
    await parsedRequest({
      url: endpointUrl(acquired.runtime.runtimeOrigin, buildAccountDirectoryLinkHttpPathV1(selection.serverIdentityId)),
      token: homeCredential.token,
      serverHttpBaseUrl: acquired.runtime.runtimeOrigin,
      schema: AccountDirectoryLinkDeleteResponseV1Schema,
      init: {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(AccountDirectoryLinkDeleteRequestV1Schema.parse({ v: 1 })),
      },
      signal: input.signal,
    });
    return {
      kind: 'unlinked',
      homeServerIdentityId: linked.descriptor.homeServerIdentityId,
      issuerServerIdentityId: selection.serverIdentityId,
    };
  } catch {
    return input.signal?.aborted ? { kind: 'cancelled' } : { kind: 'failed' };
  } finally {
    await acquired.close().catch(() => undefined);
  }
}
