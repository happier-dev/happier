import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

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
