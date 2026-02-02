import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { expandHome } from './canonical_home.mjs';

const PRIMARY_APP_SLUG = 'happier-stack';
const PRIMARY_LABEL_BASE = 'dev.happier.stack';
const PRIMARY_STORAGE_ROOT = join(homedir(), '.happier', 'stacks');
const PRIMARY_HOME_DIR = join(homedir(), '.happier-stack');

// Happier monorepo layouts (historical + in-flight refactors):
//
// Newer (apps/):
// - apps/ui      (Happier UI)
// - apps/cli     (CLI + daemon)
// - apps/server  (server)
//
// Legacy (packages/):
// - packages/app    (Happier UI)
// - packages/cli    (CLI + daemon)
// - packages/server (server)
const HAPPY_MONOREPO_COMPONENTS = new Set(['happier-ui', 'happier-cli', 'happier-server', 'happier-server-light']);

const HAPPY_MONOREPO_LAYOUTS = {
  apps: {
    id: 'apps',
    // Minimum files that identify this layout.
    markers: [
      ['apps', 'ui', 'package.json'],
      ['apps', 'cli', 'package.json'],
      ['apps', 'server', 'package.json'],
    ],
    subdirByComponent: {
      'happier-ui': 'apps/ui',
      'happier-cli': 'apps/cli',
      'happier-server': 'apps/server',
      // Server flavors share a single server package in the monorepo.
      'happier-server-light': 'apps/server',
    },
  },
  packages: {
    id: 'packages',
    markers: [
      ['packages', 'app', 'package.json'],
      ['packages', 'cli', 'package.json'],
      ['packages', 'server', 'package.json'],
    ],
    subdirByComponent: {
      'happier-ui': 'packages/app',
      'happier-cli': 'packages/cli',
      'happier-server': 'packages/server',
      'happier-server-light': 'packages/server',
    },
  },
};

function detectHappyMonorepoLayout(monorepoRoot) {
  const root = String(monorepoRoot ?? '').trim();
  if (!root) return '';
  try {
    const hasAll = (markers) => markers.every((m) => existsSync(join(root, ...m)));
    if (hasAll(HAPPY_MONOREPO_LAYOUTS.apps.markers)) return HAPPY_MONOREPO_LAYOUTS.apps.id;
    if (hasAll(HAPPY_MONOREPO_LAYOUTS.packages.markers)) return HAPPY_MONOREPO_LAYOUTS.packages.id;
    return '';
  } catch {
    return '';
  }
}

export function getRootDir(importMetaUrl) {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function getHappyStacksHomeDir(env = process.env) {
  const fromEnv = (env.HAPPIER_STACK_HOME_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return PRIMARY_HOME_DIR;
}

export function getWorkspaceDir(cliRootDir = null, env = process.env) {
  const fromEnv = (env.HAPPIER_STACK_WORKSPACE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  const homeDir = getHappyStacksHomeDir();
  return join(homeDir, 'workspace');
}

export function getRepoDir(rootDir, env = process.env) {
  const fromEnv = normalizePathForEnv(rootDir, env.HAPPIER_STACK_REPO_DIR, env);
  const workspaceDir = getWorkspaceDir(rootDir, env);
  const fallback = join(workspaceDir, 'main');

  // Prefer explicitly configured repo dir (if set).
  const candidate = fromEnv || fallback;
  if (!candidate) return fallback;

  // Accept any nested path inside the monorepo (e.g. apps/ui) and normalize to a package dir
  // for monorepo-aware components below.
  const root = coerceHappyMonorepoRootFromPath(candidate);
  return root || candidate;
}

export function getDevRepoDir(rootDir, env = process.env) {
  // The "dev" checkout is a first-class worktree created by `hstack setup --profile=dev`.
  // It is not treated as the default repo dir (that is always <workspace>/main).
  const workspaceDir = getWorkspaceDir(rootDir, env);
  return join(workspaceDir, 'dev');
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
  if (layout === HAPPY_MONOREPO_LAYOUTS.apps.id) {
    return HAPPY_MONOREPO_LAYOUTS.apps.subdirByComponent[n] ?? null;
  }
  if (layout === HAPPY_MONOREPO_LAYOUTS.packages.id) {
    return HAPPY_MONOREPO_LAYOUTS.packages.subdirByComponent[n] ?? null;
  }
  // Best-effort fallback: keep a stable mapping even when layout can't be detected.
  return HAPPY_MONOREPO_LAYOUTS.apps.subdirByComponent[n] ?? HAPPY_MONOREPO_LAYOUTS.packages.subdirByComponent[n] ?? null;
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
  // Happier-only: all services are inside the single monorepo repo root.
  void name;
  return getRepoDir(rootDir, env);
}

export function getComponentDir(rootDir, name, env = process.env) {
  const n = String(name ?? '').trim();

  // Monorepo-only default:
  // If no explicit per-component override is set, always resolve monorepo package dirs from the repo dir
  // (default: <workspace>/main).
  if (isHappyMonorepoComponentName(n)) {
    const repoRoot = getRepoDir(rootDir, env);
    const pkg = resolveHappyMonorepoPackageDir({ monorepoRoot: repoRoot, component: n });
    if (pkg) return pkg;
    return repoRoot;
  }
  // Unknown logical component: resolve to repo root.
  return getRepoDir(rootDir, env);
}

export function getStackName(env = process.env) {
  return env.HAPPIER_STACK_STACK?.trim() ? env.HAPPIER_STACK_STACK.trim() : 'main';
}

export function getStackLabel(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  return name === 'main' ? PRIMARY_LABEL_BASE : `${PRIMARY_LABEL_BASE}.${name}`;
}

export function getStacksStorageRoot(env = process.env) {
  const fromEnv = (env.HAPPIER_STACK_STORAGE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return PRIMARY_STORAGE_ROOT;
}

export function resolveStackBaseDir(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  return { baseDir: join(getStacksStorageRoot(env), name), isLegacy: false };
}

export function resolveStackEnvPath(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  const { baseDir } = resolveStackBaseDir(name, env);
  return { envPath: join(baseDir, 'env'), isLegacy: false, baseDir };
}

export function getDefaultAutostartPaths(env = process.env) {
  const stackName = getStackName(env);
  const { baseDir, isLegacy } = resolveStackBaseDir(stackName, env);
  const logsDir = join(baseDir, 'logs');

  const label = getStackLabel(stackName, env);
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const stdoutPath = join(logsDir, `${PRIMARY_APP_SLUG}.out.log`);
  const stderrPath = join(logsDir, `${PRIMARY_APP_SLUG}.err.log`);

  // Linux (systemd --user) uses the same label convention as LaunchAgents.
  const systemdUnitName = `${label}.service`;
  const systemdUnitPath = join(homedir(), '.config', 'systemd', 'user', systemdUnitName);

  return {
    baseDir,
    logsDir,
    stackName,
    isLegacy,

    label,
    plistPath,
    systemdUnitName,
    systemdUnitPath,
    stdoutPath,
    stderrPath,
  };
}
