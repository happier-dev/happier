import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isServerIdFilesystemSafe, readRegistrationJsonIfPresent, readStoredMachineRegistration,
  resolveMachineRegistrationPath, resolveRegisteredMachineId,
} from '@happier-dev/cli-common/firstPartyRuntime/cliMachineRegistration';

export async function readDaemonMachineIds(settingsPath: string): Promise<string[]> {
  const settings = await readRegistrationJsonIfPresent(settingsPath);
  const activeServerId = settings && typeof settings === 'object' && 'activeServerId' in settings
    && typeof settings.activeServerId === 'string' ? settings.activeServerId : null;
  const serversDir = join(dirname(settingsPath), 'servers');
  const dirs = await readdir(serversDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const serverIds = dirs.filter(dir => dir.isDirectory() && isServerIdFilesystemSafe(dir.name)).map(dir => dir.name);
  if (activeServerId && isServerIdFilesystemSafe(activeServerId)) serverIds.unshift(activeServerId);
  const ids = new Set<string>();
  for (const serverId of new Set(serverIds)) {
    const registration = await readStoredMachineRegistration(resolveMachineRegistrationPath(serversDir, serverId));
    const machineId = registration && resolveRegisteredMachineId(registration);
    if (machineId) ids.add(machineId);
  }
  return [...ids];
}

async function readDaemonMachineId(cliHomeDir: string): Promise<string> {
  const [machineId] = await readDaemonMachineIds(join(cliHomeDir, 'settings.json'));
  if (machineId) return machineId;
  throw new Error('No current daemon Machine registration under ' + cliHomeDir);
}

export async function waitForDaemonMachineId(
  params: Readonly<{ cliHomeDir: string; timeoutMs?: number; pollIntervalMs?: number }>,
): Promise<string> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const pollIntervalMs = params.pollIntervalMs ?? 250;
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await readDaemonMachineId(params.cliHomeDir);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for daemon Machine registration after ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`,
  );
}
