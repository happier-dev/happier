import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import readAccessKey from '../auth/ensure_active_access_key_valid.mjs';
import { resolveStackCredentialPaths } from '../auth/credentials_paths.mjs';
import { resolveStackActiveServerId } from '../auth/stable_scope_id.mjs';
import { resolveCliHomeDir } from '../stack/dirs.mjs';
import { readStackOwnServerIdentity, readStackServerProfileHomeDescriptor, resolveStackOwnServerIdentityRecordPath } from '../stack/server_profile_reconciliation.mjs';

export function readHomeDescriptorReadinessContext({ env, cliHomeDir, serverUrl }) {
  // Auth-safe startup exposes the login listener first. It cannot require the
  // sign-in it is starting, and it never refreshes retained Home endpoints.
  if (env?.HAPPIER_STACK_AUTH_FLOW === '1') return null;
  // Listener-only callers (isolated build smoke, first-run sign-in and legacy
  // URL-only profiles) have no established Home authority to refresh.
  if (!cliHomeDir && !env?.HAPPIER_STACK_CLI_HOME_DIR && !env?.HAPPIER_HOME_DIR) return null;
  const scopedEnv = env ?? {};
  const homeDir = cliHomeDir || resolveCliHomeDir(scopedEnv, { preferStackCliHomeDir: true });
  const serverId = resolveStackActiveServerId({ env: scopedEnv });
  const descriptor = readStackServerProfileHomeDescriptor({ homeDir, serverId });
  if (!descriptor) return null;
  const paths = resolveStackCredentialPaths({ cliHomeDir: homeDir, serverUrl, env: { ...scopedEnv,
    ...(serverId ? { HAPPIER_ACTIVE_SERVER_ID: serverId } : {}) } });
  const accessKey = readAccessKey(paths.serverScopedPath) || readAccessKey(paths.legacyPath);
  // The stack's own server may mint its identity during this startup, so the record is read when
  // an observation disagrees with the established Home, not here.
  const readOwnServerIdentity = () => readStackOwnServerIdentity(scopedEnv);
  const ownServerIdentityRecordPath = resolveStackOwnServerIdentityRecordPath(scopedEnv);
  if (!accessKey) return { expectedHomeServerIdentityId: descriptor.homeServerIdentityId, readOwnServerIdentity, ownServerIdentityRecordPath, headers: null };
  return { expectedHomeServerIdentityId: descriptor.homeServerIdentityId, readOwnServerIdentity, ownServerIdentityRecordPath,
    headers: { Authorization: `Bearer ${accessKey}` } };
}

/** @returns {{ status: 'pending' | 'ready' | 'sign-in-required', homeIdentityRecordPath?: string }} */
export function resolveHomeDescriptorReadiness(observation, context) {
  if (!context.headers) {
    return { status: observation.ready ? 'sign-in-required' : 'pending' };
  }
  if (observation.status === 401 || observation.status === 403) {
    return { status: 'sign-in-required' };
  }
  if (!(observation.status >= 200 && observation.status < 300)) return { status: 'pending' };
  const parsed = FeaturesResponseSchema.safeParse(observation.json);
  if (!parsed.success || !parsed.data.homeConnectionDescriptor) return { status: 'pending' };
  const descriptor = parsed.data.homeConnectionDescriptor;
  const observedIdentity = normalizeServerIdentityIdCapability(parsed.data.capabilities.serverIdentity?.serverIdentityId);
  if (!observedIdentity || descriptor.homeServerIdentityId !== observedIdentity) {
    throw new Error('Authenticated Home descriptor identity does not match the established Home');
  }
  if (observedIdentity === context.expectedHomeServerIdentityId) return { status: 'ready' };
  // A shared-database stack's own server mints its own Home identity; that recorded identity is
  // the only change this stack originated. The record goes to daemon profile reconciliation, which
  // re-establishes the profile only after this live server proved to publish it.
  if (observedIdentity !== context.readOwnServerIdentity?.()) {
    throw new Error('Authenticated Home descriptor identity does not match the established Home');
  }
  return { status: 'ready', homeIdentityRecordPath: context.ownServerIdentityRecordPath };
}
