import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  assertPersonalHomeServerArtifactCapability,
  getFirstPartyComponentCatalogEntry,
  prepareFirstPartyComponentPayloadFromGitHubRelease,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { runPersonalHomeBootstrapFromSystemTasks } from '@happier-dev/cli-common/firstPartyRuntime/personalHome/bootstrapSystemTasks';
import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol/system/tasks/spec';
import type { HomeConnectionDescriptorV1, SystemTaskSpec } from '@happier-dev/protocol';
import { resolvePublicReleaseRingIdForLabel } from '@happier-dev/release-runtime/releaseRings';

import { authChallenge, encodeBase64, getRandomBytes } from '@/api/encryption';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration, reloadConfiguration } from '@/configuration';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  readStoredCredentialsForServerId,
  removeStoredCredentialsForServerId,
  writeCredentialsTokenOnlyForServerId,
} from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor, getServerProfile, useServerProfile } from '@/server/serverProfiles';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import {
  readProtectedLocalStateFile,
  removeProtectedLocalStateFile,
  writeProtectedLocalStateFileAtomic,
} from '@/utils/fs/protectedLocalState';

import { runSystemTaskToCompletion } from '../systemTaskCliRunner';
import { handleSetupCommand } from '../setup';

type RuntimeTarget = Readonly<{ channel: 'stable' | 'preview' | 'dev'; mode: 'user' | 'system' }>;

function custodyPath(serverUrl: string, serverIdentityId?: string): string {
  const key = createHash('sha256').update(`${serverUrl}\0${serverIdentityId ?? ''}`).digest('hex');
  return join(configuration.happyHomeDir, 'personal-home-bootstrap', `${key}.seed`);
}

async function readSeed(serverUrl: string, serverIdentityId?: string): Promise<Uint8Array | null> {
  try {
    const raw = (await readProtectedLocalStateFile(custodyPath(serverUrl, serverIdentityId))).trim();
    const bytes = new Uint8Array(Buffer.from(raw, 'base64'));
    return bytes.length === 32 ? bytes : null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSeed(serverUrl: string, seed: Uint8Array, serverIdentityId?: string): Promise<boolean> {
  const path = custodyPath(serverUrl, serverIdentityId);
  await writeProtectedLocalStateFileAtomic(path, Buffer.from(seed).toString('base64'), { authority: 'owned' });
  const readback = await readSeed(serverUrl, serverIdentityId);
  return readback != null && Buffer.from(readback).equals(Buffer.from(seed));
}

async function requestToken(endpoint: string, secret: Uint8Array): Promise<string> {
  const { challenge, publicKey, signature } = authChallenge(secret);
  const response = await fetch(`${endpoint.replace(/\/+$/u, '')}/v1/auth`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    },
    body: JSON.stringify({
      challenge: encodeBase64(challenge),
      publicKey: encodeBase64(publicKey),
      signature: encodeBase64(signature),
    }),
  });
  const body = await response.json().catch(() => null) as { token?: unknown; error?: unknown } | null;
  if (!response.ok) throw Object.assign(new Error(String(body?.error ?? `Authentication failed (${response.status})`)), { code: body?.error });
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!token) throw new Error('Authentication returned no token.');
  return token;
}

async function probeEndpoint(endpoint: string) {
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: endpoint });
  if (snapshot.status !== 'ready') return { status: snapshot.status === 'error' ? 'unreachable' as const : 'unknown' as const };
  const serverIdentityId = String(snapshot.features.capabilities.serverIdentity.serverIdentityId ?? '').trim();
  if (!serverIdentityId) return { status: 'unknown' as const };
  const anonymous = snapshot.features.capabilities.auth.signup.methods.find((method) => method.id === 'anonymous');
  const descriptor = snapshot.features.homeConnectionDescriptor;
  return {
    status: 'ready' as const,
    serverIdentityId,
    storagePolicy: snapshot.features.capabilities.encryption.storagePolicy,
    anonymousSignup: anonymous ? (anonymous.enabled ? 'enabled' as const : 'disabled' as const) : 'unknown' as const,
    ...(descriptor?.homeServerIdentityId === serverIdentityId ? { homeConnectionDescriptor: descriptor } : {}),
  };
}

