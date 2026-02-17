import { writeFile } from 'node:fs/promises';
import { ensureDir, readTextOrEmpty } from '../utils/fs/ops.mjs';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getRepoDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { stackExistsSync } from '../utils/stack/stacks.mjs';
import { STACK_WRAPPER_PRESERVE_KEYS, scrubHappierStackEnv } from '../utils/env/scrub_env.mjs';
import { applyStackActiveServerScopeEnv } from '../utils/auth/stable_scope_id.mjs';
import { getStackRuntimeStatePath, isPidAlive, readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';

const readExistingEnv = readTextOrEmpty;
const STACK_WRAPPER_CLEAR_UNPREFIXED_KEYS = [
  'HAPPIER_SERVER_URL',
  'HAPPIER_PUBLIC_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
  'HAPPIER_HOME_DIR',
  'APP_ENV',
  'EXPO_UPDATES_CHANNEL',
  'EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV',
  'EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW',
  'EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY',
  // Runtime feature policy knobs should be stack-local; stale values from a prior stack can
  // silently bleed into a newly selected stack and override expected defaults.
  'HAPPIER_FEATURE_POLICY_ENV',
  'HAPPIER_EMBEDDED_POLICY_ENV',
  'HAPPIER_BUILD_FEATURES_ALLOW',
  'HAPPIER_BUILD_FEATURES_DENY',
];

function stringifyEnv(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    const s = String(v);
    if (!s.trim()) continue;
    // Keep it simple: no quoting/escaping beyond this.
    lines.push(`${k}=${s}`);
  }
  return lines.join('\n') + '\n';
}

export function resolveDefaultRepoEnv({ rootDir }) {
  // Stacks are pinned to an explicit repo checkout/worktree.
  //
  // Default: use the workspace clone (<workspace>/happier), regardless of any current
  // one-off repo/worktree selection in the user's environment.
  const repoDir = getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
  return { HAPPIER_STACK_REPO_DIR: repoDir };
}

export async function writeStackEnv({ stackName, env }) {
  const stackDir = resolveStackEnvPath(stackName).baseDir;
  await ensureDir(stackDir);
  const envPath = resolveStackEnvPath(stackName).envPath;
  const next = stringifyEnv(env);
  const existing = await readExistingEnv(envPath);
  if (existing !== next) {
    await writeFile(envPath, next, 'utf-8');
  }
  return envPath;
}

export async function withStackEnv({ stackName, fn, extraEnv = {} }) {
  const envPath = resolveStackEnvPath(stackName).envPath;
  if (!stackExistsSync(stackName)) {
    throw new Error(
      `[stack] stack "${stackName}" does not exist yet.\n` +
      `[stack] Create it first:\n` +
      `  hstack stack new ${stackName}\n` +
      `  # or:\n` +
      `  hstack stack new ${stackName} --interactive\n`
    );
  }
  // IMPORTANT: stack env file should be authoritative. If the user has HAPPIER_STACK_*
  // exported in their shell, it would otherwise "win" because utils/env.mjs only sets
  // env vars if they are missing/empty.
  const cleaned = scrubHappierStackEnv(process.env, {
    keepHappierStackKeys: STACK_WRAPPER_PRESERVE_KEYS,
    clearUnprefixedKeys: STACK_WRAPPER_CLEAR_UNPREFIXED_KEYS,
  });
  const raw = await readExistingEnv(envPath);
  const stackEnv = parseEnvToObject(raw);

  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);

  let env = {
    ...cleaned,
    HAPPIER_STACK_STACK: stackName,
    HAPPIER_STACK_ENV_FILE: envPath,
    // Expose runtime state path so scripts can find it if needed.
    HAPPIER_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
    // Stack env is authoritative by default.
    ...stackEnv,
    // One-shot overrides (e.g. --repo=...) win over stack env file.
    ...extraEnv,
  };
  env = applyStackActiveServerScopeEnv({
    env,
    stackName,
    cliIdentity: (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
  });

  // Runtime-only port overlay (ephemeral stacks): prefer stack.runtime.json ports when the stack
  // is still running, even if the original "owner" process is gone (common during dev restarts).
  const ownerPid = Number(runtimeState?.ownerPid);
  const processes = runtimeState?.processes && typeof runtimeState.processes === 'object' ? runtimeState.processes : {};
  const serverPid = Number(processes.serverPid);
  const expoPid = Number(processes.expoPid);
  const daemonPid = Number(processes.daemonPid);
  const shouldTrustRuntimePorts =
    isPidAlive(ownerPid) ||
    isPidAlive(serverPid) ||
    isPidAlive(expoPid) ||
    isPidAlive(daemonPid);

  if (shouldTrustRuntimePorts) {
    const ports = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
    const applyPort = (suffix, value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      env[`HAPPIER_STACK_${suffix}`] = String(n);
    };
    applyPort('SERVER_PORT', ports.server);
    applyPort('SERVER_BACKEND_PORT', ports.backend);
    applyPort('PG_PORT', ports.pg);
    applyPort('REDIS_PORT', ports.redis);
    applyPort('MINIO_PORT', ports.minio);
    applyPort('MINIO_CONSOLE_PORT', ports.minioConsole);

    // Mark ephemeral mode for downstream helpers (e.g. infra should not persist ports).
    if (runtimeState?.ephemeral) {
      env.HAPPIER_STACK_EPHEMERAL_PORTS = '1';
    }
  }

  return await fn({ env, envPath, stackEnv, runtimeStatePath, runtimeState });
}

export function parseServerComponentFromEnv(env) {
  const v = (env.HAPPIER_STACK_SERVER_COMPONENT ?? '').toString().trim() || 'happier-server-light';
  return v === 'happier-server' ? 'happier-server' : 'happier-server-light';
}

export async function readStackEnvObject(stackName) {
  const envPath = resolveStackEnvPath(stackName).envPath;
  const raw = await readExistingEnv(envPath);
  const env = raw ? parseEnvToObject(raw) : {};
  return { envPath, env };
}

export async function getRuntimePortExtraEnv(stackName) {
  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
  const runtimePort = Number(runtimeState?.ports?.server);
  return Number.isFinite(runtimePort) && runtimePort > 0
    ? {
        // Ephemeral stacks (PR stacks) store their chosen ports in stack.runtime.json, not the env file.
        // Ensure stack-scoped commands that compute URLs don't fall back to 3005 (main default).
        HAPPIER_STACK_SERVER_PORT: String(runtimePort),
      }
    : null;
}
