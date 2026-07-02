import { resolve } from 'node:path';

const CODEX_SHAREABLE_SQLITE_STATE_ENTRY_PATTERN = /^(?:state|goals)_\d+\.sqlite(?:-(?:wal|shm))?$/;

export function isCodexShareableSqliteStateEntry(entryName: string): boolean {
  return CODEX_SHAREABLE_SQLITE_STATE_ENTRY_PATTERN.test(entryName);
}

export function isCodexSharedStateSqliteFileName(entryName: string): boolean {
  return isCodexShareableSqliteStateEntry(entryName);
}

export function resolveCodexConfiguredSqliteHome(params: Readonly<{
  codexSqliteHome: string | null | undefined;
  fallbackCodexHome: string;
  cwd: string;
  expandHomePath: (rawPath: string) => string;
}>): string {
  const raw = params.codexSqliteHome;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return params.fallbackCodexHome;
  return resolve(params.cwd, params.expandHomePath(trimmed));
}
