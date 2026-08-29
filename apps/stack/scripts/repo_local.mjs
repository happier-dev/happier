import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scrubHappierStackEnv, STACK_WRAPPER_PRESERVE_KEYS } from './utils/env/scrub_env.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { readExecutionHostProfile } from './utils/execution_host/config.mjs';
import { resolveHostWorkspaceMapping } from './utils/execution_host/delegation.mjs';
import { ensureDepsInstalled } from './utils/proc/pm.mjs';
import { ensureEnvFileMutated } from './utils/env/env_file.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { selectLocalServerPortCandidateForStack } from './utils/server/resolve_stack_server_port.mjs';
import { resolveStackEnvPath } from './utils/paths/paths.mjs';
import { resolveEffectiveDbProviderTransition } from './utils/server/effective_db_provider.mjs';
import {
  resolveRepoStackIdentity,
  resolveStacksStorageRoot,
} from './utils/stack/repo_stack_identity.mjs';

function shouldAutoInstallDepsForRepoLocalCommand(cmd) {
  const c = String(cmd ?? '').trim();
  if (!c) return false;
  if (c === 'help' || c === '--help' || c === '-h') return false;
  if (c === 'where') return false;
  if (c === 'stop') return false;
  return true;
}

function isRuntimeSnapshotSelectionCommand(argv) {
  const positionals = (Array.isArray(argv) ? argv : [])
    .filter((arg) => arg !== '--' && !String(arg).startsWith('-'));
  return (
    positionals.length === 4
    && positionals[0] === 'stack'
    && positionals[1] === 'runtime'
    && Boolean(positionals[2])
    && positionals[3] === 'select'
  );
}

function isMobileRepoLocalCommand(cmd) {
  const c = String(cmd ?? '').trim();
  return c === 'mobile' || c === 'mobile-dev-client' || c.startsWith('mobile:');
}

function prepareRepoLocalDependencyInstallEnv({ cmd, env }) {
  const next = { ...(env ?? process.env) };
  if (isMobileRepoLocalCommand(cmd)) {
    if (!String(next.SKIP_SKIA_DOWNLOAD ?? '').trim()) {
      next.SKIP_SKIA_DOWNLOAD = '1';
    }
    if (!String(next.HAPPIER_INSTALL_SCOPE ?? '').trim()) {
      next.HAPPIER_INSTALL_SCOPE = 'ui';
    }
  }
  return next;
}

async function maybeAutoInstallRepoDeps({ repoRoot, cmd, env, autoInstallOverride = '', preflightRootOverride = '' }) {
  const autoInstallRaw = String(autoInstallOverride ?? '').trim();
  const autoInstall = autoInstallRaw ? autoInstallRaw !== '0' : true;
  if (!autoInstall) return;
  if (!shouldAutoInstallDepsForRepoLocalCommand(cmd)) return;

  // Test hook: allow validating auto-install behavior without mutating the real repo checkout.
  const preflightRoot = String(preflightRootOverride ?? '').trim() || repoRoot;
  const installEnv = prepareRepoLocalDependencyInstallEnv({ cmd, env });

  // This wrapper owns only clean-checkout bootstrap. Once a dependency tree exists, the
  // component startup owner performs the canonical freshness check after hstack is running.
  // Repeating that admission here can hold the CLI publication lock before the TUI or stack
  // lifecycle has even had an opportunity to preserve/adopt an incumbent runtime.
  if (existsSync(join(preflightRoot, 'node_modules'))) return;

  await ensureDepsInstalled(preflightRoot, 'happier-monorepo', { quiet: false, env: installEnv });
}

