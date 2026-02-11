import { ApiClient } from '@/api/api';
import type { MachineMetadata } from '@/api/types';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { Credentials } from '@/persistence';
import { readDaemonState, readSettings } from '@/persistence';

const DEFAULT_MISSING_MACHINE_ID_MESSAGE =
  '[START] No machine ID found in settings. Please report this issue on https://github.com/happier-dev/happier/issues';

async function shouldSkipMachineRegistration(explicitSkip: boolean | undefined): Promise<boolean> {
  if (explicitSkip) return true;

  const daemonState = await readDaemonState();
  if (!daemonState?.pid) return false;

  try {
    process.kill(daemonState.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function initializeBackendApiContext(opts: {
  credentials: Credentials;
  machineMetadata: MachineMetadata;
  missingMachineIdMessage?: string;
  skipMachineRegistration?: boolean;
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
  if (await shouldSkipMachineRegistration(opts.skipMachineRegistration)) {
    return { api, machineId };
  }
  const { machineId: registeredMachineId } = await ensureMachineRegistered({
    api,
    machineId,
    metadata: opts.machineMetadata,
    caller: 'initializeBackendApiContext',
  });
  return { api, machineId: registeredMachineId };
}
