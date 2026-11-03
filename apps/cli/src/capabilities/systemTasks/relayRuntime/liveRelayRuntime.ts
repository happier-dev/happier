
import {
  createRelayHostEngine,
  ensureLocalFirstPartyComponentCommand,
  type RelayHostEngine,
  type RelayHostEngineDeps,
  type RelayRuntimeStatusSnapshot,
  type RelayRuntimeTaskParams,
  type PersonalHomeSystemTaskOperations,
} from '@happier-dev/cli-common/systemTasks';
import {
  listInstalledVersionIdsNewestFirst,
  type RelayRuntimeHealthResult,
  type PersonalHomeRelocationDestinationOwner,
  type PersonalHomeOperations,
} from '@happier-dev/cli-common/firstPartyRuntime';
import {
  checkLocalRelayRuntimeReachability,
  createLocalPersonalHomeHost,
  probeLocalRelayRuntimeHealth,
} from '@happier-dev/cli-common/relayHost';
import { normalizePublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import { configuration } from '@/configuration';

type LiveRelayRuntimeServiceStatus = RelayRuntimeStatusSnapshot['service'];

function requireLocalRelayRuntimeParams(params: RelayRuntimeTaskParams): RelayRuntimeTaskParams {
  if (params.target.kind !== 'local') {
    throw new Error('Live relay runtime tasks only support local targets');
  }
  return { ...params, target: { kind: 'local' as const } };
}

// Local-only engine wiring: live relay runtime tasks never target remote hosts,
// so the remote dependency seams fail closed instead of opening a second remote
// installation path. All platform/process behavior stays in the canonical
// engine.
export function createLocalRelayHostEngine(extraDeps: Partial<Pick<RelayHostEngineDeps, 'resolveLocalInstallVersion'>> = {}): RelayHostEngine {
  return createRelayHostEngine({
    localInstallPolicy: { organizationPolicy: configuration.organizationPolicy },
    installRemoteComponent: async () => {
      throw new Error('Remote component installation is not available for live relay runtime tasks.');
    },
    resolveRemoteReleaseTarget: async () => {
      throw new Error('Remote relay targets are not available for live relay runtime tasks.');
    },
    runRemoteText: async () => {
      throw new Error('Remote relay execution is not available for live relay runtime tasks.');
    },
    copyLocalDirectoryToRemote: async () => {
      throw new Error('Remote relay copy is not available for live relay runtime tasks.');
    },
    ...(extraDeps.resolveLocalInstallVersion ? { resolveLocalInstallVersion: extraDeps.resolveLocalInstallVersion } : {}),
  });
}

/**
 * Local Personal Home host adapter. This capability owns only the local-only
 * relay engine; the shared cli-common composition owns every Personal Home
 * dependency and policy so the CLI and hsetup hosts cannot drift.
 */
function createLiveLocalPersonalHomeHost(params: Readonly<{
  channel?: 'stable' | 'preview' | 'dev';
  mode?: 'user' | 'system';
}>) {
  return createLocalPersonalHomeHost({
    engine: createLocalRelayHostEngine(),
    channel: params.channel ?? 'stable',
    mode: params.mode ?? 'user',
  });
}

export async function createLivePersonalHomeSystemTaskOperations(params: Readonly<{
  channel?: 'stable' | 'preview' | 'dev';
  mode?: 'user' | 'system';
}> = {}): Promise<PersonalHomeSystemTaskOperations> {
  return await createLiveLocalPersonalHomeHost(params).createSystemTaskOperations();
}

export async function createLivePersonalHomeOperations(params: Readonly<{
  channel?: 'stable' | 'preview' | 'dev';
  mode?: 'user' | 'system';
}> = {}): Promise<PersonalHomeOperations> {
  return await createLiveLocalPersonalHomeHost(params).createOperations();
}

export async function createLivePersonalHomeRelocationDestinationOwner(params: Readonly<{
  channel: 'stable' | 'preview' | 'dev';
  mode: 'user' | 'system';
}>): Promise<PersonalHomeRelocationDestinationOwner> {
  return await createLiveLocalPersonalHomeHost(params).createRelocationDestinationOwner();
}

export async function readRelayRuntimeStatus(params: RelayRuntimeTaskParams): Promise<RelayRuntimeStatusSnapshot> {
  return await createLocalRelayHostEngine().readStatus(requireLocalRelayRuntimeParams(params));
}

export async function readLiveRelayRuntimeInstalledVersion(params: RelayRuntimeTaskParams): Promise<string | null> {
  return (await readRelayRuntimeStatus(params)).version;
}

export async function readLiveRelayRuntimeServiceStatus(params: RelayRuntimeTaskParams): Promise<LiveRelayRuntimeServiceStatus> {
  return (await readRelayRuntimeStatus(params)).service;
}

export async function readLiveRelayRuntimeHealth(params: RelayRuntimeTaskParams): Promise<RelayRuntimeHealthResult> {
  const status = await readRelayRuntimeStatus(params);
  return await probeLocalRelayRuntimeHealth({ baseUrl: status.baseUrl });
}

export async function checkLiveRelayRuntimeHealth(params: Readonly<{ baseUrl: string }>): Promise<boolean> {
  return await checkLocalRelayRuntimeReachability(params);
}

export async function startRelayRuntime(params: RelayRuntimeTaskParams): Promise<void> {
  await createLocalRelayHostEngine().control({ ...requireLocalRelayRuntimeParams(params), action: 'start' });
}

export async function restartRelayRuntime(params: RelayRuntimeTaskParams): Promise<void> {
  await createLocalRelayHostEngine().control({ ...requireLocalRelayRuntimeParams(params), action: 'restart' });
}

export async function stopRelayRuntime(params: RelayRuntimeTaskParams): Promise<void> {
  await createLocalRelayHostEngine().control({ ...requireLocalRelayRuntimeParams(params), action: 'stop' });
}

export async function uninstallRelayRuntime(params: RelayRuntimeTaskParams): Promise<void> {
  await createLocalRelayHostEngine().control({ ...requireLocalRelayRuntimeParams(params), action: 'uninstall' });
}

export async function installOrUpdateRelayRuntime(params: RelayRuntimeTaskParams): Promise<Readonly<{ relayUrl: string; mode: 'user' | 'system' }>> {
  const localParams = requireLocalRelayRuntimeParams(params);
  const releaseRing = normalizePublicReleaseRingId(localParams.channel) || 'stable';
  const engine = createLocalRelayHostEngine({
    resolveLocalInstallVersion: async () => {
      if (localParams.selfHostRelayBinaryOverride) {
        return null;
      }
      return (await listInstalledVersionIdsNewestFirst({
        componentId: 'happier-server',
        processEnv: process.env,
        releaseRing,
      })).at(0) ?? null;
    },
  });
  const selfHostRelayBinaryOverride = localParams.selfHostRelayBinaryOverride
    ? localParams.selfHostRelayBinaryOverride
    : await ensureLocalFirstPartyComponentCommand({
        componentId: 'happier-server',
        processEnv: process.env,
        envVarNames: ['HAPPIER_SELF_HOST_SERVER_BINARY'],
        releaseRing,
      });

  return await engine.installOrUpdate({ ...localParams, selfHostRelayBinaryOverride });
}

export const readLiveRelayRuntimeStatus = readRelayRuntimeStatus;
export const startLiveRelayRuntime = startRelayRuntime;
export const restartLiveRelayRuntime = restartRelayRuntime;
export const stopLiveRelayRuntime = stopRelayRuntime;
export const uninstallLiveRelayRuntime = uninstallRelayRuntime;
export const installOrUpdateLiveRelayRuntime = installOrUpdateRelayRuntime;