function usage() {
  return [
    '[repo-local] usage:',
    '  node apps/stack/scripts/repo_local.mjs <hstack-subcommand> [args...]',
    '',
    'examples:',
    '  node apps/stack/scripts/repo_local.mjs dev',
    '  node apps/stack/scripts/repo_local.mjs start --restart',
    '  node apps/stack/scripts/repo_local.mjs tui',
    '  node apps/stack/scripts/repo_local.mjs tui --tauri',
    '  node apps/stack/scripts/repo_local.mjs tui stack dev exp1',
    '',
    'notes:',
    '  - Forces using this repo checkout (no re-exec to global hstack install).',
    '  - Defaults to an isolated per-checkout stack (prevents collisions with your main stack).',
    '  - `tui` defaults to `tui dev` when no command is provided.',
    '  - `tui --tauri` adds a Tauri dev pane and keeps the stack UI off in that run.',
    '  - `stop` maps to `stack stop <repo-stack>` for convenience.',
    '  - Use --dry-run to print the resolved invocation as JSON.',
  ].join('\n');
}

function stringifyEnvFile(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    const key = String(k ?? '').trim();
    if (!key) continue;
    if (v == null) continue;
    const val = String(v);
    if (!val.trim()) continue;
    lines.push(`${key}=${val}`);
  }
  return lines.join('\n') + '\n';
}

