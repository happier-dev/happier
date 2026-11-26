import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalAbsolutePathsEqual, expandHomePath, readConnectedAccountNativeHomeState, resolveConfiguredNativeHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { parse as parseToml } from 'smol-toml';
import { CODEX_NATIVE_HOME } from '../../../../nativeHome.js';

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

type CodexRuntimeHomeInput = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  codexHome?: string;
  home?: 'user' | 'connectedService';
  cwd: string;
  expandHomePath?: (rawPath: string) => string;
  configOverrides?: readonly string[];
}>;

type CodexRuntimeHomeEnvironment = Readonly<{ CODEX_HOME: string; CODEX_SQLITE_HOME?: string }>;
export type CodexRuntimeStore = Readonly<{
  environment: CodexRuntimeHomeEnvironment;
  sqliteHome: string | null;
  sqliteHomeOverride: string | null;
}>;

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function mayExist(path: string): Promise<boolean> {
  return await stat(path).then(() => true, error => !missing(error));
}

async function readUserConfig(codexHome: string): Promise<ReturnType<typeof parseToml>> {
  try { return parseToml(await readFile(join(codexHome, 'config.toml'), 'utf8')); }
  catch (error) { if (missing(error)) return {}; throw error; }
}

async function hasUnresolvedProjectConfig(cwd: string, codexHome: string): Promise<boolean> {
  const canonicalHome = await realpath(codexHome).catch(() => codexHome);
  let hasProjectConfig = false;
  for (let directory = cwd;; directory = dirname(directory)) {
    const configDirectory = join(directory, '.codex');
    if (configDirectory !== codexHome
      && await mayExist(join(configDirectory, 'config.toml'))
      && await realpath(configDirectory).catch(() => configDirectory) !== canonicalHome) {
      if (directory === cwd) return true;
      hasProjectConfig = true;
    }
    const marker = join(directory, '.git');
    const metadata = await stat(marker).catch(() => null);
    if (metadata && (!metadata.isDirectory() || await mayExist(join(marker, 'HEAD')))) return hasProjectConfig;
    // Without a project marker Codex only reads cwd's .codex/config.toml.
    if (dirname(directory) === directory) return false;
  }
}

async function resolveNativeSqliteHome(params: CodexRuntimeHomeInput, environment: CodexRuntimeHomeEnvironment, pin: string | null, override: string | undefined): Promise<string | null> {
  const codexHome = environment.CODEX_HOME;
  const cwd = resolve(params.cwd);
  try {
    const userConfig = await readUserConfig(codexHome);
    // Codex requirements can override even argv. When native-only layers can
    // select a different store, leave SQLite to the native operation.
    const systemConfig = process.platform === 'win32' ? [] : [
      '/etc/codex/config.toml', '/etc/codex/requirements.toml', '/etc/codex/managed_config.toml',
    ];
    if ((await Promise.all([
      ...systemConfig,
      join(codexHome, 'auth.json'), join(codexHome, 'cloud-config-bundle-cache.json'),
    ].map(mayExist))).some(Boolean)) return null;
    if (userConfig.profile !== undefined || userConfig.project_root_markers !== undefined
      || userConfig.cli_auth_credentials_store === 'keyring'
      || params.configOverrides?.some(value => /^\s*(?:profile|cli_auth_credentials_store|project_root_markers)\s*=/u.test(value))
      || await hasUnresolvedProjectConfig(cwd, codexHome)) return null;

    // Codex 0.162.1 resolves config paths against their layer, then falls
    // back to the environment (relative to native cwd), then CODEX_HOME.
    if (override) {
      const value = parseToml(override).sqlite_home;
      return typeof value === 'string' ? resolve(cwd, value) : null;
    }
    if (pin) return pin;
    if (userConfig.sqlite_home !== undefined) {
      return typeof userConfig.sqlite_home === 'string' ? resolve(codexHome, userConfig.sqlite_home) : null;
    }
    return environment.CODEX_SQLITE_HOME ?? codexHome;
  } catch {
    return null;
  }
}

