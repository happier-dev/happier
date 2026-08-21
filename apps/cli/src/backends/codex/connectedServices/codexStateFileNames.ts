import { resolve } from 'node:path';

import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

export function resolveConfiguredCodexSqliteHome(
  processEnv: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): string {
  const raw = processEnv.CODEX_SQLITE_HOME;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return resolveConfiguredCodexHome(processEnv);
  return resolve(cwd, expandHomeDirPath(trimmed, processEnv));
}
