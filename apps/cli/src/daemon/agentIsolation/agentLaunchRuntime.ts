import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { normalizeMaterializationKeyForPath } from '../connectedServices/materialize/normalizeMaterializationKeyForPath';

const operationParent = (agentHome: string) => join(agentHome, 'runtime', 'operations');

/** Native state roots use either the admitted identity home or a selected lease. */
export function resolveAgentLaunchNativeEnvironment(home: string) {
  return { XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state') };
}

/** Only this namespace holds finite effects; Session resume homes stay retained. */
export function agentLaunchOperationRuntimeHome(agentHome: string, materializationKey: string): string {
  return join(operationParent(agentHome), normalizeMaterializationKeyForPath(materializationKey));
}

/** The fixed RunAs shim supplies its observed native HOME, never a payload cache path. */
export async function prepareAgentLaunchIdentityCache(agentHome: string): Promise<string> {
  const cache = join(agentHome, '.cache');
  await mkdir(cache, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const entry = await lstat(cache);
  if (!entry.isDirectory() || entry.uid !== process.getuid?.()) throw new Error('agent_launch_material_invalid');
  await chmod(cache, 0o700);
  return cache;
}

/** Called only when the operation lease releases, as the selected native UID. */
export async function retireAgentLaunchOperationRuntime(agentHome: string, runtimeHome: string): Promise<void> {
  if (runtimeHome !== resolve(runtimeHome) || dirname(runtimeHome) !== operationParent(agentHome)) {
    throw new Error('agent_launch_material_invalid');
  }
  try {
    const parentPath = dirname(runtimeHome);
    const parent = await lstat(parentPath);
    const entry = await lstat(runtimeHome);
    const uid = process.getuid?.();
    if (!parent.isDirectory() || !entry.isDirectory() || parent.uid !== uid || entry.uid !== uid
      || await realpath(parentPath) !== parentPath) throw new Error('agent_launch_material_invalid');
    await rm(runtimeHome, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
