import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotenv } from './dotenv.mjs';
import { expandHome, getCanonicalHomeEnvPathFromEnv } from '../paths/canonical_home.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './sandbox.mjs';

async function loadEnvFile(path, { override = false, overridePrefix = null } = {}) {
  try {
    const contents = await readFile(path, 'utf-8');
    const parsed = parseDotenv(contents);
    for (const [k, v] of parsed.entries()) {
      const allowOverride = override && (!overridePrefix || k.startsWith(overridePrefix));
      if (allowOverride || process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid env file
  }
}

async function loadEnvFileIgnoringPrefixes(path, { ignorePrefixes = [] } = {}) {
  try {
    const contents = await readFile(path, 'utf-8');
    const parsed = parseDotenv(contents);
    for (const [k, v] of parsed.entries()) {
      if (ignorePrefixes.some((p) => k.startsWith(p))) {
        continue;
      }
      if (process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid env file
  }
}

// Load stack env (optional). This is intentionally lightweight and does not require extra deps.
// This file lives under scripts/utils/env, so repo root is three directories up.
const __envDir = dirname(fileURLToPath(import.meta.url));
const __utilsDir = dirname(__envDir);
const __scriptsDir = dirname(__utilsDir);
const __cliRootDir = dirname(__scriptsDir);

function resolveHomeDir() {
  const fromEnv = (process.env.HAPPIER_STACK_HOME_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return join(homedir(), '.happier-stack');
}

// If HAPPIER_STACK_HOME_DIR isn't set, try the canonical pointer file at <canonicalHomeDir>/.env first.
//
// This allows installs where the "real" home/workspace/runtime are elsewhere, while still
// giving us a stable discovery location for launchd/SwiftBar/minimal shells.
const canonicalEnvPath = getCanonicalHomeEnvPathFromEnv(process.env);
if (!(process.env.HAPPIER_STACK_HOME_DIR ?? '').trim() && existsSync(canonicalEnvPath)) {
  await loadEnvFile(canonicalEnvPath, { override: false });
  await loadEnvFile(canonicalEnvPath, { override: true, overridePrefix: 'HAPPIER_STACK_' });
}

const __homeDir = resolveHomeDir();
process.env.HAPPIER_STACK_HOME_DIR = process.env.HAPPIER_STACK_HOME_DIR ?? __homeDir;

// Prefer canonical home config:
//   ~/.happier-stack/.env
//   ~/.happier-stack/env.local
//
// Additionally: when running from a cloned repo, load <repo>/.env as a *fallback* even if home config exists.
// This helps keep repo-local dev settings (e.g. custom Codex binaries) working without requiring users to
// duplicate them into ~/.happier-stack/env.local.
const homeEnv = join(__homeDir, '.env');
const homeLocal = join(__homeDir, 'env.local');
// In sandbox mode, never load repo env.local (it can contain "real" machine paths/URLs).
// Treat sandbox runs as having home config even if the sandbox home env files don't exist yet.
const hasHomeConfig = isSandboxed() || existsSync(homeEnv) || existsSync(homeLocal);
const repoEnv = join(__cliRootDir, '.env');

// 1) Load defaults first (lowest precedence)
if (hasHomeConfig) {
  await loadEnvFile(homeEnv, { override: false });
  await loadEnvFile(homeLocal, { override: true, overridePrefix: 'HAPPIER_STACK_' });
} else {
  await loadEnvFile(join(__cliRootDir, '.env'), { override: false });
  await loadEnvFile(join(__cliRootDir, 'env.local'), { override: true, overridePrefix: 'HAPPIER_STACK_' });
}

// Repo-local fallback (dev convenience):
// If the repo has a .env, load it without overriding anything already set by the environment or home config.
// Note: we intentionally do NOT load repo env.local here, because env.local is treated as higher-precedence
// overrides and could unexpectedly fight with stack/home configuration when present.
if (hasHomeConfig) {
  // IMPORTANT:
  // When home config exists, do not let repo-local .env set HAPPIER_STACK_* keys.
  // Otherwise a cloned repo's .env can accidentally leak global URLs/ports into every stack.
  await loadEnvFileIgnoringPrefixes(repoEnv, { ignorePrefixes: ['HAPPIER_STACK_'] });
} else {
  await loadEnvFile(repoEnv, { override: false });
}

// If no explicit env file is set, and we're on the default "main" stack, prefer the stack-scoped env file
// if it exists: ~/.happier/stacks/main/env
(() => {
  const stacksEnv = (process.env.HAPPIER_STACK_ENV_FILE ?? '').trim();
  if (stacksEnv) {
    return;
  }
  const stackName = (process.env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
  const stacksStorageRootRaw = (process.env.HAPPIER_STACK_STORAGE_DIR ?? '').trim();
  const stacksStorageRoot = stacksStorageRootRaw ? expandHome(stacksStorageRootRaw) : join(homedir(), '.happier', 'stacks');

  const candidates = [
    join(stacksStorageRoot, stackName, 'env'),
  ];
  const envPath = candidates.find((p) => existsSync(p));
  if (!envPath) return;

  process.env.HAPPIER_STACK_ENV_FILE = envPath;
})();
// 3) Load explicit env file overlay (stack env, or any caller-provided env file) last (highest precedence).
//
// IMPORTANT:
// Stack env files intentionally include some non-prefixed keys (e.g. DATABASE_URL, HAPPIER_SERVER_LIGHT_DATA_DIR)
// that must apply for true per-stack isolation. Do not filter by prefix here.
{
  const stacksEnv = process.env.HAPPIER_STACK_ENV_FILE?.trim() ? process.env.HAPPIER_STACK_ENV_FILE.trim() : '';
  const unique = Array.from(new Set([stacksEnv].filter(Boolean)));
  for (const p of unique) {
    // eslint-disable-next-line no-await-in-loop
    await loadEnvFile(p, { override: true });
  }
}

// Legacy Happy env prefixes are intentionally not supported here.
// If a user still has older prefixes exported from previous installs, scrub them to avoid accidental leakage.
const __legacyPrefixes = ['LOCAL_', 'STACKS_'].map((s) => `HAPPY_${s}`);
for (const k of Object.keys(process.env)) {
  if (__legacyPrefixes.some((p) => k.startsWith(p))) {
    delete process.env[k];
  }
}

// Corepack strictness can prevent running Yarn in subfolders when the repo root is pinned to a different manager.
// We intentionally keep child processes Yarn-friendly, so relax strictness for child processes.
process.env.COREPACK_ENABLE_STRICT = process.env.COREPACK_ENABLE_STRICT ?? '0';
process.env.NPM_CONFIG_PACKAGE_MANAGER_STRICT = process.env.NPM_CONFIG_PACKAGE_MANAGER_STRICT ?? 'false';

// LaunchAgents often run with a very minimal PATH which won't include NVM's bin dir, so child
// processes like `yarn` can look "missing" even though Node is running from NVM.
// Ensure the directory containing this Node binary is on PATH.
(() => {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const nodeBinDir = dirname(process.execPath);
  const want = [nodeBinDir, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin'];
  const next = [...want.filter((p) => p && !current.includes(p)), ...current];
  process.env.PATH = next.join(delimiter);
})();
