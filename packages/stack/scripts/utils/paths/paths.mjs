import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { expandHome } from './canonical_home.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';

const PRIMARY_APP_SLUG = 'happy-stacks';
const LEGACY_APP_SLUG = 'happy-local';
const PRIMARY_LABEL_BASE = 'com.happy.stacks';
const LEGACY_LABEL_BASE = 'com.happy.local';
const PRIMARY_STORAGE_ROOT = join(homedir(), '.happy', 'stacks');
const LEGACY_STORAGE_ROOT = join(homedir(), '.happy', 'local');
const PRIMARY_HOME_DIR = join(homedir(), '.happy-stacks');

// Upstream monorepo layouts (slopus/happy):
//
// Newer (packages/):
// - packages/happy-app     (Happy mobile app)
// - packages/happy-cli     (CLI + daemon)
// - packages/happy-server  (server)
//
// Legacy (split dirs):
// - expo-app/ (Happy UI)
// - cli/      (happy-cli)
// - server/   (happy-server)
//
// We support both so stacks/worktrees can run against older checkouts or branches.
const HAPPY_MONOREPO_COMPONENTS = new Set(['happy', 'happy-cli', 'happy-server', 'happy-server-light']);

const HAPPY_MONOREPO_LAYOUTS = {
  packages: {
    id: 'packages',
    // Minimum files that identify this layout.
    markers: [
      ['packages', 'happy-app', 'package.json'],
      ['packages', 'happy-cli', 'package.json'],
      ['packages', 'happy-server', 'package.json'],
    ],
    subdirByComponent: {
      happy: 'packages/happy-app',
      'happy-cli': 'packages/happy-cli',
      'happy-server': 'packages/happy-server',
      // Server flavors share a single server package in the monorepo.
      'happy-server-light': 'packages/happy-server',
    },
  },
  legacy: {
    id: 'legacy',
    markers: [
      ['expo-app', 'package.json'],
      ['cli', 'package.json'],
      ['server', 'package.json'],
    ],
    subdirByComponent: {
      happy: 'expo-app',
      'happy-cli': 'cli',
      'happy-server': 'server',
      // Server flavors share a single server package in the monorepo.
      'happy-server-light': 'server',
    },
  },
};

function detectHappyMonorepoLayout(monorepoRoot) {
  const root = String(monorepoRoot ?? '').trim();
  if (!root) return '';
  try {
    const hasAll = (markers) => markers.every((m) => existsSync(join(root, ...m)));
    if (hasAll(HAPPY_MONOREPO_LAYOUTS.packages.markers)) return HAPPY_MONOREPO_LAYOUTS.packages.id;
    if (hasAll(HAPPY_MONOREPO_LAYOUTS.legacy.markers)) return HAPPY_MONOREPO_LAYOUTS.legacy.id;
    return '';
  } catch {
    return '';
  }
}

