import { isPidPresent } from '@happier-dev/cli-common/process';
import { ApiClient } from '@/api/api';
import type { MachineMetadata } from '@/api/types';
import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import type { StoredCredentials } from '@/persistence';
import { readDaemonState } from '@/persistence';
import { readRequiredStartupMachineId } from '@/agent/runtime/startup/readRequiredStartupMachineId';

const silentRecoveryLogger = {
  info: () => undefined,
} as const;

async function shouldSkipMachineRegistration(explicitSkip: boolean | undefined): Promise<boolean> {
  if (explicitSkip) return true;

  const daemonState = await readDaemonState();
  if (!daemonState?.pid) return false;

  return isPidPresent(daemonState.pid);
}

export async function initializeBackendApiContext(opts: {
  credentials: StoredCredentials;
  machineMetadata: MachineMetadata;
  missingMachineIdMessage?: string;
  skipMachineRegistration?: boolean;
  suppressMachineRegistrationRecoveryLogs?: boolean;
}): Promise<{
  api: ApiClient;
  machineId: string;
}> {
  const api = await ApiClient.create(opts.credentials);
  const machineId = await readRequiredStartupMachineId(opts.missingMachineIdMessage);
  if (await shouldSkipMachineRegistration(opts.skipMachineRegistration)) {
    api.setLocalMachineId(machineId);
    return { api, machineId };
  }
  const { machineId: registeredMachineId } = await ensureMachineRegistered({
    api,
    machineId,
    metadata: opts.machineMetadata,
    caller: 'initializeBackendApiContext',
    ...(opts.suppressMachineRegistrationRecoveryLogs ? { recoveryLogger: silentRecoveryLogger } : {}),
  });
  api.setLocalMachineId(registeredMachineId);
  return { api, machineId: registeredMachineId };
}
