import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { StoredCredentials } from '@/persistence';
import type { PluginManagedResourcePreflightBinding } from '@/plugins/availability/serverPublisher';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { readOrCreateInstallationIdentity } from '../identity/store';

/** Bind removal and nested Action custody before the plugin runtime starts. */
export async function prepareDaemonPluginRemoval(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  origin: CurrentMachineExecutionOriginContext | null;
  readServerUrl: () => string;
  signal: AbortSignal;
  installationIdentityFile?: string;
}>): Promise<Readonly<{
  installation: MachineInstallationIdentityV1;
  managedResourcePreflight: PluginManagedResourcePreflightBinding | undefined;
}>> {
  const installation = await readOrCreateInstallationIdentity(params.installationIdentityFile);
  const managedResourcePreflight: PluginManagedResourcePreflightBinding | undefined =
    params.origin?.machineId === params.machineId
      ? { credentials: params.credentials, get serverUrl() { return params.readServerUrl(); },
          homeId: params.origin.serverIdentityId,
          controller: { machineId: params.machineId, installationId: installation.installationId },
          signal: params.signal }
      : undefined;
  return { installation, managedResourcePreflight };
}