function coercePositiveInt(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function isPortWithinRange(port, base, range) {
  const p = coercePositiveInt(port);
  const b = coercePositiveInt(base);
  const r = coercePositiveInt(range);
  if (!p || !b || !r) return false;
  return p >= b && p < b + r;
}

function readTextFile(path) {
  try {
    if (!path || !existsSync(path)) return '';
    return readFileSync(path, 'utf-8').toString().trim();
  } catch {
    return '';
  }
}

function readEnvFileObject(path) {
  const raw = readTextFile(path);
  if (!raw.trim()) return {};
  try {
    return parseEnvToObject(raw);
  } catch {
    return {};
  }
}

async function syncRepoLocalEnvFile({ envPath, managedEnv = {}, pruneKeys = [] } = {}) {
  const target = String(envPath ?? '').trim();
  if (!target) return;

  const updates = Object.entries(managedEnv ?? {})
    .map(([k, v]) => ({ key: String(k ?? '').trim(), value: v == null ? '' : String(v) }))
    .filter((u) => u.key && u.value.trim() !== '');

  const removeKeys = Array.from(new Set((pruneKeys ?? []).map((k) => String(k ?? '').trim()).filter(Boolean)));
  // Preserve user keys while applying the managed projection atomically.
  await ensureEnvFileMutated({ envPath: target, updates, removeKeys });
}

function expandHomePath(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

function normalizePathForComparison(p) {
  const expanded = expandHomePath(p);
  if (!expanded) return '';
  const normalized = resolve(expanded);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hasForeignStackSelection({ env, stackName, envPath, runtimeStatePath }) {
  const inheritedStackName = String(env?.HAPPIER_STACK_STACK ?? '').trim();
  if (inheritedStackName && inheritedStackName !== stackName) return true;

  const expectedPaths = [
    ['HAPPIER_STACK_ENV_FILE', envPath],
    ['HAPPIER_STACK_RUNTIME_STATE_PATH', runtimeStatePath],
  ];
  return expectedPaths.some(([key, expectedPath]) => {
    const inheritedPath = normalizePathForComparison(env?.[key]);
    return inheritedPath && inheritedPath !== normalizePathForComparison(expectedPath);
  });
}

function readRuntimeServerPort(runtimeStatePath) {
  try {
    if (!runtimeStatePath || !existsSync(runtimeStatePath)) return null;
    const raw = readFileSync(runtimeStatePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const port = Number(parsed?.ports?.server);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function readRuntimeExpoPort(runtimeStatePath) {
  try {
    if (!runtimeStatePath || !existsSync(runtimeStatePath)) return null;
    const raw = readFileSync(runtimeStatePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const port = Number(parsed?.expo?.port ?? parsed?.expo?.webPort ?? parsed?.expo?.mobilePort);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function resolveActiveExecutionHostStackIdentity({ repoRoot, invokedCwd, env }) {
  const profile = readExecutionHostProfile(env);
  if (profile?.activation !== 'active' || profile.version !== 2) return null;
  for (const hostPath of [repoRoot, invokedCwd]) {
    try {
      const mapping = resolveHostWorkspaceMapping(profile, hostPath);
      const stackName = String(mapping.workspace.stackName ?? '').trim();
      if (!stackName) continue;
      const { baseDir: stackBaseDir } = resolveStackEnvPath(stackName, env);
      return {
        stackName,
        stackBaseDir,
        runtimeStatePath: join(stackBaseDir, 'stack.runtime.json'),
      };
    } catch {
      // An active named profile may govern another checkout; retain normal
      // repo-local identity resolution when this invocation is not mapped.
    }
  }
  return null;
}

async function main() {
  const autoInstallOverride = String(process.env.HAPPIER_STACK_REPO_LOCAL_AUTO_INSTALL ?? '').trim();
  const preflightRootOverride = String(process.env.HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ROOT ?? '').trim();
  const preflightOnly = String(process.env.HAPPIER_STACK_REPO_LOCAL_PREFLIGHT_ONLY ?? '').trim();

  const argvRaw = process.argv.slice(2);
  const firstArg = argvRaw[0];
  const showWrapperHelp =
    argvRaw.length === 0 || firstArg === 'help' || firstArg === '--help' || firstArg === '-h';
  if (showWrapperHelp) {
    process.stdout.write(usage() + '\n');
    process.exit(argvRaw.length === 0 ? 1 : 0);
  }

  const dryRun = argvRaw.includes('--dry-run');
  const argvWithoutDryRun = argvRaw.filter((a) => a !== '--dry-run');

  // Root script convenience:
  // `yarn tui` should work from monorepo checkout without additional args.
  // Default to `hstack tui dev` while preserving explicit forwarded args.
  let argv = argvWithoutDryRun;
  if (argvWithoutDryRun[0] === 'tui') {
    const forwarded = argvWithoutDryRun.slice(1);
    if (forwarded.length === 0) {
      argv = ['tui', 'dev', '--mobile'];
    }
  }
  const wantsTuiMobile = argv[0] === 'tui' && argv.some((arg) => String(arg ?? '').trim() === '--mobile' || String(arg ?? '').trim() === '--with-mobile');

  const scriptsDir = dirname(fileURLToPath(import.meta.url)); // <repo>/apps/stack/scripts
  const repoRoot = dirname(dirname(dirname(scriptsDir))); // <repo>
  const hstackBin = join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');

  const invokedCwd =
    (process.env.HAPPIER_STACK_INVOKED_CWD ?? '').toString().trim() ||
    (process.env.INIT_CWD ?? '').toString().trim() ||
    process.cwd();

  const subcommand = String(argv[0] ?? '').trim();
  const isStop = subcommand === 'stop';
  const isStackManagement =
    isStop ||
    subcommand === 'stack' ||
    subcommand === 'wt' ||
    subcommand === 'worktrees';
  const isRuntimeSnapshotSelection = isRuntimeSnapshotSelectionCommand(argv);

  // Selecting a named consumer's existing producer snapshot has no repo-local
  // producer role. Keep it free of identity allocation and dependency bootstrap
  // so a controlled consumer can select while its checkout is not build-ready.
  const stackIdentity = isRuntimeSnapshotSelection
    ? null
    : resolveActiveExecutionHostStackIdentity({ repoRoot, invokedCwd, env: process.env })
      ?? resolveRepoStackIdentity({
        repoRoot,
        stacksStorageRoot: resolveStacksStorageRoot(process.env),
        createIfMissing: !dryRun && !isStop,
      });
  const stacklessName = stackIdentity?.stackName ?? '';
  const stacklessBaseDir = stackIdentity?.stackBaseDir ?? '';
  const stacklessRuntimePath = stackIdentity?.runtimeStatePath ?? '';
  const runtimeServerPort = stacklessRuntimePath ? readRuntimeServerPort(stacklessRuntimePath) : null;
  const runtimeExpoPort = stacklessRuntimePath ? readRuntimeExpoPort(stacklessRuntimePath) : null;
  const stacklessEnvPath = stacklessBaseDir ? join(stacklessBaseDir, 'env') : '';
  const stacklessCliHomeDir = stacklessBaseDir ? join(stacklessBaseDir, 'cli') : '';
  const stacklessLogsDir = stacklessBaseDir ? join(stacklessBaseDir, 'logs') : '';
  const existingStacklessEnv = stacklessEnvPath ? readEnvFileObject(stacklessEnvPath) : {};
  const existingPinnedServerPort = coercePositiveInt(existingStacklessEnv.HAPPIER_STACK_SERVER_PORT);
  const existingPinnedExpoPort = coercePositiveInt(existingStacklessEnv.HAPPIER_STACK_EXPO_DEV_PORT);

  // Convenience:
  // `yarn stop` should stop the repo-local stack without requiring users to know its generated name.
  if (isStop) {
    const forwarded = argv.slice(1);
    argv = ['stack', 'stop', stacklessName, ...forwarded];
  }

  // The top-level `hstack daemon` command is intentionally a main-stack alias. Repo-local scripts own an
  // isolated checkout stack, so route daemon lifecycle commands through the canonical stack command instead.
  if (subcommand === 'daemon') {
    const forwarded = argv.slice(1);
    argv = ['stack', 'daemon', stacklessName, ...forwarded];
  }

  // Convenience:
  // `yarn mobile:install` should install a local iOS build for the repo-local stack without requiring users
  // to know the generated stack name, and should run the full stack install flow (prebuild, identity, etc).
  if (subcommand === 'mobile:install') {
    const forwarded = argv.slice(1);
    const isDevelopmentInstall = forwarded.some((a) => String(a ?? '').trim() === '--app-env=development');
    const hasName = forwarded.some((a) => {
      const s = String(a ?? '').trim();
      return s === '--name' || s.startsWith('--name=') || s === '--app-name' || s.startsWith('--app-name=');
    });
    const defaultNameArg = hasName ? [] : [isDevelopmentInstall ? '--name=Happier Dev (Local)' : '--name=Happier (Local)'];
    argv = ['stack', 'mobile:install', stacklessName, ...defaultNameArg, ...forwarded];
  }

  // Force "repo-local" behavior:
  // - avoid re-exec into any global install
  // - avoid pinning to a configured repo dir (infer from invoked cwd)
  // - avoid leaking previously-exported stack env (main stack urls, home dir, etc.)
  const cleaned = scrubHappierStackEnv(process.env, {
    keepHappierStackKeys: STACK_WRAPPER_PRESERVE_KEYS,
    clearUnprefixedKeys: [
      'HAPPIER_SERVER_URL',
      'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_HOME_DIR',
      'APP_ENV',
      'EXPO_UPDATES_CHANNEL',
      'EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV',
      'EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW',
      'EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY',
      'HAPPIER_FEATURE_POLICY_ENV',
      'HAPPIER_EMBEDDED_POLICY_ENV',
      'HAPPIER_BUILD_FEATURES_ALLOW',
      'HAPPIER_BUILD_FEATURES_DENY',
      // Prevent accidental credential scoping to the user's "main" stack config.
      'HAPPIER_ACTIVE_SERVER_ID',
    ],
  });

  const inheritedForeignStackSelection = isRuntimeSnapshotSelection
    ? false
    : hasForeignStackSelection({
        env: cleaned,
        stackName: stacklessName,
        envPath: stacklessEnvPath,
        runtimeStatePath: stacklessRuntimePath,
      });
  const runtimeModeRaw = inheritedForeignStackSelection
    ? ''
    : String(cleaned.HAPPIER_STACK_RUNTIME_MODE ?? '').trim();
  const env = {
    ...cleaned,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_CLI_ROOT_DIR: repoRoot,
    HAPPIER_STACK_REPO_DIR: repoRoot,
    ...(isStackManagement
      ? { HAPPIER_STACK_STACK: '' }
      : {
          // Treat repo-local runs as an isolated, per-checkout stack by default.
          // This prevents collisions with the user's "main" stack (ports, daemon home, tailscale prefs, etc).
          HAPPIER_STACK_STACK: stacklessName,
          // Default to source mode for repo-local dev flows (ensures `yarn tui:with-tauri` reflects local changes
          // even if the user previously enabled runtime snapshots). Users can override by setting this env var.
          HAPPIER_STACK_RUNTIME_MODE: runtimeModeRaw || 'source',
          // The repo-local wrapper owns the complete stack identity. Never inherit a runtime-state pointer from
          // another active stack, or the selected name/env and the state writer can silently diverge.
          HAPPIER_STACK_RUNTIME_STATE_PATH: stacklessRuntimePath,
          // Make stack-owned processes prove ownership (for stop/cleanup) and enable stack commands like `stack auth`.
          HAPPIER_STACK_ENV_FILE: stacklessEnvPath,
          HAPPIER_STACK_CLI_HOME_DIR: stacklessCliHomeDir,
          // If set, internal spawns can tee output into stack-scoped log files (server.log/expo.log/ui.log).
          HAPPIER_STACK_LOG_TEE_DIR: stacklessLogsDir,
          HAPPIER_STACK_LOG_TEE_TIMESTAMPS: '1',
          // Stackless isolation: keep ports away from main/default stack ports by default.
          HAPPIER_STACK_SERVER_PORT_BASE: (process.env.HAPPIER_STACK_SERVER_PORT_BASE ?? '52005').toString(),
          HAPPIER_STACK_SERVER_PORT_RANGE: (process.env.HAPPIER_STACK_SERVER_PORT_RANGE ?? '2000').toString(),
          HAPPIER_STACK_EXPO_DEV_PORT_BASE: (process.env.HAPPIER_STACK_EXPO_DEV_PORT_BASE ?? '18081').toString(),
          HAPPIER_STACK_EXPO_DEV_PORT_RANGE: (process.env.HAPPIER_STACK_EXPO_DEV_PORT_RANGE ?? '2000').toString(),
          // Make Expo's Metro use stable (stack-scoped) port strategy.
          HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: (process.env.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY ?? 'stable').toString(),
          ...(wantsTuiMobile ? { HAPPIER_STACK_CLI_BUILD_MODE: 'always' } : {}),
          ...(runtimeServerPort &&
          !existingPinnedServerPort &&
          isPortWithinRange(
            runtimeServerPort,
            process.env.HAPPIER_STACK_SERVER_PORT_BASE ?? '52005',
            process.env.HAPPIER_STACK_SERVER_PORT_RANGE ?? '2000'
          )
            ? { HAPPIER_STACK_SERVER_PORT: String(runtimeServerPort) }
            : {}),
          ...(runtimeExpoPort &&
          !existingPinnedExpoPort &&
          isPortWithinRange(
            runtimeExpoPort,
            process.env.HAPPIER_STACK_EXPO_DEV_PORT_BASE ?? '18081',
            process.env.HAPPIER_STACK_EXPO_DEV_PORT_RANGE ?? '2000'
          )
            ? { HAPPIER_STACK_EXPO_DEV_PORT: String(runtimeExpoPort) }
            : {}),
        }),
    HAPPIER_STACK_INVOKED_CWD: invokedCwd,
  };

  const effectiveEnv = !isStackManagement
    ? applyStackActiveServerScopeEnv({ env, stackName: stacklessName })
    : env;

  // Ensure the base directory + env file exist so stack-scoped commands (auth/stop) work reliably.
  // Note: `stop` is stack-management, but still needs the env file to exist.
  if (!dryRun && (!isStackManagement || isStop)) {
    try {
      mkdirSync(stacklessBaseDir, { recursive: true });
      mkdirSync(stacklessCliHomeDir, { recursive: true });
      mkdirSync(stacklessLogsDir, { recursive: true });
    } catch {
      // ignore (best-effort)
    }

	    const previousServerComponent = (existingStacklessEnv.HAPPIER_STACK_SERVER_COMPONENT ?? 'happier-server-light').toString().trim() || 'happier-server-light';
	    const serverComponent = (
	      effectiveEnv.HAPPIER_STACK_SERVER_COMPONENT ??
	      existingStacklessEnv.HAPPIER_STACK_SERVER_COMPONENT ??
	      'happier-server-light'
	    ).toString().trim() || 'happier-server-light';
	    const dbTransition = resolveEffectiveDbProviderTransition({
	      previousServerComponentName: previousServerComponent,
	      nextServerComponentName: serverComponent,
	      env: existingStacklessEnv,
	    });
	    if (!dbTransition.ok) {
	      if (dbTransition.reason === 'missing_mysql_database_url') {
	        throw new Error('[repo-local] mysql requires an explicit DATABASE_URL');
	      }
	      if (dbTransition.reason === 'missing_postgres_database_url') {
	        throw new Error('[repo-local] postgres requires an explicit DATABASE_URL with the light preset');
	      }
	      if (dbTransition.reason === 'invalid_postgres_database_url') {
	        throw new Error('[repo-local] postgres DATABASE_URL must use postgres:// or postgresql://');
	      }
	      throw new Error(`[repo-local] invalid DB provider for ${serverComponent}: ${dbTransition.input ?? dbTransition.reason}`);
	    }
	    effectiveEnv.HAPPIER_STACK_SERVER_COMPONENT = serverComponent;
	    effectiveEnv.HAPPIER_DB_PROVIDER = dbTransition.provider;
	    delete effectiveEnv.HAPPY_DB_PROVIDER;
	    if (dbTransition.databaseUrl) {
	      effectiveEnv.DATABASE_URL = dbTransition.databaseUrl;
	    } else {
	      delete effectiveEnv.DATABASE_URL;
	    }
	    const serverBase = effectiveEnv.HAPPIER_STACK_SERVER_PORT_BASE;
	    const serverRange = effectiveEnv.HAPPIER_STACK_SERVER_PORT_RANGE;
	    const expoBase = effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_BASE;
	    const expoRange = effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_RANGE;

	    // Persist a stable pinned server port early so repo-local "global-ish" commands like
	    // `yarn tailscale enable` and `yarn service install` can resolve the correct internal URL
	    // even before the first `yarn dev/start` run creates stack.runtime.json.
	    let persistedServerPort = null;
	    if (!existingPinnedServerPort) {
	      if (runtimeServerPort && isPortWithinRange(runtimeServerPort, serverBase, serverRange)) {
	        persistedServerPort = runtimeServerPort;
	      } else {
		        persistedServerPort = await selectLocalServerPortCandidateForStack({
	          env: {
	            ...effectiveEnv,
	            HAPPIER_STACK_SERVER_PORT_BASE: (effectiveEnv.HAPPIER_STACK_SERVER_PORT_BASE ?? '52005').toString(),
	            HAPPIER_STACK_SERVER_PORT_RANGE: (effectiveEnv.HAPPIER_STACK_SERVER_PORT_RANGE ?? '2000').toString(),
	          },
	          stackMode: true,
	          stackName: stacklessName,
	          runtimeStatePath: stacklessRuntimePath,
	          defaultPort: 3005,
	        }).catch(() => null);
	      }
	    }

	    // Auto-heal:
	    // If a stale pinned port exists in the stackless env file but it doesn't match the configured stable range,
	    // prune it so dev/start can pick a stable high port again.
	    const pruneKeys = [];
    if (dbTransition.removeDatabaseUrl) {
      pruneKeys.push('DATABASE_URL');
    }
    if (
      existingPinnedServerPort &&
      existingPinnedServerPort < 5000 &&
      !isPortWithinRange(existingPinnedServerPort, serverBase, serverRange)
    ) {
      pruneKeys.push('HAPPIER_STACK_SERVER_PORT');
    }

    // Treat the repo-local stack as managed by the wrapper: keep a small set of stack-owned keys in sync,
    // but preserve any user-defined keys they set via `hstack env` / `yarn env`.
    const managedEnv = {
      HAPPIER_STACK_STACK: stacklessName,
      HAPPIER_STACK_REPO_DIR: repoRoot,
      HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
      HAPPIER_DB_PROVIDER: dbTransition.provider,
      ...(dbTransition.databaseUrl ? { DATABASE_URL: dbTransition.databaseUrl } : {}),
      HAPPIER_STACK_CLI_HOME_DIR: stacklessCliHomeDir,
      HAPPIER_STACK_SERVER_PORT_BASE: effectiveEnv.HAPPIER_STACK_SERVER_PORT_BASE,
      HAPPIER_STACK_SERVER_PORT_RANGE: effectiveEnv.HAPPIER_STACK_SERVER_PORT_RANGE,
      HAPPIER_STACK_EXPO_DEV_PORT_BASE: effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_BASE,
	      HAPPIER_STACK_EXPO_DEV_PORT_RANGE: effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_RANGE,
	      HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY,
	      // Keep the stable active server id explicit so daemons/CLI always scope state/credentials per stack.
	      ...(effectiveEnv.HAPPIER_ACTIVE_SERVER_ID ? { HAPPIER_ACTIVE_SERVER_ID: effectiveEnv.HAPPIER_ACTIVE_SERVER_ID } : {}),
	      ...(persistedServerPort &&
	      !existingPinnedServerPort &&
	      isPortWithinRange(persistedServerPort, serverBase, serverRange)
	        ? { HAPPIER_STACK_SERVER_PORT: String(persistedServerPort) }
	        : {}),
	      ...(runtimeExpoPort &&
	      !existingPinnedExpoPort &&
	      isPortWithinRange(runtimeExpoPort, expoBase, expoRange)
	        ? { HAPPIER_STACK_EXPO_DEV_PORT: String(runtimeExpoPort) }
        : {}),
    };
    await syncRepoLocalEnvFile({ envPath: stacklessEnvPath, managedEnv, pruneKeys });
  }

  const cmd = process.execPath;
  const args = [hstackBin, ...argv];
  const cwd = repoRoot;

  if (dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          cmd,
          args,
          cwd,
          env: {
            HAPPIER_STACK_CLI_ROOT_DISABLE: effectiveEnv.HAPPIER_STACK_CLI_ROOT_DISABLE,
            HAPPIER_STACK_CLI_ROOT_DIR: effectiveEnv.HAPPIER_STACK_CLI_ROOT_DIR,
            HAPPIER_STACK_REPO_DIR: effectiveEnv.HAPPIER_STACK_REPO_DIR,
            HAPPIER_STACK_STACK: effectiveEnv.HAPPIER_STACK_STACK,
            HAPPIER_STACK_SERVER_PORT: effectiveEnv.HAPPIER_STACK_SERVER_PORT,
            HAPPIER_STACK_ENV_FILE: effectiveEnv.HAPPIER_STACK_ENV_FILE,
            HAPPIER_STACK_CLI_HOME_DIR: effectiveEnv.HAPPIER_STACK_CLI_HOME_DIR,
            HAPPIER_STACK_CLI_BUILD_MODE: effectiveEnv.HAPPIER_STACK_CLI_BUILD_MODE,
            HAPPIER_STACK_LOG_TEE_DIR: effectiveEnv.HAPPIER_STACK_LOG_TEE_DIR,
            HAPPIER_STACK_LOG_TEE_TIMESTAMPS: effectiveEnv.HAPPIER_STACK_LOG_TEE_TIMESTAMPS,
            HAPPIER_ACTIVE_SERVER_ID: effectiveEnv.HAPPIER_ACTIVE_SERVER_ID,
            HAPPIER_STACK_INVOKED_CWD: effectiveEnv.HAPPIER_STACK_INVOKED_CWD,
            HAPPIER_STACK_RUNTIME_MODE: effectiveEnv.HAPPIER_STACK_RUNTIME_MODE,
            HAPPIER_STACK_RUNTIME_STATE_PATH: effectiveEnv.HAPPIER_STACK_RUNTIME_STATE_PATH,
          },
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  if (!isRuntimeSnapshotSelection) {
    try {
      await maybeAutoInstallRepoDeps({
        repoRoot,
        cmd: subcommand,
        env: effectiveEnv,
        autoInstallOverride,
        preflightRootOverride,
      });
    } catch (e) {
      process.stderr.write(`[repo-local] failed to install repo deps\n${String(e?.stack ?? e)}\n`);
      process.stderr.write('\nFix:\n  corepack enable\n  yarn install\n');
      process.exit(1);
    }
  }

  if (preflightOnly === '1') {
    process.exit(0);
  }

  const res = spawnSync(cmd, args, { cwd, env: effectiveEnv, stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

main().catch((e) => {
  process.stderr.write(`[repo-local] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
