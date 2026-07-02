import { compareMachineHosts } from '../machineHost/normalizeMachineHost.js';
import {
  compareMachineHomeDirs,
  type MachineHomeDirPlatform,
} from './normalizeMachineHomeDir.js';

export type MachineLocalityInput = Readonly<{
  sessionHost?: string | null;
  sessionHomeDir?: string | null;
  currentHost?: string | null;
  currentHomeDir?: string | null;
  homeDir?: string | null;
  platform?: MachineHomeDirPlatform;
}>;

export type MachineLocalityResult = Readonly<{
  sameHost: boolean;
  sameHomeDir: boolean;
  local: boolean;
}>;

export function resolveMachineLocality(input: MachineLocalityInput): MachineLocalityResult {
  const sameHost = compareMachineHosts(input.sessionHost, input.currentHost);
  const sameHomeDir = compareMachineHomeDirs(input.sessionHomeDir, input.currentHomeDir, {
    homeDir: input.homeDir,
    platform: input.platform,
  });

  return {
    sameHost,
    sameHomeDir,
    local: sameHost && sameHomeDir,
  };
}

export function isSameMachineLocality(input: MachineLocalityInput): boolean {
  return resolveMachineLocality(input).local;
}
