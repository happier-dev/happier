import { ApiClient } from '@/api/api';
import type { MachineMetadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';

const DEFAULT_MISSING_MACHINE_ID_MESSAGE =
  '[START] No machine ID found in settings. Please report this issue on https://github.com/happier-dev/happier/issues';

export async function initializeBackendApiContext(opts: {
  credentials: Credentials;
  machineMetadata: MachineMetadata;
  missingMachineIdMessage?: string;
}): Promise<{
  api: ApiClient;
  machineId: string;
}> {
  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(opts.missingMachineIdMessage ?? DEFAULT_MISSING_MACHINE_ID_MESSAGE);
    process.exit(1);
  }
  await api.getOrCreateMachine({ machineId, metadata: opts.machineMetadata });
  return { api, machineId };
}
