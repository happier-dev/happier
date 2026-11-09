import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import type { MachineMetadata } from '@/api/types';
import type { CliUpdateFacts } from '@happier-dev/protocol';
import packageJson from '../../../package.json';

const execFileAsync = promisify(execFile);

export async function getPreferredHostName(): Promise<string> {
  const fallback = os.hostname();
  if (process.platform !== 'darwin') {
    return fallback;
  }

  const tryScutil = async (key: 'HostName' | 'LocalHostName' | 'ComputerName'): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('scutil', ['--get', key], { timeout: 400 });
      const value = typeof stdout === 'string' ? stdout.trim() : '';
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

/**
 * The daemon-owned metadata fields, refreshed on the daemon's first connect after start without
 * touching user-owned ones (e.g. `displayName`). `cliUpdate` is the daemon's K5 CLI update facts
 * (plan R13): read once here, so a machine that restarted onto a new version (or was rolled back)
 * reports it — and the last update outcome — on its next connect. Callers that are not the daemon
 * leave it as it was.
 */
export function refreshMachineMetadataForCurrentDaemon(
  current: Partial<MachineMetadata>,
  host: string,
  cliUpdate?: CliUpdateFacts,
): MachineMetadata {
  const next: MachineMetadata = {
    ...current,
    host,
    platform: os.platform(),
    happyCliVersion: packageJson.version,
    homeDir: os.homedir(),
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: projectPath(),
    daemonTerminalSessionAttachSupported: true,
    daemonSessionGoalControlsSupported: true,
    daemonSessionRoleV1SpawnSupported: true,
    ...(cliUpdate ? { cliUpdate } : {}),
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
    && current.daemonSessionRoleV1SpawnSupported === next.daemonSessionRoleV1SpawnSupported
    && JSON.stringify(current.cliUpdate ?? null) === JSON.stringify(next.cliUpdate ?? null)
  ) {
    return current as MachineMetadata;
  }
  return next;
}

export const initialMachineMetadata: MachineMetadata = refreshMachineMetadataForCurrentDaemon(
  {},
  os.hostname(),
);