export async function createLocalPersonalHome(
  runtime: RuntimeTarget,
  options: Readonly<{
    allowErasedRuntimeRecreate?: boolean;
    signal?: AbortSignal;
  }> = {},
) {
  const prepared = await prepareFirstPartyComponentPayloadFromGitHubRelease({
    componentId: 'happier-server',
    channel: resolvePublicReleaseRingIdForLabel(runtime.channel),
  });
  try {
    // Seed custody is the first durable bootstrap write, so purpose admission
    // must happen here as well as at the lower-level install mutation boundary.
    // Both checks use the same artifact-contract owner.
    await assertPersonalHomeServerArtifactCapability({
      payloadRoot: prepared.payloadRoot,
      provenance: { channel: runtime.channel, versionId: prepared.versionId },
    });
    const executable = join(
      prepared.payloadRoot,
      `${getFirstPartyComponentCatalogEntry('happier-server').binaryRelativePath}${process.platform === 'win32' ? '.exe' : ''}`,
    );
    const runner = getLiveSystemTasksRunnerAdapter({ personalHomeRuntime: runtime });
    let completedDescriptor: HomeConnectionDescriptorV1 | undefined;
    let observedServerIdentityId = '';
    const readBootstrapCredentials = async (serverIdentityId: string) => {
      const profile = await getServerProfile(serverIdentityId).catch((error: unknown) => {
        if (error instanceof Error && error.message === `Server profile not found: ${serverIdentityId}`) return null;
        throw error;
      });
      if (profile?.homeConnectionDescriptor?.homeServerIdentityId === serverIdentityId) {
        const credentials = await readStoredCredentialsForServerId(profile.id);
        if (credentials) return credentials;
      }
      return await readStoredCredentialsForServerId(serverIdentityId);
    };
    const result = await runPersonalHomeBootstrapFromSystemTasks({
      deps: {
        runRelayTask: async (kind, taskOptions) => await runSystemTaskToCompletion({
          runner: runner as never,
          spec: {
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind,
            params: { target: { kind: 'local' }, ...runtime, ...taskOptions, selfHostRelayBinaryOverride: executable },
          } as SystemTaskSpec,
          signal: options.signal,
        }),
        probeEndpoint: async (endpoint) => {
          const snapshot = await probeEndpoint(endpoint);
          if (snapshot.status === 'ready') {
            observedServerIdentityId = snapshot.serverIdentityId;
            if (snapshot.homeConnectionDescriptor) completedDescriptor = snapshot.homeConnectionDescriptor;
          }
          return snapshot;
        },
        readCredentials: async ({ serverIdentityId }) => await readBootstrapCredentials(serverIdentityId),
        preparePendingBootstrapSeed: async ({ serverUrl, serverIdentityId, allowCreate }) => {
          let seed = await readSeed(serverUrl, serverIdentityId) ?? await readSeed(serverUrl);
          if (!seed && allowCreate) {
            seed = getRandomBytes(32);
            if (!(await writeSeed(serverUrl, seed))) return false;
          }
          if (!seed) return false;
          return serverIdentityId ? await writeSeed(serverUrl, seed, serverIdentityId) : true;
        },
        createLocalAccount: async ({ endpoint, canonicalServerUrl, serverIdentityId }) => {
          const seed = await readSeed(canonicalServerUrl, serverIdentityId);
          if (!seed) throw new Error('Personal Home seed custody is unavailable.');
          return { token: await requestToken(endpoint, seed) };
        },
        persistCredentials: async ({ serverIdentityId, credentials }) => {
          await writeCredentialsTokenOnlyForServerId(serverIdentityId, credentials);
          const readback = await readStoredCredentialsForServerId(serverIdentityId);
          return readback?.token === credentials.token && readback?.encryption === null;
        },
        verifyAuthenticatedAccess: async ({ endpoint, token }) => {
          const response = await fetch(`${endpoint.replace(/\/+$/u, '')}/v1/auth/ping`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
          return response?.status === 200;
        },
        probeAnonymousSignupRefused: async ({ endpoint }) => {
          try {
            await requestToken(endpoint, getRandomBytes(32));
            return false;
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'signup-disabled') return true;
            throw error;
          }
        },
        clearPendingBootstrapSeed: async ({ serverUrl, serverIdentityId }) => {
          await Promise.all([
            removeProtectedLocalStateFile(custodyPath(serverUrl), { authority: 'owned' }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            }),
            removeProtectedLocalStateFile(custodyPath(serverUrl, serverIdentityId), { authority: 'owned' }).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
            }),
          ]);
          return (await readSeed(serverUrl)) === null && (await readSeed(serverUrl, serverIdentityId)) === null;
        },
        preflightCompletedProfile: () => undefined,
        adoptCompletedProfile: async ({ connectionDescriptor, serverIdentityId }) => {
          const descriptor = connectionDescriptor ?? completedDescriptor;
          if (!descriptor) throw new Error('Personal Home descriptor is unavailable.');
          const adopted = await adoptServerProfileHomeConnectionDescriptor({
            descriptor,
            suggestedName: serverIdentityId,
            observation: 'exact',
            use: false,
          });
          if (adopted.profile.id !== serverIdentityId) {
            const provisionalCredentials = await readStoredCredentialsForServerId(serverIdentityId);
            const credentials = provisionalCredentials ?? await readStoredCredentialsForServerId(adopted.profile.id);
            if (!credentials?.token || credentials.encryption !== null) throw new Error('Verified Personal Home credentials are unavailable.');
            if (provisionalCredentials) {
              await writeCredentialsTokenOnlyForServerId(adopted.profile.id, { token: credentials.token });
              const copied = await readStoredCredentialsForServerId(adopted.profile.id);
              if (copied?.token !== credentials.token || copied.encryption !== null) {
                throw new Error('Personal Home profile credential move could not be verified.');
              }
              await removeStoredCredentialsForServerId(serverIdentityId);
            }
          }
          return { id: adopted.profile.id };
        },
      },
      allowErasedRuntimeRecreate: options.allowErasedRuntimeRecreate === true,
    });
    if (!completedDescriptor) {
      throw new Error('Personal Home bootstrap completed without a verified Home connection descriptor.');
    }
    return {
      profileId: result.profileId,
      homeServerIdentityId: observedServerIdentityId,
      canonicalServerUrl: result.receipt.canonicalServerUrl,
      accountCreated: result.accountCreated,
      descriptor: completedDescriptor,
    };
  } finally {
    await prepared.cleanup();
  }
}

export async function reconcileCreatedPersonalHome(
  profileId: string,
  deps: Readonly<{
    useProfile?: typeof useServerProfile;
    reload?: typeof reloadConfiguration;
    runSetup?: typeof handleSetupCommand;
    quiet?: boolean;
    signal?: AbortSignal;
    replaceServices?: boolean;
    switchChannel?: boolean;
  }> = {},
): Promise<void> {
  await (deps.useProfile ?? useServerProfile)(profileId);
  (deps.reload ?? reloadConfiguration)();
  await (deps.runSetup ?? handleSetupCommand)(
    [
      '--server', profileId, '--skip-providers', '--yes',
      ...(deps.replaceServices === true ? ['--replace-services'] : []),
      ...(deps.switchChannel === true ? ['--switch-channel'] : []),
    ],
    {
      quiet: deps.quiet === true,
      invocation: 'authenticated-home-create-continuation',
    },
    deps.signal,
  );
}
