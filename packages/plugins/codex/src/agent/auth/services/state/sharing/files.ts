import { resolve } from 'node:path';
import { canonicalAbsolutePathsEqual, readConnectedAccountNativeHomeState, resolveConfiguredNativeHomePath } from '@happier-dev/plugin-sdk/fs';
import { CODEX_NATIVE_HOME } from '@happier-dev/protocol/agents/codex/native-home-policy';

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

export async function resolveCodexRuntimeHomeEnvironment(params: Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  codexHome: string;
  home?: 'user' | 'connectedService';
  cwd: string;
  expandHomePath: (rawPath: string) => string;
}>): Promise<Readonly<{ CODEX_HOME: string; CODEX_SQLITE_HOME: string }>> {
  const state = await readConnectedAccountNativeHomeState(params.codexHome);
  const selectedRoot = state?.stateRootEnvironment?.CODEX_SQLITE_HOME;
  let fallbackCodexHome = params.codexHome;
  if (state?.effectiveStateMode === 'shared' && !selectedRoot) {
    // Predecessor manifests have a sharing decision but no explicit affinity.
    // A selected pool home in the invocation env is not the native source home.
    const nativeSourceHome = resolveConfiguredNativeHomePath(CODEX_NATIVE_HOME, params.env);
    fallbackCodexHome = canonicalAbsolutePathsEqual(nativeSourceHome, params.codexHome)
      ? resolveConfiguredNativeHomePath(CODEX_NATIVE_HOME, { ...params.env, CODEX_HOME: undefined })
      : nativeSourceHome;
  }
  return Object.freeze({
    CODEX_HOME: params.codexHome,
    CODEX_SQLITE_HOME: selectedRoot ? resolve(params.codexHome, selectedRoot) : resolveCodexConfiguredSqliteHome({
      codexSqliteHome: state?.effectiveStateMode === 'isolated' || (!state && params.home === 'connectedService')
        ? undefined : params.env.CODEX_SQLITE_HOME,
      fallbackCodexHome,
      cwd: params.cwd,
      expandHomePath: params.expandHomePath,
    }),
  });
}