async function projectCodexRuntimeHome(params: CodexRuntimeHomeInput) {
  const codexHome = params.codexHome ?? resolveConfiguredNativeHomePath(CODEX_NATIVE_HOME, params.env);
  const expandPath = params.expandHomePath ?? (rawPath => expandHomePath(rawPath, resolveHomeDirFromEnvironment(params.env)));
  const state = await readConnectedAccountNativeHomeState(codexHome);
  const selectedRoot = state?.stateRootEnvironment?.CODEX_SQLITE_HOME;
  let fallbackCodexHome = codexHome;
  if (state?.effectiveStateMode === 'shared' && !selectedRoot) {
    // Predecessor manifests have a sharing decision but no explicit affinity.
    // A selected pool home in the invocation env is not the native source home.
    const nativeSourceHome = resolveConfiguredNativeHomePath(CODEX_NATIVE_HOME, params.env);
    fallbackCodexHome = canonicalAbsolutePathsEqual(nativeSourceHome, codexHome)
      ? resolveConfiguredNativeHomePath(CODEX_NATIVE_HOME, { ...params.env, CODEX_HOME: undefined })
      : nativeSourceHome;
  }
  const connectedHome = Boolean(state || params.home === 'connectedService');
  const environmentRoot = selectedRoot ? resolve(codexHome, selectedRoot)
    : connectedHome || params.env.CODEX_SQLITE_HOME?.trim() ? resolveCodexConfiguredSqliteHome({
      codexSqliteHome: connectedHome && state?.effectiveStateMode !== 'shared' ? undefined : params.env.CODEX_SQLITE_HOME,
      fallbackCodexHome,
      cwd: params.cwd,
      expandHomePath: expandPath,
    }) : undefined;
  const environment = Object.freeze({ CODEX_HOME: codexHome, ...(environmentRoot ? { CODEX_SQLITE_HOME: environmentRoot } : {}) });
  const pin = connectedHome ? environmentRoot ?? null : null;
  return { environment, pin };
}

export async function resolveCodexRuntimeStore(params: CodexRuntimeHomeInput): Promise<CodexRuntimeStore> {
  const { environment, pin } = await projectCodexRuntimeHome(params);
  const override = params.configOverrides?.findLast(value => /^\s*sqlite_home\s*=/u.test(value));
  return Object.freeze({
    environment,
    sqliteHome: await resolveNativeSqliteHome(params, environment, pin, override),
    sqliteHomeOverride: pin && !override ? `sqlite_home=${JSON.stringify(pin)}` : null,
  });
}

export async function resolveCodexRuntimeHomeEnvironment(params: CodexRuntimeHomeInput): Promise<CodexRuntimeHomeEnvironment> {
  return (await projectCodexRuntimeHome(params)).environment;
}

export function applyCodexRuntimeStoreEnvironment(
  env: CodexRuntimeHomeInput['env'], store: CodexRuntimeStore | null,
): CodexRuntimeHomeInput['env'] {
  const sqliteHome = store?.environment.CODEX_SQLITE_HOME;
  return sqliteHome ? { ...env, CODEX_SQLITE_HOME: sqliteHome } : env;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readNativeAbsolutePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
  return isAbsolute(path) ? path : null;
}

export async function proveCodexNativeRuntimeStore(params: Readonly<{
  store: CodexRuntimeStore;
  request: (method: string, params?: unknown) => Promise<unknown>;
  cwd: string;
}>): Promise<CodexRuntimeStore> {
  if (params.store.sqliteHome) return params.store;
  try {
    // The initialized server owns enterprise and project config. Codex 0.162.1
    // exposes requirements separately and omits environment/default values.
    const [required, configured] = await Promise.all([
      params.request('configRequirements/read'),
      params.request('config/read', { cwd: params.cwd }),
    ]);
    const requirements = asRecord(required)?.requirements;
    if (requirements !== null && !asRecord(requirements)) return params.store;
    const config = asRecord(asRecord(configured)?.config);
    if (!config) return params.store;
    const nativePath = asRecord(requirements)?.sqliteHome ?? config.sqlite_home;
    const sqliteHome = nativePath == null
      ? params.store.environment.CODEX_SQLITE_HOME ?? params.store.environment.CODEX_HOME
      : readNativeAbsolutePath(nativePath);
    return { ...params.store, sqliteHome };
  } catch {
    return params.store;
  }
}
