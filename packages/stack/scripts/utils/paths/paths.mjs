import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { expandHome } from './canonical_home.mjs';

const PRIMARY_APP_SLUG = 'happier-stack';
const PRIMARY_LABEL_BASE = 'dev.happier.stack';
const PRIMARY_STORAGE_ROOT = join(homedir(), '.happier', 'stacks');
const PRIMARY_HOME_DIR = join(homedir(), '.happier-stack');

// Upstream monorepo layouts (slopus/happy):
//
// Newer (packages/):
// - packages/app     (Happy mobile app)
// - packages/cli     (CLI + daemon)
// - packages/server  (server)
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
      ['packages', 'app', 'package.json'],
      ['packages', 'cli', 'package.json'],
      ['packages', 'server', 'package.json'],
    ],
    subdirByComponent: {
      happy: 'packages/app',
      'happy-cli': 'packages/cli',
      'happy-server': 'packages/server',
      // Server flavors share a single server package in the monorepo.
      'happy-server-light': 'packages/server',
    },
  },
};

function detectHappyMonorepoLayout(monorepoRoot) {
  const root = String(monorepoRoot ?? '').trim();
  if (!root) return '';
  try {
    const hasAll = (markers) => markers.every((m) => existsSync(join(root, ...m)));
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

export function getComponentsDir(rootDir, env = process.env) {
  const workspaceDir = getWorkspaceDir(rootDir, env);
  return join(workspaceDir, 'components');
}

export function getRepoDir(rootDir, env = process.env) {
  const fromEnv = normalizePathForEnv(rootDir, env.HAPPIER_STACK_REPO_DIR, env);
  const workspaceDir = getWorkspaceDir(rootDir, env);
  const fallback = join(workspaceDir, 'happier');

  // Prefer explicitly configured repo dir (if set).
  const candidate = fromEnv || fallback;
  if (!candidate) return fallback;

  // Accept any nested path inside the monorepo (e.g. packages/app) and normalize to a package dir
  // for monorepo-aware components below.
  const root = coerceHappyMonorepoRootFromPath(candidate);
  return root || candidate;
}

export function componentDirEnvKey(name) {
  return `HAPPIER_STACK_COMPONENT_DIR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
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
  // Best-effort fallback: keep a stable mapping even when layout can't be detected.
  return HAPPY_MONOREPO_LAYOUTS.packages.subdirByComponent[n] ?? null;
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
  const fromEnv = normalizePathForEnv(rootDir, env[stacksKey], env);
  const n = String(name ?? '').trim();

  // Monorepo-first default:
  // If a repo dir is configured, derive monorepo component dirs from it instead of relying on
  // workspace/components/<component> (legacy multi-repo layout).
  if (isHappyMonorepoComponentName(n)) {
    const repoRoot = getRepoDir(rootDir, env);
    if (repoRoot && existsSync(repoRoot) && isHappyMonorepoRoot(repoRoot)) {
      const pkg = resolveHappyMonorepoPackageDir({ monorepoRoot: repoRoot, component: n });
      if (pkg) return pkg;
    }
  }

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
