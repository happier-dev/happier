import os from 'os';

import { execFileWithDeadline } from '@happier-dev/cli-common/process';

import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { MachineMetadata } from '@/api/types';
import packageJson from '../../../package.json';

export async function getPreferredHostName(): Promise<string> {
  const fallback = os.hostname();
  if (process.platform !== 'darwin') {
    return fallback;
  }

  const tryScutil = async (key: 'HostName' | 'LocalHostName' | 'ComputerName'): Promise<string | null> => {
    try {
      // 400 ms is a very small budget on a loop that stalls for seconds; with a `child_process`
      // `timeout` that turns a completed `scutil` into an empty success, which reads exactly like
      // "this key is not set" and silently demotes the machine to its `os.hostname()` fallback.
      const { stdout } = await execFileWithDeadline('scutil', ['--get', key], { timeout: 400 });
      const value = String(stdout).trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  };

  // Prefer HostName (can be FQDN) → LocalHostName → ComputerName → os.hostname()
  return (await tryScutil('HostName'))
    ?? (await tryScutil('LocalHostName'))
    ?? (await tryScutil('ComputerName'))
    ?? fallback;
}

type CurrentDaemonMachineMetadataFields = Pick<
  MachineMetadata,
  'host' | 'platform' | 'happyCliVersion' | 'homeDir' | 'happyHomeDir' | 'happyLibDir'
>;

export function refreshMachineMetadataForCurrentDaemon(
  current: Partial<MachineMetadata>,
  fields: CurrentDaemonMachineMetadataFields,
): MachineMetadata {
  const next: MachineMetadata = {
    ...current,
    ...fields,
    daemonTerminalSessionAttachSupported: true,
    daemonSessionGoalControlsSupported: true,
  };
  if (
    current.host === next.host
    && current.platform === next.platform
    && current.happyCliVersion === next.happyCliVersion
    && current.homeDir === next.homeDir
    && current.happyHomeDir === next.happyHomeDir
    && current.happyLibDir === next.happyLibDir
    && current.daemonTerminalSessionAttachSupported === next.daemonTerminalSessionAttachSupported
    && current.daemonSessionGoalControlsSupported === next.daemonSessionGoalControlsSupported
  ) {
    return current as MachineMetadata;
  }
  return next;
}

export const initialMachineMetadata: MachineMetadata = refreshMachineMetadataForCurrentDaemon({}, {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
});