export function getRootDir(importMetaUrl) {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function getHappyStacksHomeDir(env = process.env) {
  const fromEnv = (env.HAPPY_STACKS_HOME_DIR ?? env.HAPPY_LOCAL_HOME_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return PRIMARY_HOME_DIR;
}

export function getWorkspaceDir(cliRootDir = null, env = process.env) {
  const fromEnv = (env.HAPPY_STACKS_WORKSPACE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  const homeDir = getHappyStacksHomeDir();
  const defaultWorkspace = join(homeDir, 'workspace');
  // Prefer the default home workspace if present.
  if (existsSync(defaultWorkspace)) {
    return defaultWorkspace;
  }
  // Back-compat: for cloned-repo usage before init, keep components inside the repo.
  return cliRootDir ? cliRootDir : defaultWorkspace;
}

export function getComponentsDir(rootDir, env = process.env) {
  const workspaceDir = getWorkspaceDir(rootDir, env);
  return join(workspaceDir, 'components');
}

export function componentDirEnvKey(name) {
  return `HAPPY_STACKS_COMPONENT_DIR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function normalizePathForEnv(rootDir, raw, env = process.env) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return '';
  }
  const expanded = expandHome(trimmed);
  // If the path is relative, treat it as relative to the workspace root (default: repo root).
  const workspaceDir = getWorkspaceDir(rootDir, env);
  return expanded.startsWith('/') ? expanded : resolve(workspaceDir, expanded);
}

export function isHappyMonorepoComponentName(name) {
  return HAPPY_MONOREPO_COMPONENTS.has(String(name ?? '').trim());
}

export function happyMonorepoSubdirForComponent(name, { monorepoRoot = '' } = {}) {
  const n = String(name ?? '').trim();
  if (!n || !isHappyMonorepoComponentName(n)) return null;

  const root = String(monorepoRoot ?? '').trim();
  const layout = root ? detectHappyMonorepoLayout(root) : '';
  if (layout === HAPPY_MONOREPO_LAYOUTS.packages.id) {
    return HAPPY_MONOREPO_LAYOUTS.packages.subdirByComponent[n] ?? null;
  }
  if (layout === HAPPY_MONOREPO_LAYOUTS.legacy.id) {
    return HAPPY_MONOREPO_LAYOUTS.legacy.subdirByComponent[n] ?? null;
  }
  // Best-effort fallback: preserve previous behavior when layout is unknown.
  return HAPPY_MONOREPO_LAYOUTS.legacy.subdirByComponent[n] ?? null;
}

export function isHappyMonorepoRoot(dir) {
  const d = String(dir ?? '').trim();
  if (!d) return false;
  return Boolean(detectHappyMonorepoLayout(d));
}

export function coerceHappyMonorepoRootFromPath(path) {
  const p = String(path ?? '').trim();
  if (!p) return null;
  let cur = resolve(p);
  while (true) {
    if (isHappyMonorepoRoot(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function resolveHappyMonorepoPackageDir({ monorepoRoot, component }) {
  const sub = happyMonorepoSubdirForComponent(component, { monorepoRoot });
  if (!sub) return null;
  return join(monorepoRoot, sub);
}

export function getComponentRepoDir(rootDir, name, env = process.env) {
  const componentDir = getComponentDir(rootDir, name, env);
  const n = String(name ?? '').trim();
  if (isHappyMonorepoComponentName(n)) {
    const root = coerceHappyMonorepoRootFromPath(componentDir);
    if (root) return root;
  }
  return componentDir;
}

export function getComponentDir(rootDir, name, env = process.env) {
  const stacksKey = componentDirEnvKey(name);
  const legacyKey = stacksKey.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
  const fromEnv = normalizePathForEnv(rootDir, env[stacksKey] ?? env[legacyKey], env);
  const n = String(name ?? '').trim();

  // If the component is part of the happy monorepo, allow pointing the env var at either:
  // - the monorepo root, OR
  // - the package directory (packages/happy-* or legacy expo-app/cli/server), OR
  // - any path inside those (we normalize to the package dir).
  if (fromEnv && isHappyMonorepoComponentName(n)) {
    const root = coerceHappyMonorepoRootFromPath(fromEnv);
    if (root) {
      const pkg = resolveHappyMonorepoPackageDir({ monorepoRoot: root, component: n });
      return pkg || fromEnv;
    }
    return fromEnv;
  }

  if (fromEnv) return fromEnv;

  const componentsDir = getComponentsDir(rootDir, env);
  const defaultDir = join(componentsDir, n);

  // Unified server flavors:
  // If happy-server-light isn't explicitly configured, allow it to reuse the happy-server checkout
  // when that checkout contains the sqlite schema (new: prisma/sqlite/schema.prisma; legacy: prisma/schema.sqlite.prisma).
  if (n === 'happy-server-light') {
    const fullServerDir = getComponentDir(rootDir, 'happy-server', env);
    try {
      if (
        fullServerDir &&
        (existsSync(join(fullServerDir, 'prisma', 'sqlite', 'schema.prisma')) ||
          existsSync(join(fullServerDir, 'prisma', 'schema.sqlite.prisma')))
      ) {
        return fullServerDir;
      }
    } catch {
      // ignore
    }
  }

  // Monorepo default behavior:
  // - If components/happy is a monorepo checkout, derive all monorepo component dirs from it.
  // - This allows a single checkout at components/happy to satisfy happy, happy-cli, and happy-server.
  if (isHappyMonorepoComponentName(n)) {
    // If the defaultDir is itself a monorepo root (common for "happy"), map to its package dir.
    if (existsSync(defaultDir) && isHappyMonorepoRoot(defaultDir)) {
      return resolveHappyMonorepoPackageDir({ monorepoRoot: defaultDir, component: n }) || defaultDir;
    }
    // If the legacy defaultDir exists (multi-repo), keep it.
    if (existsSync(defaultDir) && existsSync(join(defaultDir, 'package.json'))) {
      return defaultDir;
    }
    // Fallback: derive from the monorepo root at components/happy if present.
    const monorepoRoot = join(componentsDir, 'happy');
    if (existsSync(monorepoRoot) && isHappyMonorepoRoot(monorepoRoot)) {
      return resolveHappyMonorepoPackageDir({ monorepoRoot, component: n }) || defaultDir;
    }
  }

  return defaultDir;
}

export function getStackName(env = process.env) {
  const raw = env.HAPPY_STACKS_STACK?.trim()
    ? env.HAPPY_STACKS_STACK.trim()
    : env.HAPPY_LOCAL_STACK?.trim()
      ? env.HAPPY_LOCAL_STACK.trim()
      : '';
  return raw || 'main';
}

export function getStackLabel(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  return name === 'main' ? PRIMARY_LABEL_BASE : `${PRIMARY_LABEL_BASE}.${name}`;
}

export function getLegacyStackLabel(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  return name === 'main' ? LEGACY_LABEL_BASE : `${LEGACY_LABEL_BASE}.${name}`;
}

export function getStacksStorageRoot(env = process.env) {
  const fromEnv = (env.HAPPY_STACKS_STORAGE_DIR ?? env.HAPPY_LOCAL_STORAGE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return PRIMARY_STORAGE_ROOT;
}

export function getLegacyStorageRoot() {
  return LEGACY_STORAGE_ROOT;
}

export function resolveStackBaseDir(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  const preferredRoot = getStacksStorageRoot(env);
  const newBase = join(preferredRoot, name);
  const legacyBase = name === 'main' ? LEGACY_STORAGE_ROOT : join(LEGACY_STORAGE_ROOT, 'stacks', name);
  const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();

  // Prefer the new layout by default.
  //
  // For non-main stacks, keep legacy layout if the legacy env exists and the new env does not.
  // This avoids breaking existing stacks until `happys stack migrate` is run.
  if (allowLegacy && name !== 'main') {
    const newEnv = join(preferredRoot, name, 'env');
    const legacyEnv = join(LEGACY_STORAGE_ROOT, 'stacks', name, 'env');
    if (!existsSync(newEnv) && existsSync(legacyEnv)) {
      return { baseDir: legacyBase, isLegacy: true };
    }
  }

  return { baseDir: newBase, isLegacy: false };
}

export function resolveStackEnvPath(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  const { baseDir: activeBase, isLegacy } = resolveStackBaseDir(name, env);
  // New layout: ~/.happy/stacks/<name>/env
  const newEnv = join(getStacksStorageRoot(env), name, 'env');
  // Legacy layout: ~/.happy/local/stacks/<name>/env
  const legacyEnv = join(LEGACY_STORAGE_ROOT, 'stacks', name, 'env');
  const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();

  if (existsSync(newEnv)) {
    return { envPath: newEnv, isLegacy: false, baseDir: join(getStacksStorageRoot(env), name) };
  }
  if (allowLegacy && existsSync(legacyEnv)) {
    return { envPath: legacyEnv, isLegacy: true, baseDir: join(LEGACY_STORAGE_ROOT, 'stacks', name) };
  }
  return { envPath: newEnv, isLegacy, baseDir: activeBase };
}

export function getDefaultAutostartPaths(env = process.env) {
  const stackName = getStackName(env);
  const { baseDir, isLegacy } = resolveStackBaseDir(stackName, env);
  const logsDir = join(baseDir, 'logs');

  const primaryLabel = getStackLabel(stackName, env);
  const legacyLabel = getLegacyStackLabel(stackName, env);
  const primaryPlistPath = join(homedir(), 'Library', 'LaunchAgents', `${primaryLabel}.plist`);
  const legacyPlistPath = join(homedir(), 'Library', 'LaunchAgents', `${legacyLabel}.plist`);

  const primaryStdoutPath = join(logsDir, `${PRIMARY_APP_SLUG}.out.log`);
  const primaryStderrPath = join(logsDir, `${PRIMARY_APP_SLUG}.err.log`);
  const legacyStdoutPath = join(logsDir, `${LEGACY_APP_SLUG}.out.log`);
  const legacyStderrPath = join(logsDir, `${LEGACY_APP_SLUG}.err.log`);

  // Best-effort: prefer primary, but fall back to legacy if that's what's installed.
  const hasPrimaryPlist = existsSync(primaryPlistPath);
  const hasLegacyPlist = existsSync(legacyPlistPath);
  const hasPrimaryLogs = existsSync(primaryStdoutPath) || existsSync(primaryStderrPath);
  const hasLegacyLogs = existsSync(legacyStdoutPath) || existsSync(legacyStderrPath);

  const activeLabel = hasPrimaryPlist ? primaryLabel : hasLegacyPlist ? legacyLabel : primaryLabel;
  const activePlistPath = hasPrimaryPlist ? primaryPlistPath : hasLegacyPlist ? legacyPlistPath : primaryPlistPath;
  const stdoutPath = hasPrimaryLogs ? primaryStdoutPath : hasLegacyLogs ? legacyStdoutPath : primaryStdoutPath;
  const stderrPath = hasPrimaryLogs ? primaryStderrPath : hasLegacyLogs ? legacyStderrPath : primaryStderrPath;

  // Linux (systemd --user) uses the same label convention as LaunchAgents.
  const systemdUnitName = `${activeLabel}.service`;
  const systemdUnitPath = join(homedir(), '.config', 'systemd', 'user', systemdUnitName);

  return {
    baseDir,
    logsDir,
    stackName,
    isLegacy,

    // Active (best-effort) for commands like status/logs/start/stop.
    label: activeLabel,
    plistPath: activePlistPath,
    systemdUnitName,
    systemdUnitPath,
    stdoutPath,
    stderrPath,

    // Primary/legacy info (for display + migration).
    primaryLabel,
    legacyLabel,
    primaryPlistPath,
    legacyPlistPath,
    primaryStdoutPath,
    primaryStderrPath,
    legacyStdoutPath,
    legacyStderrPath,
  };
}
