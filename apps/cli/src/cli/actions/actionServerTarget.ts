import type { StoredCredentials } from '@/persistence';
import { resolveServerProfileHomeIdentityId, type ServerProfile } from '@/server/serverProfiles';
import { observeServerProfileHomeConnection } from '@/server/profileObservation';
import { configuration } from '@/configuration';
import { ACTION_CLI_SERVER_ID_FLAG } from './parseCommandInput';

export { ACTION_CLI_SERVER_ID_FLAG } from './parseCommandInput';

export type ActionCliCredentialTargetDeps = Readonly<{
  readCredentialsFn: () => Promise<StoredCredentials | null>;
  readCredentialsForServerIdFn: (serverId: string) => Promise<StoredCredentials | null>;
  getServerProfileFn: (serverId: string) => Promise<ServerProfile>;
}>;

export type ActionCliFixedServerTarget = Readonly<{
  /** Device-local routing/credential profile; portable Home records use serverIdentityId. */
  serverId: string;
  /** Stable identity observed from the exact Home endpoint; never inferred from the profile id. */
  serverIdentityId?: string;
  serverApiUrl: string;
}>;

/** Reads one CLI Action Home selector without treating bytes after `--` as options. */
export function readActionCliServerId(argv: readonly string[], acceptsServerId: boolean): string | null {
  if (!acceptsServerId) return null;
  let selected: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    let value: string | null = null;
    if (token === ACTION_CLI_SERVER_ID_FLAG) {
      const next = argv[index + 1];
      if (typeof next !== 'string' || next.startsWith('--')) {
        throw Object.assign(new Error(`Option ${ACTION_CLI_SERVER_ID_FLAG} requires a value.`), { code: 'invalid_arguments' });
      }
      value = next.trim();
      index += 1;
    } else if (token.startsWith(`${ACTION_CLI_SERVER_ID_FLAG}=`)) {
      value = token.slice(ACTION_CLI_SERVER_ID_FLAG.length + 1).trim();
    }
    if (value === null) continue;
    if (!value) {
      throw Object.assign(new Error(`Option ${ACTION_CLI_SERVER_ID_FLAG} requires a value.`), { code: 'invalid_arguments' });
    }
    if (selected !== null) {
      throw Object.assign(new Error(`Provide ${ACTION_CLI_SERVER_ID_FLAG} once.`), { code: 'invalid_arguments' });
    }
    selected = value;
  }
  return selected;
}

/**
 * Resolves credentials and endpoint as one qualified Home target. Callers may
 * parse argv differently, but none may pair an explicit URL with ambient Home
 * identity or independently reinterpret exact profile identity.
 */
export async function resolveActionCliCredentialTarget(params: Readonly<{
  requestedServerId: string | null;
  requireServerIdentityId?: boolean;
  deps: ActionCliCredentialTargetDeps;
}>): Promise<Readonly<{
  credentials: StoredCredentials | null;
  fixedServer: ActionCliFixedServerTarget | null;
  serverIdentityId?: string;
  /** Portable endpoint for exported commands, not a device-local connection override. */
  canonicalServerUrl?: string;
}>> {
  const prepareProfile = async (profile: ServerProfile | null, credentials: StoredCredentials | null) => {
    if (!profile || !credentials || profile.homeConnectionDescriptorAuthority === 'exact' && profile.homeConnectionDescriptor) {
      return { profile, serverIdentityId: profile ? await resolveServerProfileHomeIdentityId(profile.id) ?? undefined : undefined };
    }
    // URL-only profiles can authenticate a Home even while its descriptor is
    // withheld. Keep that identity invocation-scoped at the observation owner.
    const observation = await observeServerProfileHomeConnection({ profileId: profile.id,
      serverUrl: profile.localServerUrl ?? profile.serverUrl, token: credentials.token,
    }).catch(() => null);
    if (!observation) return { profile, serverIdentityId: undefined };
    const serverIdentityId = observation.descriptorOutcome === 'unavailable' ? observation.serverIdentityId
      : await resolveServerProfileHomeIdentityId(profile.id) ?? undefined;
    return { profile: observation.profile, serverIdentityId };
  };
  if (params.requestedServerId === null) {
    const credentials = await params.deps.readCredentialsFn();
    const { serverIdentityId } = await prepareProfile(await params.deps.getServerProfileFn(configuration.activeServerId).catch(() => null), credentials);
    return { credentials, fixedServer: null,
      ...(serverIdentityId ? { serverIdentityId } : {}) };
  }
  const selectedProfile = await params.deps.getServerProfileFn(params.requestedServerId);
  const credentials = await params.deps.readCredentialsForServerIdFn(selectedProfile.id);
  const prepared = await prepareProfile(selectedProfile, credentials);
  const profile = prepared.profile ?? selectedProfile;
  const serverIdentityId = prepared.serverIdentityId;
  if (params.requireServerIdentityId && !serverIdentityId) {
    throw Object.assign(
      new Error(`Saved Home "${profile.id}" has no verified server identity. Re-add or refresh it before retrying.`),
      { code: 'server_identity_unavailable' },
    );
  }
  return {
    credentials,
    canonicalServerUrl: profile.homeConnectionDescriptor?.canonicalServerUrl ?? profile.serverUrl,
    ...(serverIdentityId ? { serverIdentityId } : {}),
    fixedServer: {
      serverId: profile.id,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      serverApiUrl: profile.localServerUrl ?? profile.serverUrl,
    },
  };
}
