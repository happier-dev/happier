import { lstat, readdir, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { withPinnedDirectory, withPinnedUnixPath } from '@/utils/fs/unixPinnedPath';
import { normalizeMaterializationKeyForPath } from '../connectedServices/materialize/normalizeMaterializationKeyForPath';

const operationParent = (agentHome: string) => join(agentHome, 'runtime', 'operations');

/** Only this namespace holds finite effects; Session resume homes stay retained. */
export function agentLaunchOperationRuntimeHome(agentHome: string, materializationKey: string): string {
  return join(operationParent(agentHome), normalizeMaterializationKeyForPath(materializationKey));
}

/** The fixed RunAs shim supplies its observed native HOME, never a payload cache path. */
export async function prepareAgentLaunchIdentityCache(agentHome: string): Promise<string> {
  const cache = join(agentHome, '.cache');
  await withPinnedUnixPath(cache, true, true, async entry => {
    if ((await entry.stat()).uid !== process.getuid?.()) throw new Error('agent_launch_material_invalid');
    await entry.chmod(0o700);
  });
  return cache;
}

/** Called only when the operation lease releases, as the selected native UID. */
export async function retireAgentLaunchOperationRuntime(agentHome: string, runtimeHome: string): Promise<void> {
  if (runtimeHome !== resolve(runtimeHome) || dirname(runtimeHome) !== operationParent(agentHome)) {
    throw new Error('agent_launch_material_invalid');
  }
  await withPinnedDirectory(dirname(runtimeHome), async parent => {
    if ((await stat(parent.path)).uid !== process.getuid?.()) throw new Error('agent_launch_material_invalid');
    await parent.withDirectory(basename(runtimeHome), false, async directory => {
      const admitted = await stat(directory.path);
      if (admitted.uid !== process.getuid?.()) throw new Error('agent_launch_material_invalid');
      for (const name of await readdir(directory.path)) await directory.remove(name);
      const namedPath = join(parent.path, basename(runtimeHome));
      const named = await lstat(namedPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      // A substituted name has no cleanup custody. Its target is never opened.
      if (named?.dev === admitted.dev && named.ino === admitted.ino) {
        await rmdir(namedPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    });
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}
