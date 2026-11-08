import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PluginStorePaths } from './paths';

/** Installation and generation publication share the code-directory owner. */
export async function ensurePluginGenerationDirectories(paths: PluginStorePaths): Promise<void> {
  const parent = dirname(paths.generationsDir);
  if (parent !== paths.rootDir) {
    await mkdir(parent, { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') await chmod(parent, 0o755);
  }
  await mkdir(paths.generationsDir, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') await chmod(paths.generationsDir, 0o755);
}
