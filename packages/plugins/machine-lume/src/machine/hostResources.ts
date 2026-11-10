import { statfs } from 'node:fs/promises';
import { cpus, freemem, homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import * as z from 'zod/mini';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { isLumeMacos, type readLumeCapacity } from './capacity.js';
import { expandHomePath } from '@happier-dev/plugin-sdk/fs';

// Lume 0.6.1 FileSystem/Settings.swift, 3350f504014c85416009a90fcb339fe556ce02fc.
// Only native IO consumes storage paths; the public facts never contain them.
const storageSettings = z.object({
  defaultLocationName: z.string(),
  vmLocations: z.array(z.object({ name: z.string(), path: z.string() })),
});

export async function readLumeHostResources(observedAt: number, configuration: unknown, vms?: NonNullable<ReturnType<typeof readLumeCapacity>>['vms']): Promise<NonNullable<MachineProvisionerCheckResultV1['localResources']>> {
  let totalCpuCores: number | undefined;
  try { totalCpuCores = cpus().length; } catch { /* An unavailable host topology stays omitted. */ }
  const runningMacos = vms?.filter(vm => isLumeMacos(vm.os) && vm.status === 'running');
  const allocatedCpuCores = runningMacos?.every(vm => vm.cpuCount !== undefined)
    ? runningMacos.reduce((sum, vm) => sum + vm.cpuCount!, 0) : undefined;
  let availableMemoryBytes: number | undefined;
  let availableDiskBytes: number | undefined;
  try { availableMemoryBytes = freemem(); } catch { /* An unavailable OS measurement stays omitted. */ }
  const settings = storageSettings.safeParse(configuration);
  // Check has no selected storage operand. With several native locations, no
  // single volume describes the later selection, so do not advertise its space.
  const location = settings.success && settings.data.vmLocations.length === 1
    ? settings.data.vmLocations.find(item => item.name === settings.data.defaultLocationName) : undefined;
  if (location) {
    try {
      const storagePath = expandHomePath(location.path, homedir());
      if (isAbsolute(storagePath)) {
        const volume = await statfs(storagePath);
        availableDiskBytes = volume.bavail * volume.bsize;
      }
    } catch { /* Missing/unmounted native storage does not make Lume unavailable. */ }
  }
  // Allocations are not idle CPU headroom (owner ruling 2026-11-10).
  return { observedAt,
    ...(totalCpuCores === undefined ? {} : { totalCpuCores }),
    ...(allocatedCpuCores === undefined ? {} : { allocatedCpuCores }),
    ...(availableMemoryBytes === undefined ? {} : { availableMemoryBytes }),
    ...(availableDiskBytes === undefined ? {} : { availableDiskBytes }),
  };
}
