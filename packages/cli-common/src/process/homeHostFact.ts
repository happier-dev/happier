import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';

import type { HomeHostFact } from '@happier-dev/protocol';

import { execFileWithDeadline } from './execFileWithDeadline.js';
import { windowsSystemToolCommand } from './windows/windowsSystemToolPath.js';
import { parseDarwinBatteryFacts, readLinuxBatteryFacts, readWindowsBatteryPresence } from './batteryFacts.js';

export interface HomeHostSystem {
  readonly platform: NodeJS.Platform;
  readonly machineName: string;
  readText(path: string): Promise<string>;
  listPowerSupplies(): Promise<readonly string[]>;
  runTool(command: string, args: readonly string[]): Promise<string>;
}

const PORTABLE_CHASSIS = new Set([8, 9, 10, 11, 14, 30, 31, 32]);
const STATIONARY_CHASSIS = new Set([3, 4, 5, 6, 7, 13, 15, 16, 17, 23, 24, 28, 35, 36]);

export function readLocalHostIdentity(): Readonly<{ machineName: string; platform: NodeJS.Platform }> {
  return { machineName: os.hostname(), platform: os.platform() };
}

/** The Machine and Home fact share the same human-readable host-name decision. */
export async function resolvePreferredHostName(system: Readonly<{
  platform: NodeJS.Platform;
  fallback: string;
  signal?: AbortSignal;
  runTool(command: string, args: readonly string[]): Promise<string>;
}>): Promise<string> {
  if (system.platform !== 'darwin') return system.fallback;
  for (const key of ['HostName', 'LocalHostName', 'ComputerName']) {
    try {
      const value = (await system.runTool('scutil', ['--get', key])).trim();
      if (value) return value;
    } catch (error) {
      if (system.signal?.aborted) throw error;
      // An unset key is normal.
    }
  }
  return system.fallback;
}

export async function readPreferredHostName(signal?: AbortSignal): Promise<string> {
  const { machineName: fallback, platform } = readLocalHostIdentity();
  return await resolvePreferredHostName({ platform, fallback, signal,
    // Preserve the CLI's existing per-key budget. The Home server instead calls the
    // same naming decision with its shutdown signal as the OS-command lifetime owner.
    runTool: async (command, args) => String((await execFileWithDeadline(command, args, { encoding: 'utf8', signal, timeout: 400 })).stdout),
  });
}

function classifyChassis(codes: readonly number[]): 'portable' | 'stationary' | null {
  const portable = codes.some((code) => PORTABLE_CHASSIS.has(code));
  const stationary = codes.some((code) => STATIONARY_CHASSIS.has(code));
  if (portable === stationary) return null;
  return portable ? 'portable' : 'stationary';
}

async function readLinuxMobility(system: HomeHostSystem): Promise<'portable' | 'stationary' | null> {
  // Container namespaces can expose the physical host's DMI. That chassis is
  // not evidence about the computer identified by this server process.
  for (const marker of ['/.dockerenv', '/run/.containerenv']) {
    try {
      await system.readText(marker);
      return null;
    } catch { /* Marker absent. */ }
  }
  try {
    if (/docker|kubepods|containerd|libpod/u.test(await system.readText('/proc/1/cgroup'))) return null;
  } catch { /* No cgroup evidence. */ }
  try {
    const containerStorage = /\/var\/lib\/(?:containerd|docker)|kubepods|\/containers\/storage/u;
    const mounts = (await system.readText('/proc/1/mountinfo')).split('\n');
    const namespaceUsesContainerStorage = mounts.some((mount) => {
      // The fifth field is the mount point. Mounts inside the container store
      // can belong to child containers while PID 1 runs on the host.
      const mountPoint = mount.split(' ', 5)[4] ?? '';
      return containerStorage.test(mount) && !containerStorage.test(mountPoint);
    });
    if (namespaceUsesContainerStorage) return null;
  } catch { /* No mount-namespace evidence. */ }
  try {
    const chassis = (await system.readText('/sys/class/dmi/id/chassis_type')).trim();
    if (/^\d+$/u.test(chassis)) {
      const classified = classifyChassis([Number(chassis)]);
      if (classified) return classified;
    }
  } catch {
    // A container or restricted host may not expose DMI.
  }
  return (await readLinuxBatteryFacts(system)).present ? 'portable' : null;
}

async function readMacMobility(system: HomeHostSystem): Promise<'portable' | 'stationary' | null> {
    try {
        const model = (await system.runTool('sysctl', ['-n', 'hw.model'])).trim();
        if (!/^(?:Mac|iMac)[A-Za-z0-9,]+$/u.test(model)) return null;
        // The Home fact uses the same successful battery observation for every
        // recognized model, including newer Mac<number> laptops and desktops.
        const batteries = await system.runTool('pmset', ['-g', 'batt']);
        return parseDarwinBatteryFacts(batteries).present ? 'portable' : 'stationary';
    } catch {
        return null;
    }
}

async function readWindowsMobility(system: HomeHostSystem): Promise<'portable' | 'stationary' | null> {
  const powershell = windowsSystemToolCommand('powershell.exe');
  try {
    const raw = await system.runTool(powershell, [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_SystemEnclosure | ForEach-Object { $_.ChassisTypes } | ConvertTo-Json -Compress',
    ]);
    const parsed: unknown = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const codes = values.filter((value): value is number => typeof value === 'number' && Number.isInteger(value));
    const classified = classifyChassis(codes);
    if (classified) return classified;
  } catch {
    // The CIM enclosure is absent or unreadable.
  }
  return await readWindowsBatteryPresence(system) ? 'portable' : null;
}

export async function detectHomeHostFactFromSystem(system: HomeHostSystem): Promise<HomeHostFact> {
  const machineName = system.machineName.trim();
  if (!machineName || /\p{Cc}/u.test(machineName)) return { kind: 'unknown' };
  const platform = system.platform;
  const mobility = platform === 'linux'
    ? await readLinuxMobility(system)
    : platform === 'darwin'
      ? await readMacMobility(system)
      : platform === 'win32'
        ? await readWindowsMobility(system)
        : null;
  if (!mobility || (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32')) {
    return { kind: 'unknown' };
  }
  return { kind: 'known', machineName, platform, mobility };
}

/** The server owns this probe's lifetime with its shutdown signal. */
export async function readHomeHostFact(signal?: AbortSignal): Promise<HomeHostFact> {
  const platform = os.platform();
  const runTool = async (command: string, args: readonly string[]) =>
    String((await execFileWithDeadline(command, args, { encoding: 'utf8', signal })).stdout);
  const machineName = await resolvePreferredHostName({ platform, fallback: os.hostname(), signal, runTool });
  return await detectHomeHostFactFromSystem({
    platform,
    machineName,
    readText: (path) => readFile(path, 'utf8'),
    listPowerSupplies: () => readdir('/sys/class/power_supply'),
    runTool,
  });
}
