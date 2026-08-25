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

export function resolveCodexRuntimeHomeEnvironment(params: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  codexHome: string;
  cwd: string;
  expandHomePath: (rawPath: string) => string;
}>): Readonly<{ CODEX_HOME: string; CODEX_SQLITE_HOME: string }> {
  return Object.freeze({
    CODEX_HOME: params.codexHome,
    CODEX_SQLITE_HOME: resolveCodexConfiguredSqliteHome({
      codexSqliteHome: params.env.CODEX_SQLITE_HOME,
      fallbackCodexHome: params.codexHome,
      cwd: params.cwd,
      expandHomePath: params.expandHomePath,
    }),
  });
}
