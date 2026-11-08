import { statfs } from 'node:fs/promises';
import { freemem } from 'node:os';
import { isAbsolute } from 'node:path';
import * as z from 'zod/mini';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

// Lume 0.6.1 FileSystem/Settings.swift, 3350f504014c85416009a90fcb339fe556ce02fc.
// Only native IO consumes storage paths; the public facts never contain them.
const storageSettings = z.object({
  defaultLocationName: z.string(),
  vmLocations: z.array(z.object({ name: z.string(), path: z.string() })),
});

export async function readLumeHostResources(observedAt: number, configuration: unknown): Promise<NonNullable<MachineProvisionerCheckResultV1['localResources']>> {
  let availableMemoryBytes: number | undefined;
  let availableDiskBytes: number | undefined;
  try { availableMemoryBytes = freemem(); } catch { /* An unavailable OS measurement stays omitted. */ }
  const settings = storageSettings.safeParse(configuration);
  // Check has no selected storage operand. With several native locations, no
  // single volume describes the later selection, so do not advertise its space.
  const location = settings.success && settings.data.vmLocations.length === 1
    ? settings.data.vmLocations.find(item => item.name === settings.data.defaultLocationName) : undefined;
  if (location && isAbsolute(location.path)) {
    try {
      const volume = await statfs(location.path);
      availableDiskBytes = volume.bavail * volume.bsize;
    } catch { /* Missing/unmounted native storage does not make Lume unavailable. */ }
  }
  // CPU topology/availableParallelism and VM allocations do not observe idle
  // CPU headroom. Lume's native API has no such measurement; leave it unknown.
  return { observedAt,
    ...(availableMemoryBytes === undefined ? {} : { availableMemoryBytes }),
    ...(availableDiskBytes === undefined ? {} : { availableDiskBytes }),
  };
}
