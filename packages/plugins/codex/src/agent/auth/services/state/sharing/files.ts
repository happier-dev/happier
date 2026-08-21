import { resolve } from 'node:path';

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
