import { writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { ensureDir, readTextOrEmpty } from '../utils/fs/ops.mjs';
import { createEnvFileExclusive, ensureEnvFileUpdated } from '../utils/env/env_file.mjs';
import { parseEnvToObject } from '../utils/env/dotenv.mjs';
import { getWorkspaceDir, resolveStackEnvPath } from '../utils/paths/paths.mjs';
import { stackExistsSync } from '../utils/stack/stacks.mjs';
import {
  STACK_WRAPPER_CLEAR_UNPREFIXED_KEYS,
  STACK_WRAPPER_PRESERVE_KEYS,
  scrubHappierStackEnv,
} from '../utils/env/scrub_env.mjs';
import {
  applyStackActiveServerScopeEnv,
  applyStackDaemonLifecycleScopeEnv,
} from '../utils/auth/stable_scope_id.mjs';
import {
  getStackRuntimeStatePath,
  readStackRuntimeStateFile,
} from '../utils/stack/runtime_state.mjs';
import { readStackRuntimeStateWithDaemonSync } from '../utils/stack/runtime_daemon_state.mjs';
import { checkDaemonState } from '../daemon.mjs';
import { loadDevTargetsConfig, parseDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { resolveRemoteStackStatePaths } from '../utils/dev_targets/remote_commands.mjs';
import { writeJsonAtomic } from '../utils/fs/json.mjs';
import { hasRetainedServerData } from '../utils/dev_targets/retained_server_data.mjs';
import { getServerLightDataDirFromEnvOrDefault } from '../utils/stack/dirs.mjs';
import { assertCanonicalManagedStackName } from '../utils/stack/names.mjs';
import { resolveStackServerEndpoint } from '../utils/server/urls.mjs';

const readExistingEnv = readTextOrEmpty;

const FOREIGN_STACK_CALLER_KEYS = [
  'HAPPIER_STACK_RUNTIME_MODE',
  'HAPPIER_STACK_EXPO_DEV_PORT',
  'HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY',
  'HAPPIER_STACK_EXPO_DEV_PORT_BASE',
  'HAPPIER_STACK_EXPO_DEV_PORT_RANGE',
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
  const workspaceDir = getWorkspaceDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
  const repoDir = join(workspaceDir, 'main');
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

export async function createStackEnv({ stackName, env }) {
  const envPath = resolveStackEnvPath(stackName).envPath;
  const created = await createEnvFileExclusive({ envPath, content: stringifyEnv(env) });
  return { created, envPath };
}

export async function withStackEnv({
  stackName,
  fn,
  extraEnv = {},
  reconcileDaemonRuntimeState = true,
  beforeRuntimeReconcile = null,
}) {
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
  const callerStackName = (process.env.HAPPIER_STACK_STACK ?? '').toString().trim();
  if (callerStackName && callerStackName !== stackName) {
    for (const key of FOREIGN_STACK_CALLER_KEYS) {
      delete cleaned[key];
    }
  }
  const raw = await readExistingEnv(envPath);
  const stackEnv = parseEnvToObject(raw);

  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const initialRuntimeState = await readStackRuntimeStateFile(runtimeStatePath);

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
  env = applyStackDaemonLifecycleScopeEnv({
    env,
    stackName,
    cliIdentity: (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
  });

  if (typeof beforeRuntimeReconcile === 'function') {
    await beforeRuntimeReconcile({ env, envPath, stackEnv, runtimeStatePath, initialRuntimeState });
  }
  const refreshedRuntimeState = await readStackRuntimeStateFile(runtimeStatePath);

  const runtimeEndpoint = await resolveStackServerEndpoint({ env, stackName,
    runtimeState: refreshedRuntimeState, defaultPort: null });
  const runtimeState = reconcileDaemonRuntimeState
    ? await readStackRuntimeStateWithDaemonSync({
        runtimeStatePath,
        cliHomeDir: (env.HAPPIER_STACK_CLI_HOME_DIR ?? join(resolveStackEnvPath(stackName).baseDir, 'cli')).toString(),
        internalServerUrl: runtimeEndpoint.internalServerUrl ?? '',
        env,
      }, {
        checkDaemonStateImpl: checkDaemonState,
      })
    : refreshedRuntimeState;

  // Runtime-only port overlay (ephemeral stacks): prefer stack.runtime.json ports when the stack
  // is still running, even if the original "owner" process is gone (common during dev restarts).
  const { runtimePort: trustedRuntimeServerPort } = await resolveStackServerEndpoint({
    env, stackName, runtimeState, defaultPort: null,
  });

  if (trustedRuntimeServerPort !== null) {
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

export async function configureSharedDatabasePreset({ stackName, sourceStackName, env = process.env }) {
  assertCanonicalManagedStackName(stackName, 'consumer');
  assertCanonicalManagedStackName(sourceStackName, 'shared database source');
  if (stackName === sourceStackName) throw new Error('[shared-db] consumer and source stacks must differ');
  const consumerPath = resolveStackEnvPath(stackName, env);
  const sourcePath = resolveStackEnvPath(sourceStackName, env);
  const consumer = parseEnvToObject(await readExistingEnv(consumerPath.envPath));
  const source = parseEnvToObject(await readExistingEnv(sourcePath.envPath));
  if (!Object.keys(consumer).length || !Object.keys(source).length) throw new Error('[shared-db] both stacks must already exist');
  if (consumer.HAPPIER_DB_PROVIDER !== 'sqlite' || (source.HAPPIER_DB_PROVIDER && source.HAPPIER_DB_PROVIDER !== 'sqlite')) {
    throw new Error('[shared-db] both stacks must use SQLite');
  }
  if (await hasRetainedServerData(getServerLightDataDirFromEnvOrDefault({ stackBaseDir: consumerPath.baseDir, env: consumer }))) {
    throw new Error('[shared-db] preset requires a fresh consumer without retained server data');
  }
  const sourcePlacement = await loadDevTargetsConfig({ stackName: sourceStackName, env });
  const server = sourcePlacement.config.runtimePlacement?.server;
  if (server?.mode !== 'prefer-target') throw new Error('[shared-db] source stack requires explicit server-host placement');
  const target = sourcePlacement.config.targets.find(candidate => candidate.name === server.target);
  if (!target) throw new Error('[shared-db] source server host is not configured');
  const pathApi = target.platform === 'windows' ? win32 : posix;
  if (pathApi.basename(target.cliHomeDir) !== 'cli') throw new Error('[shared-db] source server host requires its canonical stack CLI home');
  const own = await loadDevTargetsConfig({ stackName, env });
  const consumerTarget = { ...target, remoteServerPort: null };
  // A target name is not host identity: the source definition owns this
  // placement even when the consumer already has a same-named target.
  const targets = own.config.targets.length
    ? [...own.config.targets.filter(candidate => candidate.name !== target.name), consumerTarget]
    : sourcePlacement.config.targets.map(candidate => candidate.name === target.name ? consumerTarget : candidate);
  await writeJsonAtomic(own.path, parseDevTargetsConfig({ version: 3,
    targets,
    runtimePlacement: { ...own.config.runtimePlacement, server: { mode: 'prefer-target', target: server.target, fallback: 'error' }, daemon: { mode: 'local' } },
    commandExecution: own.config.commandExecution ?? sourcePlacement.config.commandExecution,
  }));
  await ensureEnvFileUpdated({ envPath: consumerPath.envPath, updates: Object.entries({
    HAPPIER_STACK_SHARED_DB_SOURCE_STACK: sourceStackName,
    HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: resolveRemoteStackStatePaths(target, { stackName: sourceStackName }).stackEnvPath,
    HAPPIER_STACK_RUNTIME_MODE: 'require', HAPPIER_SQLITE_AUTO_MIGRATE: '0', HAPPIER_STACK_MIGRATE_MODE: 'skip', METRICS_ENABLED: 'false',
  }).map(([key, value]) => ({ key, value })) });
  return { ok: true, stackName, sourceStackName, serverTarget: server.target };
}

export async function getRuntimePortExtraEnv(stackName) {
  const { runtimePort } = await resolveStackServerEndpoint({ stackName });

  return runtimePort !== null
    ? {
        // Ephemeral stacks (PR stacks) store their chosen ports in stack.runtime.json, not the env file.
        // Ensure stack-scoped commands that compute URLs don't fall back to 3005 (main default).
        HAPPIER_STACK_SERVER_PORT: String(runtimePort),
      }
    : null;
}
