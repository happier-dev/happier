import { join } from 'node:path';

import type {
  AccountSettings,
  ConnectedServiceBindingsV1,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import {
  readConnectedServiceMaterializationIdentityV1FromMetadata,
  resolveConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { ApiClient } from '@/api/api';
import {
  AGENTS,
  getConnectedServiceStateSharingDescriptor,
  resolveConnectedServiceCandidatePersistedSessionFile,
} from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import { configuration } from '@/configuration';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { createConnectedServiceMaterializationIdentity } from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';
import { shouldResolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import { resolveEffectiveProviderStateMode } from '@/daemon/connectedServices/stateSharing/resolveEffectiveProviderStateMode';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveProviderSpawnExtrasForRuntime } from '@/settings/providerSettings';

export type DirectConnectedServiceEnvironment = Readonly<{
  env: Readonly<Record<string, string>>;
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
}>;

export function resolveDirectConnectedServiceMaterializationIdentity(
  sessionMetadata: Readonly<Record<string, unknown>> | null,
): ConnectedServiceMaterializationIdentityV1 {
  return readConnectedServiceMaterializationIdentityV1FromMetadata(sessionMetadata)
    ?? createConnectedServiceMaterializationIdentity();
}

/**
 * Remote's narrow direct-launch adapter over the canonical daemon spawn-auth
 * and child-environment owners. It intentionally does not duplicate selection,
 * refresh, materialization, or provider policy.
 */
export async function resolveDirectConnectedServiceEnvironment(params: Readonly<{
  agentId: CatalogAgentId;
  credentials: Credentials;
  accountSettings: AccountSettings;
  directory: string;
  sessionId: string;
  connectedServices: ConnectedServiceBindingsV1;
  vendorResumeId?: string;
  sessionMetadata?: Record<string, unknown> | null;
}>): Promise<DirectConnectedServiceEnvironment | null> {
  const sessionMetadata = params.sessionMetadata ?? null;
  const materializationIdentity =
    resolveDirectConnectedServiceMaterializationIdentity(sessionMetadata);
  const connectedServicesUpdatedAt =
    typeof sessionMetadata?.connectedServicesUpdatedAt === 'number'
      && Number.isFinite(sessionMetadata.connectedServicesUpdatedAt)
      ? sessionMetadata.connectedServicesUpdatedAt
      : undefined;
  const providerSpawnExtras = resolveProviderSpawnExtrasForRuntime({
    agentId: params.agentId,
    settings: params.accountSettings as Readonly<Record<string, unknown>>,
    processEnv: process.env,
  });
  const codexBackendMode = providerSpawnExtras.codexBackendMode;
  const experimentalCodexAcp = providerSpawnExtras.experimentalCodexAcp;
  const spawnOptions: SpawnSessionOptions = {
    directory: params.directory,
    backendTarget: { kind: 'builtInAgent', agentId: params.agentId },
    ...(params.vendorResumeId
      ? { existingSessionId: params.sessionId, resume: params.vendorResumeId }
      : {}),
    connectedServices: params.connectedServices,
    ...(connectedServicesUpdatedAt !== undefined ? { connectedServicesUpdatedAt } : {}),
    connectedServiceMaterializationIdentityV1: materializationIdentity,
    ...(codexBackendMode === 'mcp' || codexBackendMode === 'acp' || codexBackendMode === 'appServer'
      ? { codexBackendMode }
      : {}),
    ...(typeof experimentalCodexAcp === 'boolean' ? { experimentalCodexAcp } : {}),
  };
  const shouldResolveAuth = shouldResolveConnectedServiceAuthForSpawn(spawnOptions);
  const connectedServiceAuth = shouldResolveAuth
    ? await (async () => {
        const api = await ApiClient.create(params.credentials);
        const requestedStateMode = resolveConnectedServicesProviderStateSharingPolicyV1(
          (params.accountSettings as Readonly<Record<string, unknown>>)
            .connectedServicesProviderStateSharingSettingsV1,
          params.agentId,
        ).stateMode;
        const resumeReachabilityRequired = Boolean(params.vendorResumeId) && (
          resolveEffectiveProviderStateMode({
            requestedStateMode,
            descriptor: await getConnectedServiceStateSharingDescriptor(params.agentId),
          }) === 'shared'
        );
        return await resolveConnectedServiceAuthForSpawn({
          agentId: params.agentId,
          sessionDirectory: params.directory,
          connectedServicesBindingsRaw: params.connectedServices,
          materializationKey: materializationIdentity.id,
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          activeServerDir: configuration.activeServerDir,
          baseDir: join(configuration.happyHomeDir, 'daemon', 'connected-services', 'materialized'),
          credentials: params.credentials,
          api,
          sessionId: params.sessionId,
          accountSettings: params.accountSettings,
          processEnv: process.env,
          ...(params.vendorResumeId ? { vendorResumeId: params.vendorResumeId } : {}),
          resumeReachabilityRequired,
          candidatePersistedSessionFile: resolveConnectedServiceCandidatePersistedSessionFile(
            params.agentId,
            sessionMetadata,
          ),
        });
      })()
    : null;
  let failureCleaned = false;
  try {
    const entry = AGENTS[params.agentId];
    const daemonSpawnHooks = entry?.getDaemonSpawnHooks
      ? await entry.getDaemonSpawnHooks()
      : null;
    const childEnvironment = await resolveSpawnChildEnvironment({
      options: {
        ...spawnOptions,
        connectedServices: connectedServiceAuth?.connectedServicesBindings ?? params.connectedServices,
      },
      profileEnvironmentVariables: {},
      daemonSpawnHooks,
      processEnv: process.env,
      logDebug: () => {},
      logInfo: () => {},
      logWarn: () => {},
      connectedServiceAuth,
    });
    const cleanupOnFailure = childEnvironment.cleanupOnFailure
      ?? connectedServiceAuth?.cleanupMaterializationRoot
      ?? null;
    if (!childEnvironment.ok) {
      cleanupOnFailure?.();
      failureCleaned = true;
      throw new Error(childEnvironment.errorMessage);
    }
    return {
      env: childEnvironment.extraEnvForChild,
      cleanupOnFailure,
      cleanupOnExit: childEnvironment.cleanupOnExit,
    };
  } catch (error) {
    if (!failureCleaned && connectedServiceAuth) {
      const cleanup = connectedServiceAuth.cleanupOnFailure
        ?? connectedServiceAuth.cleanupMaterializationRoot
        ?? null;
      cleanup?.();
    }
    throw error;
  }
}

export function overlayDirectConnectedServiceEnvironment(
  env: Readonly<Record<string, string>>,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
