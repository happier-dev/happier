import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scrubHappierStackEnv, STACK_WRAPPER_PRESERVE_KEYS } from './utils/env/scrub_env.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';

function usage() {
  return [
    '[repo-local] usage:',
    '  node apps/stack/scripts/repo_local.mjs <hstack-subcommand> [args...]',
    '',
    'examples:',
    '  node apps/stack/scripts/repo_local.mjs dev',
    '  node apps/stack/scripts/repo_local.mjs start --restart',
    '  node apps/stack/scripts/repo_local.mjs tui',
    '  node apps/stack/scripts/repo_local.mjs tui stack dev exp1',
    '',
    'notes:',
    '  - Forces using this repo checkout (no re-exec to global hstack install).',
    '  - Defaults to an isolated per-checkout stack (prevents collisions with your main stack).',
    '  - `tui` defaults to `tui dev` when no command is provided.',
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

function sanitizeStackNameToken(s) {
  const raw = String(s ?? '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'repo';
}

function isHexToken(s, { minLen = 6 } = {}) {
  const raw = String(s ?? '').trim().toLowerCase();
  if (!raw || raw.length < minLen) return false;
  return /^[a-f0-9]+$/.test(raw);
}

function resolveGitDir(repoRoot) {
  try {
    const gitPath = join(repoRoot, '.git');
    if (!existsSync(gitPath)) return null;

    // Common case: .git is a directory.
    try {
      const stat = readFileSync(gitPath, { encoding: 'utf-8' });
      void stat;
    } catch {
      return gitPath;
    }

    // Worktree case: .git is a file like "gitdir: /path/to/actual/git/dir".
    const raw = readFileSync(gitPath, 'utf-8').trim();
    const m = raw.match(/^gitdir:\s*(.+)\s*$/i);
    if (!m) return null;
    const p = m[1].trim();
    if (!p) return null;
    return p.startsWith('/') ? p : join(repoRoot, p);
  } catch {
    return null;
  }
}

function readTextFile(path) {
  try {
    if (!path || !existsSync(path)) return '';
    return readFileSync(path, 'utf-8').toString().trim();
  } catch {
    return '';
  }
}

function writeTextFileBestEffort(path, contents) {
  try {
    if (!path) return;
    writeFileSync(path, String(contents ?? ''), { encoding: 'utf-8' });
  } catch {
    // ignore
  }
}

function writeEnvFileBestEffort(path, env) {
  try {
    if (!path) return;
    const next = stringifyEnvFile(env);
    let prev = '';
    try {
      prev = existsSync(path) ? readFileSync(path, 'utf-8').toString() : '';
    } catch {
      prev = '';
    }
    if (prev !== next) {
      writeFileSync(path, next, { encoding: 'utf-8' });
    }
  } catch {
    // ignore
  }
}

function stacklessIdForRepo({ repoRoot, stacksStorageRoot, createIfMissing }) {
  const oldHash = createHash('sha256').update(String(repoRoot)).digest('hex').slice(0, 10);
  const base = sanitizeStackNameToken(repoRoot.split('/').filter(Boolean).at(-1));
  const oldName = `repo-${base}-${oldHash}`;

  const gitDir = resolveGitDir(repoRoot);
  if (!gitDir) {
    // Best-effort fallback when .git is unavailable (e.g. a tarball checkout).
    // This keeps behavior stable for a given path without creating new local state.
    return oldHash;
  }

  const idPath = gitDir ? join(gitDir, 'happier-stack-stackless-id') : null;
  const existing = readTextFile(idPath);
  if (isHexToken(existing, { minLen: 8 })) {
    return existing.slice(0, 20);
  }

  // Back-compat: if the old stack dir exists, pin the id to the previous hash to keep ports/state stable.
  try {
    const oldDir = join(stacksStorageRoot, oldName);
    if (existsSync(oldDir)) {
      if (createIfMissing) writeTextFileBestEffort(idPath, oldHash);
      return oldHash;
    }
  } catch {
    // ignore
  }

  if (!createIfMissing) {
    // Dry-run / read-only mode: do not create new local state.
    return oldHash;
  }

  // Fresh repo-local stack: generate a persistent id under git metadata (so it survives repo moves).
  const generated = randomBytes(8).toString('hex');
  writeTextFileBestEffort(idPath, generated);
  return generated;
}

function stacklessStackNameForRepo({ repoRoot, stacksStorageRoot, createIfMissing }) {
  const base = sanitizeStackNameToken(repoRoot.split('/').filter(Boolean).at(-1));
  const id = stacklessIdForRepo({ repoRoot, stacksStorageRoot, createIfMissing });
  return `repo-${base}-${id.slice(0, 10)}`;
}

function expandHomePath(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

function resolveStacksStorageRoot(env) {
  const raw = (env.HAPPIER_STACK_STORAGE_DIR ?? '').toString().trim();
  if (raw) return expandHomePath(raw);
  return join(homedir(), '.happier', 'stacks');
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

function main() {
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
      argv = ['tui', 'dev', ...forwarded];
    }
  }

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

  const stacksStorageRoot = resolveStacksStorageRoot(process.env);
  const stacklessName = stacklessStackNameForRepo({
    repoRoot,
    stacksStorageRoot,
    createIfMissing: !dryRun && !isStop,
  });
  const stacklessBaseDir = join(stacksStorageRoot, stacklessName);
  const stacklessRuntimePath = join(stacklessBaseDir, 'stack.runtime.json');
  const runtimeServerPort = readRuntimeServerPort(stacklessRuntimePath);
  const stacklessEnvPath = join(stacklessBaseDir, 'env');
  const stacklessCliHomeDir = join(stacklessBaseDir, 'cli');

  // Convenience:
  // `yarn stop` should stop the repo-local stack without requiring users to know its generated name.
  if (isStop) {
    const forwarded = argv.slice(1);
    argv = ['stack', 'stop', stacklessName, ...forwarded];
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
          // Make stack-owned processes prove ownership (for stop/cleanup) and enable stack commands like `stack auth`.
          HAPPIER_STACK_ENV_FILE: stacklessEnvPath,
          HAPPIER_STACK_CLI_HOME_DIR: stacklessCliHomeDir,
          // Stackless isolation: keep ports away from main/default stack ports by default.
          HAPPIER_STACK_SERVER_PORT_BASE: (process.env.HAPPIER_STACK_SERVER_PORT_BASE ?? '52005').toString(),
          HAPPIER_STACK_SERVER_PORT_RANGE: (process.env.HAPPIER_STACK_SERVER_PORT_RANGE ?? '2000').toString(),
          HAPPIER_STACK_EXPO_DEV_PORT_BASE: (process.env.HAPPIER_STACK_EXPO_DEV_PORT_BASE ?? '18081').toString(),
          HAPPIER_STACK_EXPO_DEV_PORT_RANGE: (process.env.HAPPIER_STACK_EXPO_DEV_PORT_RANGE ?? '2000').toString(),
          // Make Expo's Metro use stable (stack-scoped) port strategy.
          HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: (process.env.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY ?? 'stable').toString(),
          ...(runtimeServerPort ? { HAPPIER_STACK_SERVER_PORT: String(runtimeServerPort) } : {}),
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
    } catch {
      // ignore (best-effort)
    }

    // Treat the repo-local stack as managed by the wrapper: keep a minimal env file in sync.
    // This makes `hstack stack auth <name> ...` and `hstack stack stop <name>` work without requiring manual `stack new`.
    const serverComponent = (effectiveEnv.HAPPIER_STACK_SERVER_COMPONENT ?? 'happier-server-light').toString().trim() || 'happier-server-light';
    writeEnvFileBestEffort(stacklessEnvPath, {
      HAPPIER_STACK_STACK: stacklessName,
      HAPPIER_STACK_REPO_DIR: repoRoot,
      HAPPIER_STACK_SERVER_COMPONENT: serverComponent,
      HAPPIER_STACK_CLI_HOME_DIR: stacklessCliHomeDir,
      HAPPIER_STACK_SERVER_PORT_BASE: effectiveEnv.HAPPIER_STACK_SERVER_PORT_BASE,
      HAPPIER_STACK_SERVER_PORT_RANGE: effectiveEnv.HAPPIER_STACK_SERVER_PORT_RANGE,
      HAPPIER_STACK_EXPO_DEV_PORT_BASE: effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_BASE,
      HAPPIER_STACK_EXPO_DEV_PORT_RANGE: effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_RANGE,
      HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY: effectiveEnv.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY,
      ...(runtimeServerPort ? { HAPPIER_STACK_SERVER_PORT: String(runtimeServerPort) } : {}),
      // Keep the stable active server id explicit so daemons/CLI always scope state/credentials per stack.
      ...(effectiveEnv.HAPPIER_ACTIVE_SERVER_ID ? { HAPPIER_ACTIVE_SERVER_ID: effectiveEnv.HAPPIER_ACTIVE_SERVER_ID } : {}),
    });
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
            HAPPIER_ACTIVE_SERVER_ID: effectiveEnv.HAPPIER_ACTIVE_SERVER_ID,
            HAPPIER_STACK_INVOKED_CWD: effectiveEnv.HAPPIER_STACK_INVOKED_CWD,
          },
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const res = spawnSync(cmd, args, { cwd, env: effectiveEnv, stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

main();
