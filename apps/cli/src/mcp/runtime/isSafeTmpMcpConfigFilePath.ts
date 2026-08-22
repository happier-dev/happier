import { tmpdir } from 'node:os';
import { rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function isSafeTmpMcpConfigFilePath(configPath: string, expectedPrefix: string): boolean {
  if (!configPath) return false;

  const tmpRoot = resolve(tmpdir());
  const resolved = resolve(configPath);

  const rel = relative(tmpRoot, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;

  const name = basename(resolved);
  if (!name.startsWith(`${expectedPrefix}.`)) return false;
  if (!name.endsWith('.json')) return false;

  return true;
}

function isWriterOwnedDefaultMcpRuntimeConfigPath(configPath: string, expectedPrefix: string): boolean {
  if (!isSafeTmpMcpConfigFilePath(configPath, expectedPrefix)) return false;

  const tmpRoot = resolve(tmpdir());
  const resolved = resolve(configPath);
  const directory = dirname(resolved);
  const directoryRelativeToTmp = relative(tmpRoot, directory);
  if (!directoryRelativeToTmp || directoryRelativeToTmp.includes('/') || directoryRelativeToTmp.includes('\\')) {
    return false;
  }

  const escapedPrefix = escapeRegExp(expectedPrefix);
  return new RegExp(`^${escapedPrefix}-[A-Za-z0-9]{6}$`, 'u').test(basename(directory))
    && new RegExp(`^${escapedPrefix}\\.owned\\.[0-9a-fA-F-]{36}\\.json$`, 'u').test(basename(resolved));
}

export async function removeConsumedMcpRuntimeConfigFile(
  configPath: string,
  expectedPrefix: string,
): Promise<void> {
  if (!isSafeTmpMcpConfigFilePath(configPath, expectedPrefix)) return;
  const removeOwnedDirectory = isWriterOwnedDefaultMcpRuntimeConfigPath(configPath, expectedPrefix);
  await unlink(configPath).catch(() => {});
  if (removeOwnedDirectory) {
    await rmdir(dirname(resolve(configPath))).catch(() => {});
  }
}
