import type {
  AccountSettings,
  ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';
import {
  readConnectedServiceMaterializationIdentityV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
  resolveConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { ApiClient } from '@/api/api';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { requireCatalogEntry } from '@/agent/catalog/registry';
import { configuration } from '@/configuration';
import { resolveConnectedServiceCandidatePersistedSessionFile } from '@/daemon/connectedServices/catalogHooks';
import { resolveConnectedServicesMaterializationBaseDir } from '@/daemon/connectedServices/materialize/resolveConnectedServicesMaterializationBaseDir';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { shouldResolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/shouldResolveConnectedServiceAuthForSpawn';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

export type DirectConnectedServiceEnvironment = Readonly<{
  environment: Readonly<Record<string, string>>;
  unsetEnvKeys: readonly string[];
  cleanupOnFailure: (() => void) | null;
  cleanupOnExit: (() => void) | null;
}>;

/**
 * The direct-CLI adapter over Dev's canonical Connected Services spawn owner.
 * New launches and resumes differ only in the optional continuity facts below.
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
  const connectedServicesUpdatedAt = typeof sessionMetadata?.connectedServicesUpdatedAt === 'number'
    && Number.isFinite(sessionMetadata.connectedServicesUpdatedAt)
    ? sessionMetadata.connectedServicesUpdatedAt
    : undefined;
  const materializationIdentity =
    readConnectedServiceMaterializationIdentityV1FromMetadata(sessionMetadata) ?? undefined;
  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(sessionMetadata) ?? undefined;
  const spawnOptions: SpawnSessionOptions = {
    directory: params.directory,
    backendTarget: { kind: 'backend', backendId: params.agentId, sourceKind: 'built_in' },
    ...(params.vendorResumeId
      ? { existingSessionId: params.sessionId, resume: params.vendorResumeId }
      : {}),
    connectedServices: params.connectedServices,
    ...(connectedServicesUpdatedAt !== undefined ? { connectedServicesUpdatedAt } : {}),
    ...(materializationIdentity ? { connectedServiceMaterializationIdentityV1: materializationIdentity } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  };

  const shouldResolveAuth = shouldResolveConnectedServiceAuthForSpawn(spawnOptions);
  const connectedServiceAuth = shouldResolveAuth
    ? await (async () => {
        const api = await ApiClient.create(params.credentials);
        const sharedStateContinuityRequested = Boolean(params.vendorResumeId) && (
          resolveConnectedServicesProviderStateSharingPolicyV1(
            (params.accountSettings as Readonly<Record<string, unknown>>)
              .connectedServicesProviderStateSharingSettingsV1,
            params.agentId,
          ).stateMode === 'shared'
        );
        return await resolveConnectedServiceAuthForSpawn({
          agentId: params.agentId,
          connectedServicesBindingsRaw: params.connectedServices,
          materializationKey: materializationIdentity?.id || params.sessionId,
          activeServerDir: configuration.activeServerDir,
          baseDir: resolveConnectedServicesMaterializationBaseDir(configuration.happyHomeDir),
          sessionDirectory: params.directory,
          credentials: params.credentials,
          api,
          sessionId: params.sessionId,
          accountSettings: params.accountSettings,
          processEnv: process.env,
          ...(params.vendorResumeId ? { vendorResumeId: params.vendorResumeId } : {}),
          resumeReachabilityRequired: sharedStateContinuityRequested,
          candidatePersistedSessionFile: resolveConnectedServiceCandidatePersistedSessionFile(
            params.agentId,
            sessionMetadata,
          ),
        });
      })()
    : null;

  const entry = requireCatalogEntry(params.agentId);
  const daemonSpawnHooks = entry.getDaemonSpawnHooks ? await entry.getDaemonSpawnHooks() : null;
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

  if (!childEnvironment.ok) {
    childEnvironment.cleanupOnFailure?.();
    throw new Error(childEnvironment.errorMessage);
  }
  return {
    environment: childEnvironment.extraEnvForChild,
    unsetEnvKeys: childEnvironment.unsetEnvKeys ?? [],
    cleanupOnFailure: childEnvironment.cleanupOnFailure,
    cleanupOnExit: childEnvironment.cleanupOnExit,
  };
}
