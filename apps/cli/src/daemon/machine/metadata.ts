import os from 'os';

import { readLocalHostIdentity, readPreferredHostName } from '@happier-dev/cli-common/process';

import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { MachineMetadata } from '@/api/types';
import { deriveManagedDevcontainerChildProjectionV1, isManagedDevcontainerChildProjectionCurrentV1,
  managedDevcontainerChildProjectionsEqualV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';
import type { StoredCredentials } from '@/persistence';
import packageJson from '../../../package.json';

export async function getPreferredHostName(): Promise<string> {
  return await readPreferredHostName();
}

/** A retained home may reuse its installation, but never its old native observation. */
export async function readCurrentManagedChildMachineMetadata(input: Readonly<{
  current: Partial<MachineMetadata>; credentials: StoredCredentials;
  homeId: string; machineId: string; serverHttpBaseUrl: string;
}>): Promise<MachineMetadata['devcontainerChild'] | null> {
  const prior = input.current.devcontainerChild;
  if (!prior) return undefined;
  const managedMachine = await readManagedMachine({ credentials: input.credentials,
    serverHttpBaseUrl: input.serverHttpBaseUrl, homeId: input.homeId, managedId: prior.relation.managedMachineId });
  const projection = deriveManagedDevcontainerChildProjectionV1({ managedMachineId: managedMachine.id,
    controllerMachineId: managedMachine.controller.machineId, enrolledMachineId: managedMachine.enrolledMachineId,
    resource: managedMachine.resource });
  return managedMachine.id === prior.relation.managedMachineId
    && isManagedDevcontainerChildProjectionCurrentV1({ homeId: input.homeId, machineId: input.machineId, projection, managedMachine })
    ? projection : null;
}

type CurrentDaemonMachineMetadataFields = Pick<
  MachineMetadata,
  'host' | 'platform' | 'happyCliVersion' | 'homeDir' | 'happyHomeDir' | 'happyLibDir'
> & Partial<Pick<MachineMetadata, 'cliUpdate'>> & Readonly<{
  /** Undefined preserves the last admitted fact; null removes a retired fact. */
  devcontainerChild?: MachineMetadata['devcontainerChild'] | null;
}>;

/**
 * The daemon-owned metadata fields, refreshed without touching user-owned ones (e.g.
 * `displayName`). `cliUpdate` is the daemon's K5 CLI update facts (plan R13): absent from a caller
 * that does not produce them, which leaves the stored facts as they were.
 */

export function refreshMachineMetadataForCurrentDaemon(
  current: Partial<MachineMetadata>,
  fields: CurrentDaemonMachineMetadataFields,
): MachineMetadata {
  const { cliUpdate, devcontainerChild, ...ownedFields } = fields;
  const next: MachineMetadata = {
    ...current,
    ...ownedFields,
    ...(cliUpdate ? { cliUpdate } : {}),
    ...(devcontainerChild ? { devcontainerChild } : {}),
    daemonTerminalSessionAttachSupported: true,
    daemonSessionGoalControlsSupported: true,
  };
  if (devcontainerChild === null) delete next.devcontainerChild;
  if (
    current.host === next.host
    && current.platform === next.platform
    && current.happyCliVersion === next.happyCliVersion
    && current.homeDir === next.homeDir
    && current.happyHomeDir === next.happyHomeDir
    && current.happyLibDir === next.happyLibDir
    && current.daemonTerminalSessionAttachSupported === next.daemonTerminalSessionAttachSupported
    && current.daemonSessionGoalControlsSupported === next.daemonSessionGoalControlsSupported
    && JSON.stringify(current.cliUpdate ?? null) === JSON.stringify(next.cliUpdate ?? null)
    && managedDevcontainerChildProjectionsEqualV1(current.devcontainerChild, next.devcontainerChild)
  ) {
    return current as MachineMetadata;
  }
  return next;
}

const initialDaemonMetadata = refreshMachineMetadataForCurrentDaemon({}, {
  host: '',
  platform: readLocalHostIdentity().platform,
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
});

export const initialMachineMetadata: MachineMetadata = {
  ...initialDaemonMetadata,
  get host() {
    return readLocalHostIdentity().machineName;
  },
};
