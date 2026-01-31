import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
// NOTE: random bytes usage centralized in scripts/utils/crypto/tokens.mjs
import { homedir } from 'node:os';
import { ensureDir, readTextIfExists, readTextOrEmpty } from './utils/fs/ops.mjs';

import { parseArgs } from './utils/cli/args.mjs';
import { killProcessTree, run, runCapture } from './utils/proc/proc.mjs';
import {
  componentDirEnvKey,
  coerceHappyMonorepoRootFromPath,
  getComponentDir,
  getComponentsDir,
  getHappyStacksHomeDir,
  getLegacyStorageRoot,
  getRootDir,
  getStacksStorageRoot,
  happyMonorepoSubdirForComponent,
  resolveStackEnvPath,
} from './utils/paths/paths.mjs';
import { isTcpPortFree, listListenPids, pickNextFreeTcpPort } from './utils/net/ports.mjs';
import {
  createWorktree,
  createWorktreeFromBaseWorktree,
  inferRemoteNameForOwner,
  isComponentWorktreePath,
  resolveComponentSpecToDir,
  worktreeSpecFromDir,
} from './utils/git/worktrees.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvFilePruned, ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { listAllStackNames, stackExistsSync } from './utils/stack/stacks.mjs';
import { stopStackWithEnv } from './utils/stack/stop.mjs';
import { writeDevAuthKey } from './utils/auth/dev_key.mjs';
import { startDevServer } from './utils/dev/server.mjs';
import { ensureDevExpoServer } from './utils/dev/expo_dev.mjs';
import { requireDir } from './utils/proc/pm.mjs';
import { waitForHttpOk } from './utils/server/server.mjs';
import { resolveLocalhostHost, preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { bold, cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { banner, bullets, cmd as cmdFmt, kv, sectionTitle } from './utils/ui/layout.mjs';
import { copyFileIfMissing, linkFileIfMissing, writeSecretFileIfMissing } from './utils/auth/files.mjs';
import { getLegacyHappyBaseDir, isLegacyAuthSourceName } from './utils/auth/sources.mjs';
import { resolveAuthSeedFromEnv } from './utils/stack/startup.mjs';
import { getHomeEnvLocalPath } from './utils/env/config.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { resolveHandyMasterSecretFromStack } from './utils/auth/handy_master_secret.mjs';
import { readPinnedServerPortFromEnvFile } from './utils/server/port.mjs';
import { getEnvValue, getEnvValueAny } from './utils/env/values.mjs';
import { sanitizeDnsLabel } from './utils/net/dns.mjs';
import { coercePort, listPortsFromEnvObject, STACK_RESERVED_PORT_KEYS } from './utils/server/port.mjs';
import {
  deleteStackRuntimeStateFile,
  getStackRuntimeStatePath,
  isPidAlive,
  recordStackRuntimeStart,
  readStackRuntimeStateFile,
} from './utils/stack/runtime_state.mjs';
import { killPid } from './utils/expo/expo.mjs';
import { getCliHomeDirFromEnvOrDefault, getServerLightDataDirFromEnvOrDefault } from './utils/stack/dirs.mjs';
import { parseCliIdentityOrThrow, resolveCliHomeDirForIdentity } from './utils/stack/cli_identities.mjs';
import { randomToken } from './utils/crypto/tokens.mjs';
import { killPidOwnedByStack, killProcessGroupOwnedByStack } from './utils/proc/ownership.mjs';
import { sanitizeSlugPart } from './utils/git/refs.mjs';
import { isCursorInstalled, openWorkspaceInEditor, writeStackCodeWorkspace } from './utils/stack/editor_workspace.mjs';
import { readLastLines } from './utils/fs/tail.mjs';
import { defaultStackReleaseIdentity } from './utils/mobile/identifiers.mjs';
import { interactiveEdit, interactiveNew } from './utils/stack/interactive_stack_config.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import { getDaemonEnv, startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { createStepPrinter } from './utils/cli/progress.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';

function stackNameFromArg(positionals, idx) {
  const name = positionals[idx]?.trim() ? positionals[idx].trim() : '';
  return name;
}

function getDefaultPortStart(stackName = null) {
  const raw = process.env.HAPPY_STACKS_STACK_PORT_START?.trim()
    ? process.env.HAPPY_STACKS_STACK_PORT_START.trim()
    : process.env.HAPPY_LOCAL_STACK_PORT_START?.trim()
      ? process.env.HAPPY_LOCAL_STACK_PORT_START.trim()
      : '';
  // Default port strategy:
  // - main historically lives at 3005
  // - non-main stacks should avoid 3005 to reduce accidental collisions/confusion
  const target = (stackName ?? '').toString().trim() || (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || 'main';
  const fallback = target === 'main' ? 3005 : 3009;
  const n = raw ? Number(raw) : fallback;
  return Number.isFinite(n) ? n : fallback;
}

async function isPortFree(port) {
  return await isTcpPortFree(port, { host: '127.0.0.1' });
}

async function pickNextFreePort(startPort, { reservedPorts = new Set() } = {}) {
  try {
    return await pickNextFreeTcpPort(startPort, { reservedPorts, host: '127.0.0.1' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg.replace(/^\[local\]/, '[stack]'));
  }
}

async function readPortFromEnvFile(envPath) {
  return await readPinnedServerPortFromEnvFile(envPath);
}

async function readPortsFromEnvFile(envPath) {
  const raw = await readExistingEnv(envPath);
  if (!raw.trim()) return [];
  const parsed = parseEnvToObject(raw);
  return listPortsFromEnvObject(parsed, STACK_RESERVED_PORT_KEYS);
}

async function collectReservedStackPorts({ excludeStackName = null } = {}) {
  const reserved = new Set();

  const roots = [
    // New layout: ~/.happy/stacks/<name>/env (or overridden via HAPPY_STACKS_STORAGE_DIR)
    getStacksStorageRoot(),
    // Legacy layout: ~/.happy/local/stacks/<name>/env
    join(getLegacyStorageRoot(), 'stacks'),
  ];

  for (const root of roots) {
    let entries = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (excludeStackName && name === excludeStackName) continue;
      const envPath = join(root, name, 'env');
      // eslint-disable-next-line no-await-in-loop
      const ports = await readPortsFromEnvFile(envPath);
      for (const p of ports) reserved.add(p);
    }
  }

  return reserved;
}

// auth file copy/link helpers live in scripts/utils/auth/files.mjs

async function copyAuthFromStackIntoNewStack({
  fromStackName,
  stackName,
  stackEnv,
  serverComponent,
  json,
  requireSourceStackExists,
  linkMode = false,
}) {
  const { secret, source } = await resolveHandyMasterSecretFromStack({
    stackName: fromStackName,
    requireStackExists: requireSourceStackExists,
    allowLegacyAuthSource: !isSandboxed() || sandboxAllowsGlobalSideEffects(),
    allowLegacyMainFallback: !isSandboxed() || sandboxAllowsGlobalSideEffects(),
  });

  const copied = { secret: false, accessKey: false, settings: false, sourceStack: fromStackName };

  if (secret) {
    if (serverComponent === 'happy-server-light') {
      const dataDir = stackEnv.HAPPY_SERVER_LIGHT_DATA_DIR;
      const target = join(dataDir, 'handy-master-secret.txt');
      const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
      copied.secret =
        linkMode && sourcePath && existsSync(sourcePath)
          ? await linkFileIfMissing({ from: sourcePath, to: target })
          : await writeSecretFileIfMissing({ path: target, secret });
    } else if (serverComponent === 'happy-server') {
      const target = stackEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE;
      if (target) {
        const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
        copied.secret =
          linkMode && sourcePath && existsSync(sourcePath)
            ? await linkFileIfMissing({ from: sourcePath, to: target })
            : await writeSecretFileIfMissing({ path: target, secret });
      }
    }
  }

  const legacy = isLegacyAuthSourceName(fromStackName);
  if (legacy && isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    throw new Error(
      '[stack] auth copy-from: legacy auth source is disabled in sandbox mode.\n' +
        'Reason: it reads from ~/.happy (global user state).\n' +
        'If you really want this, set: HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL=1'
    );
  }
  const sourceBaseDir = legacy ? getLegacyHappyBaseDir() : resolveStackEnvPath(fromStackName).baseDir;
  const sourceEnvRaw = legacy ? '' : await readExistingEnv(resolveStackEnvPath(fromStackName).envPath);
  const sourceEnv = parseEnvToObject(sourceEnvRaw);
  const sourceCli = legacy ? join(sourceBaseDir, 'cli') : getCliHomeDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env: sourceEnv });
  const targetCli = stackEnv.HAPPY_STACKS_CLI_HOME_DIR;

  if (linkMode) {
    copied.accessKey = await linkFileIfMissing({ from: join(sourceCli, 'access.key'), to: join(targetCli, 'access.key') });
    copied.settings = await linkFileIfMissing({ from: join(sourceCli, 'settings.json'), to: join(targetCli, 'settings.json') });
  } else {
    copied.accessKey = await copyFileIfMissing({
      from: join(sourceCli, 'access.key'),
      to: join(targetCli, 'access.key'),
      mode: 0o600,
    });
    copied.settings = await copyFileIfMissing({
      from: join(sourceCli, 'settings.json'),
      to: join(targetCli, 'settings.json'),
      mode: 0o600,
    });
  }

  if (!json) {
    const any = copied.secret || copied.accessKey || copied.settings;
    if (any) {
      console.log(`[stack] copied auth from "${fromStackName}" into "${stackName}" (no re-login needed)`);
      if (copied.secret) console.log(`  - master secret: copied (${source || 'unknown source'})`);
      if (copied.accessKey) console.log(`  - cli: copied access.key`);
      if (copied.settings) console.log(`  - cli: copied settings.json`);
    }
  }

  return copied;
}

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

const readExistingEnv = readTextOrEmpty;

function resolveDefaultComponentDirs({ rootDir }) {
  function hasUnifiedLightSchema(serverDir) {
    return (
      existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma')) ||
      existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'))
    );
  }

  function pickDefaultDir(name) {
    const embedded = join(rootDir, 'components', name);
    const workspace = join(getComponentsDir(rootDir), name);
    // CRITICAL:
    // In sandbox mode, never point stacks at the repo's embedded `components/*` checkouts.
    // Sandboxes must use the sandbox workspace clones (HAPPY_STACKS_WORKSPACE_DIR/components/*),
    // otherwise worktrees/branches collide with the user's real machine state.
    return !isSandboxed() && existsSync(embedded) ? embedded : workspace;
  }

  const out = {};

  const happyRoot = pickDefaultDir('happy');
  const monoRoot = existsSync(happyRoot) ? coerceHappyMonorepoRootFromPath(happyRoot) : null;

  if (monoRoot) {
    const subdir = (component) => happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot });
    out.HAPPY_STACKS_COMPONENT_DIR_HAPPY = join(monoRoot, subdir('happy'));
    out.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = join(monoRoot, subdir('happy-cli'));
    const serverDir = join(monoRoot, subdir('happy-server'));
    out.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = serverDir;
    out.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = hasUnifiedLightSchema(serverDir)
      ? serverDir
      : pickDefaultDir('happy-server-light');
    return out;
  }

  // Prefer a single unified happy-server checkout for both flavors when it includes sqlite support.
  const fullServerDir = pickDefaultDir('happy-server');
  const hasUnifiedLight = hasUnifiedLightSchema(fullServerDir);

  out.HAPPY_STACKS_COMPONENT_DIR_HAPPY = pickDefaultDir('happy');
  out.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = pickDefaultDir('happy-cli');
  out.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = fullServerDir;
  out.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = hasUnifiedLight ? fullServerDir : pickDefaultDir('happy-server-light');
  return out;
}

async function writeStackEnv({ stackName, env }) {
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

async function withStackEnv({ stackName, fn, extraEnv = {} }) {
  const envPath = resolveStackEnvPath(stackName).envPath;
  if (!stackExistsSync(stackName)) {
    throw new Error(
      `[stack] stack "${stackName}" does not exist yet.\n` +
      `[stack] Create it first:\n` +
      `  happys stack new ${stackName}\n` +
      `  # or:\n` +
      `  happys stack new ${stackName} --interactive\n`
    );
  }
  // IMPORTANT: stack env file should be authoritative. If the user has HAPPY_STACKS_* / HAPPY_LOCAL_*
  // exported in their shell, it would otherwise "win" because utils/env.mjs only sets
  // env vars if they are missing/empty.
  const cleaned = { ...process.env };
  const keepPrefixed = new Set([
    // Stack/env pointers:
    'HAPPY_LOCAL_ENV_FILE',
    'HAPPY_STACKS_ENV_FILE',
    'HAPPY_LOCAL_STACK',
    'HAPPY_STACKS_STACK',

    // Sandbox detection + policy (must propagate to child processes).
    'HAPPY_STACKS_SANDBOX_DIR',
    'HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL',

    // Sandbox-enforced dirs (without these, sandbox isolation breaks).
    'HAPPY_STACKS_CLI_ROOT_DISABLE',
    'HAPPY_STACKS_CANONICAL_HOME_DIR',
    'HAPPY_STACKS_HOME_DIR',
    'HAPPY_STACKS_WORKSPACE_DIR',
    'HAPPY_STACKS_RUNTIME_DIR',
    'HAPPY_STACKS_STORAGE_DIR',
    // Legacy prefix mirrors:
    'HAPPY_LOCAL_CANONICAL_HOME_DIR',
    'HAPPY_LOCAL_HOME_DIR',
    'HAPPY_LOCAL_WORKSPACE_DIR',
    'HAPPY_LOCAL_RUNTIME_DIR',
    'HAPPY_LOCAL_STORAGE_DIR',

    // Sandbox-safe UX knobs (keep consistent through stack wrappers).
    'HAPPY_STACKS_VERBOSE',
    'HAPPY_STACKS_UPDATE_CHECK',
    'HAPPY_STACKS_UPDATE_CHECK_INTERVAL_MS',
    'HAPPY_STACKS_UPDATE_NOTIFY_INTERVAL_MS',

    // Guided auth flow coordination across wrappers.
    // These are intentionally passed through even though most HAPPY_STACKS_* vars are scrubbed.
    'HAPPY_STACKS_DAEMON_WAIT_FOR_AUTH',
    'HAPPY_LOCAL_DAEMON_WAIT_FOR_AUTH',
    'HAPPY_STACKS_AUTH_FLOW',
    'HAPPY_LOCAL_AUTH_FLOW',

    // Safe global defaults that should apply inside stack wrappers unless overridden by the stack env file.
    // This is important for VM/CI/sandbox environments where users want predictable port ranges without
    // pinning every stack env explicitly.
    'HAPPY_STACKS_STACK_PORT_START',
    'HAPPY_LOCAL_STACK_PORT_START',

    'HAPPY_STACKS_BIND_MODE',
    'HAPPY_LOCAL_BIND_MODE',
    'HAPPY_STACKS_EXPO_HOST',
    'HAPPY_LOCAL_EXPO_HOST',

    // Expo dev-server port strategy (web + dev-client share the same Metro process).
    'HAPPY_STACKS_EXPO_DEV_PORT',
    'HAPPY_LOCAL_EXPO_DEV_PORT',
    'HAPPY_STACKS_EXPO_DEV_PORT_STRATEGY',
    'HAPPY_LOCAL_EXPO_DEV_PORT_STRATEGY',
    'HAPPY_STACKS_EXPO_DEV_PORT_BASE',
    'HAPPY_LOCAL_EXPO_DEV_PORT_BASE',
    'HAPPY_STACKS_EXPO_DEV_PORT_RANGE',
    'HAPPY_LOCAL_EXPO_DEV_PORT_RANGE',

    // Back-compat knobs (older names still accepted by metro_ports.mjs).
    'HAPPY_STACKS_UI_DEV_PORT',
    'HAPPY_LOCAL_UI_DEV_PORT',
    'HAPPY_STACKS_UI_DEV_PORT_BASE',
    'HAPPY_LOCAL_UI_DEV_PORT_BASE',
    'HAPPY_STACKS_UI_DEV_PORT_RANGE',
    'HAPPY_LOCAL_UI_DEV_PORT_RANGE',
    'HAPPY_STACKS_MOBILE_DEV_PORT',
    'HAPPY_LOCAL_MOBILE_DEV_PORT',
    'HAPPY_STACKS_MOBILE_PORT',
    'HAPPY_LOCAL_MOBILE_PORT',
  ]);
  for (const k of Object.keys(cleaned)) {
    if (keepPrefixed.has(k)) continue;
    if (k.startsWith('HAPPY_LOCAL_') || k.startsWith('HAPPY_STACKS_')) {
      delete cleaned[k];
    }
  }
  const raw = await readExistingEnv(envPath);
  const stackEnv = parseEnvToObject(raw);

  // Mirror HAPPY_STACKS_* and HAPPY_LOCAL_* prefixes so callers can use either.
  // (Matches scripts/utils/env.mjs behavior.)
  const applyPrefixMapping = (obj) => {
    const keys = new Set(Object.keys(obj));
    const suffixes = new Set();
    for (const k of keys) {
      if (k.startsWith('HAPPY_STACKS_')) suffixes.add(k.slice('HAPPY_STACKS_'.length));
      if (k.startsWith('HAPPY_LOCAL_')) suffixes.add(k.slice('HAPPY_LOCAL_'.length));
    }
    for (const suffix of suffixes) {
      const stacksKey = `HAPPY_STACKS_${suffix}`;
      const localKey = `HAPPY_LOCAL_${suffix}`;
      const stacksVal = (obj[stacksKey] ?? '').toString().trim();
      const localVal = (obj[localKey] ?? '').toString().trim();
      if (stacksVal) {
        obj[stacksKey] = stacksVal;
        obj[localKey] = stacksVal;
      } else if (localVal) {
        obj[localKey] = localVal;
        obj[stacksKey] = localVal;
      }
    }
  };

  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);

  const env = {
    ...cleaned,
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_ENV_FILE: envPath,
    HAPPY_LOCAL_STACK: stackName,
    HAPPY_LOCAL_ENV_FILE: envPath,
    // Expose runtime state path so scripts can find it if needed.
    HAPPY_STACKS_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPY_LOCAL_RUNTIME_STATE_PATH: runtimeStatePath,
    // Stack env is authoritative by default.
    ...stackEnv,
    // One-shot overrides (e.g. --happy=...) win over stack env file.
    ...extraEnv,
  };
  applyPrefixMapping(env);

  // Runtime-only port overlay (ephemeral stacks): only trust it when the owner pid is still alive.
  const ownerPid = Number(runtimeState?.ownerPid);
  if (isPidAlive(ownerPid)) {
    const ports = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
    const applyPort = (suffix, value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      env[`HAPPY_STACKS_${suffix}`] = String(n);
      env[`HAPPY_LOCAL_${suffix}`] = String(n);
    };
    applyPort('SERVER_PORT', ports.server);
    applyPort('HAPPY_SERVER_BACKEND_PORT', ports.backend);
    applyPort('PG_PORT', ports.pg);
    applyPort('REDIS_PORT', ports.redis);
    applyPort('MINIO_PORT', ports.minio);
    applyPort('MINIO_CONSOLE_PORT', ports.minioConsole);

    // Mark ephemeral mode for downstream helpers (e.g. infra should not persist ports).
    if (runtimeState?.ephemeral) {
      env.HAPPY_STACKS_EPHEMERAL_PORTS = '1';
      env.HAPPY_LOCAL_EPHEMERAL_PORTS = '1';
    }
  }

  return await fn({ env, envPath, stackEnv, runtimeStatePath, runtimeState });
}

async function cmdNew({ rootDir, argv, emit = true }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const json = wantsJson(argv, { flags });
  const copyAuth = !(flags.has('--no-copy-auth') || flags.has('--fresh-auth'));
  const copyAuthFrom =
    (kv.get('--copy-auth-from') ?? '').trim() ||
    (process.env.HAPPY_STACKS_AUTH_SEED_FROM ?? process.env.HAPPY_LOCAL_AUTH_SEED_FROM ?? '').trim() ||
    'main';
  const linkAuth =
    flags.has('--link-auth') ||
    flags.has('--link') ||
    flags.has('--symlink-auth') ||
    (kv.get('--link-auth') ?? '').trim() === '1' ||
    (kv.get('--auth-mode') ?? '').trim() === 'link' ||
    (kv.get('--copy-auth-mode') ?? '').trim() === 'link' ||
    (process.env.HAPPY_STACKS_AUTH_LINK ?? process.env.HAPPY_LOCAL_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPY_STACKS_AUTH_MODE ?? process.env.HAPPY_LOCAL_AUTH_MODE ?? '').toString().trim() === 'link';
  const forcePort = flags.has('--force-port');

  // argv here is already "args after 'new'", so the first positional is the stack name.
  let stackName = stackNameFromArg(positionals, 0);
  const interactive = flags.has('--interactive') || (!stackName && isTty());

  const defaults = {
    stackName,
    port: kv.get('--port')?.trim() ? Number(kv.get('--port')) : null,
    serverComponent: (kv.get('--server') ?? '').trim() || '',
    createRemote: (kv.get('--remote') ?? '').trim() || '',
    components: {
      happy: kv.get('--happy')?.trim() || null,
      'happy-cli': kv.get('--happy-cli')?.trim() || null,
      'happy-server-light': kv.get('--happy-server-light')?.trim() || null,
      'happy-server': kv.get('--happy-server')?.trim() || null,
    },
  };

  let config = defaults;
  if (interactive) {
    config = await withRl((rl) => interactiveNew({ rootDir, rl, defaults }));
  }

  stackName = config.stackName?.trim() ? config.stackName.trim() : '';
  if (!stackName) {
    throw new Error(
      '[stack] usage: happys stack new <name> [--port=NNN] [--server=happy-server|happy-server-light] ' +
        '[--happy=default|<owner/...>|<path>] [--happy-server-light=...] ' +
        '[--copy-auth-from=<stack|legacy>] [--link-auth] [--no-copy-auth] [--interactive] [--force-port]'
    );
  }
  if (stackName === 'main') {
    throw new Error('[stack] stack name \"main\" is reserved (use the default stack without creating it)');
  }

  const serverComponent = (config.serverComponent || 'happy-server-light').trim();
  if (serverComponent !== 'happy-server-light' && serverComponent !== 'happy-server') {
    throw new Error(`[stack] invalid server component: ${serverComponent}`);
  }

  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  // Port strategy:
  // - If --port is provided, we treat it as a pinned port and persist it in the stack env.
  // - Otherwise, ports are ephemeral and chosen at stack start time (stored only in stack.runtime.json).
  let port = config.port;
  if (!Number.isFinite(port) || port <= 0) {
    port = null;
  }
  if (port != null) {
    // If user picked a port explicitly, fail-closed on collisions by default.
    const reservedPorts = await collectReservedStackPorts();
    if (!forcePort && reservedPorts.has(port)) {
      throw new Error(
        `[stack] port ${port} is already reserved by another stack env.\n` +
          `Fix:\n` +
          `- omit --port to use an ephemeral port at start time (recommended)\n` +
          `- or pick a different --port\n` +
          `- or re-run with --force-port (not recommended)\n`
      );
    }
    if (!(await isTcpPortFree(port))) {
      throw new Error(
        `[stack] port ${port} is not free on 127.0.0.1.\n` +
          `Fix:\n` +
          `- omit --port to use an ephemeral port at start time (recommended)\n` +
          `- or stop the process currently using ${port}\n`
      );
    }
  }

  // Always pin component dirs explicitly (so stack env is stable even if repo env changes).
  const defaultComponentDirs = resolveDefaultComponentDirs({ rootDir });

  // Prepare component dirs (may create worktrees).
  const stackEnv = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim() ? config.createRemote.trim() : 'upstream',
    ...defaultComponentDirs,
  };
  if (port != null) {
    stackEnv.HAPPY_STACKS_SERVER_PORT = String(port);
  }

  // Server-light storage isolation: ensure non-main stacks have their own sqlite + local files dir by default.
  // (This prevents a dev stack from mutating main stack's DB when schema changes.)
  if (serverComponent === 'happy-server-light') {
    const dataDir = join(baseDir, 'server-light');
    stackEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    stackEnv.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    stackEnv.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }
  if (serverComponent === 'happy-server') {
    // Persist stable infra credentials in the stack env (ports are ephemeral unless explicitly pinned).
    const pgUser = 'handy';
    const pgPassword = randomToken(24);
    const pgDb = 'handy';
    const s3Bucket = sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
    const s3AccessKey = randomToken(12);
    const s3SecretKey = randomToken(24);

    stackEnv.HAPPY_STACKS_MANAGED_INFRA = stackEnv.HAPPY_STACKS_MANAGED_INFRA ?? '1';
    stackEnv.HAPPY_STACKS_PG_USER = pgUser;
    stackEnv.HAPPY_STACKS_PG_PASSWORD = pgPassword;
    stackEnv.HAPPY_STACKS_PG_DATABASE = pgDb;
    stackEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE = join(baseDir, 'happy-server', 'handy-master-secret.txt');
    stackEnv.S3_ACCESS_KEY = s3AccessKey;
    stackEnv.S3_SECRET_KEY = s3SecretKey;
    stackEnv.S3_BUCKET = s3Bucket;

    // If user explicitly pinned the server port, also pin the rest of the ports + derived URLs for reproducibility.
    if (port != null) {
      const reservedPorts = await collectReservedStackPorts();
      reservedPorts.add(port);
      const backendPort = await pickNextFreePort(port + 10, { reservedPorts });
      reservedPorts.add(backendPort);
      const pgPort = await pickNextFreePort(port + 1000, { reservedPorts });
      reservedPorts.add(pgPort);
      const redisPort = await pickNextFreePort(pgPort + 1, { reservedPorts });
      reservedPorts.add(redisPort);
      const minioPort = await pickNextFreePort(redisPort + 1, { reservedPorts });
      reservedPorts.add(minioPort);
      const minioConsolePort = await pickNextFreePort(minioPort + 1, { reservedPorts });

      const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;
      const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

      stackEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT = String(backendPort);
      stackEnv.HAPPY_STACKS_PG_PORT = String(pgPort);
      stackEnv.HAPPY_STACKS_REDIS_PORT = String(redisPort);
      stackEnv.HAPPY_STACKS_MINIO_PORT = String(minioPort);
      stackEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT = String(minioConsolePort);

      // Vars consumed by happy-server:
      stackEnv.DATABASE_URL = databaseUrl;
      stackEnv.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
      stackEnv.S3_HOST = '127.0.0.1';
      stackEnv.S3_PORT = String(minioPort);
      stackEnv.S3_USE_SSL = 'false';
      stackEnv.S3_PUBLIC_URL = s3PublicUrl;
    }
  }

  let monorepoPinned = false;

  // happy / happy-cli / happy-server can be a single monorepo (slopus/happy).
  // Detect monorepo pinning by resolving the provided spec(s), rather than relying on the local default checkout.
  const monoSpecs = [
    { component: 'happy', spec: config.components.happy },
    { component: 'happy-cli', spec: config.components['happy-cli'] },
    { component: 'happy-server', spec: config.components['happy-server'] },
  ].filter((x) => x.spec);

  if (monoSpecs.length) {
    const primary = monoSpecs[0];
    const canon = (spec) => {
      if (spec && typeof spec === 'object' && spec.create) {
        const remote = String(spec.remote || 'upstream');
        return `create:${String(spec.slug)}@${remote}`;
      }
      return String(spec);
    };

    let resolvedDir = '';
    if (primary.spec && typeof primary.spec === 'object' && primary.spec.create) {
      resolvedDir = await createWorktree({
        rootDir,
        component: primary.component,
        slug: primary.spec.slug,
        remoteName: primary.spec.remote || 'upstream',
      });
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: primary.component, spec: primary.spec });
      if (dir) resolvedDir = resolve(rootDir, dir);
    }

    const monoRoot = resolvedDir ? coerceHappyMonorepoRootFromPath(resolvedDir) : null;
    if (monoRoot) {
      for (const s of monoSpecs.slice(1)) {
        if (canon(s.spec) !== canon(primary.spec)) {
          throw new Error(
            `[stack] conflicting monorepo component specs.\n` +
              `- happy: ${canon(config.components.happy)}\n` +
              `- happy-cli: ${canon(config.components['happy-cli'])}\n` +
              `- happy-server: ${canon(config.components['happy-server'])}\n` +
              `Fix: in monorepo mode, pass only one of --happy/--happy-cli/--happy-server (or pass the same value for all).`
          );
        }
      }

      const subdir = (c) => happyMonorepoSubdirForComponent(c);
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY = join(monoRoot, subdir('happy'));
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = join(monoRoot, subdir('happy-cli'));
      const serverDir = join(monoRoot, subdir('happy-server'));
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = serverDir;
      if (
        existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma')) ||
        existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'))
      ) {
        stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = serverDir;
      }
      monorepoPinned = true;
    }
  }

  if (!monorepoPinned) {
    // happy
    const happySpec = config.components.happy;
    if (happySpec && typeof happySpec === 'object' && happySpec.create) {
      const dir = await createWorktree({ rootDir, component: 'happy', slug: happySpec.slug, remoteName: happySpec.remote || 'upstream' });
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY = dir;
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happy', spec: happySpec });
      if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY = resolve(rootDir, dir);
    }

    // happy-cli
    const cliSpec = config.components['happy-cli'];
    if (cliSpec && typeof cliSpec === 'object' && cliSpec.create) {
      const dir = await createWorktree({ rootDir, component: 'happy-cli', slug: cliSpec.slug, remoteName: cliSpec.remote || 'upstream' });
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = dir;
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-cli', spec: cliSpec });
      if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = resolve(rootDir, dir);
    }
  }

  // Server component directory override (optional)
  if (serverComponent === 'happy-server-light') {
    const spec = config.components['happy-server-light'];
    if (spec && typeof spec === 'object' && spec.create) {
      const dir = await createWorktree({
        rootDir,
        component: 'happy-server-light',
        slug: spec.slug,
        remoteName: spec.remote || 'upstream',
      });
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = dir;
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-server-light', spec });
      if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = resolve(rootDir, dir);
    }
  } else if (serverComponent === 'happy-server') {
    if (!monorepoPinned) {
      const spec = config.components['happy-server'];
      if (spec && typeof spec === 'object' && spec.create) {
        const dir = await createWorktree({ rootDir, component: 'happy-server', slug: spec.slug, remoteName: spec.remote || 'upstream' });
        stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = dir;
      } else {
        const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-server', spec });
        if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = resolve(rootDir, dir);
      }
    }
  }

  if (copyAuth) {
    // Default: inherit seed stack auth so creating a new stack doesn't require re-login.
    // Source: --copy-auth-from (highest), else HAPPY_STACKS_AUTH_SEED_FROM (default: main).
    // Users can opt out with --no-copy-auth to force a fresh auth / machine identity.
    await copyAuthFromStackIntoNewStack({
      fromStackName: copyAuthFrom,
      stackName,
      stackEnv,
      serverComponent,
      json,
      requireSourceStackExists: kv.has('--copy-auth-from'),
      linkMode: linkAuth,
    }).catch((err) => {
      if (!json && emit) {
        console.warn(`[stack] auth copy skipped: ${err instanceof Error ? err.message : String(err)}`);
        console.warn(`[stack] tip: you can always run: happys stack auth ${stackName} login`);
      }
    });
  }

  const envPath = await writeStackEnv({ stackName, env: stackEnv });
  const res = { ok: true, stackName, envPath, port: port ?? null, serverComponent, portsMode: port == null ? 'ephemeral' : 'pinned' };
  if (emit) {
    printResult({
      json,
      data: res,
      text: [
        `[stack] created ${stackName}`,
        `[stack] env: ${envPath}`,
        `[stack] port: ${port == null ? 'ephemeral (picked at start)' : String(port)}`,
        `[stack] server: ${serverComponent}`,
      ].join('\n'),
    });
  }
  return res;
}

async function cmdEdit({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    throw new Error('[stack] usage: happys stack edit <name> [--interactive]');
  }

  const envPath = resolveStackEnvPath(stackName).envPath;
  const raw = await readExistingEnv(envPath);
  const existingEnv = parseEnvToObject(raw);

  const interactive = flags.has('--interactive') || (!flags.has('--no-interactive') && isTty());
  if (!interactive) {
    throw new Error('[stack] edit currently requires --interactive (non-interactive editing not implemented yet).');
  }

  const defaults = {
    stackName,
    port: null,
    serverComponent: '',
    createRemote: '',
    components: {
      happy: null,
      'happy-cli': null,
      'happy-server-light': null,
      'happy-server': null,
    },
  };

  const config = await withRl((rl) => interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults }));

  // Build next env, starting from existing env but enforcing stack-scoped invariants.
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  let port = config.port;
  if (!Number.isFinite(port) || port <= 0) {
    port = null;
  }

  const serverComponent = (config.serverComponent || existingEnv.HAPPY_STACKS_SERVER_COMPONENT || existingEnv.HAPPY_LOCAL_SERVER_COMPONENT || 'happy-server-light').trim();

  const next = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim()
      ? config.createRemote.trim()
      : (existingEnv.HAPPY_STACKS_STACK_REMOTE || existingEnv.HAPPY_LOCAL_STACK_REMOTE || 'upstream'),
    // Always pin defaults; overrides below can replace.
    ...resolveDefaultComponentDirs({ rootDir }),
  };
  if (port != null) {
    next.HAPPY_STACKS_SERVER_PORT = String(port);
  }

  if (serverComponent === 'happy-server-light') {
    const dataDir = join(baseDir, 'server-light');
    next.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    next.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    next.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }
  if (serverComponent === 'happy-server') {
    // Persist stable infra credentials. Ports are ephemeral unless explicitly pinned.
    const pgUser = (existingEnv.HAPPY_STACKS_PG_USER ?? 'handy').trim() || 'handy';
    const pgPassword = (existingEnv.HAPPY_STACKS_PG_PASSWORD ?? '').trim() || randomToken(24);
    const pgDb = (existingEnv.HAPPY_STACKS_PG_DATABASE ?? 'handy').trim() || 'handy';
    const s3Bucket =
      (existingEnv.S3_BUCKET ?? sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' })).trim() ||
      sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
    const s3AccessKey = (existingEnv.S3_ACCESS_KEY ?? '').trim() || randomToken(12);
    const s3SecretKey = (existingEnv.S3_SECRET_KEY ?? '').trim() || randomToken(24);

    next.HAPPY_STACKS_MANAGED_INFRA = (existingEnv.HAPPY_STACKS_MANAGED_INFRA ?? '1').trim() || '1';
    next.HAPPY_STACKS_PG_USER = pgUser;
    next.HAPPY_STACKS_PG_PASSWORD = pgPassword;
    next.HAPPY_STACKS_PG_DATABASE = pgDb;
    next.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE =
      (existingEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE ?? '').trim() || join(baseDir, 'happy-server', 'handy-master-secret.txt');
    next.S3_ACCESS_KEY = s3AccessKey;
    next.S3_SECRET_KEY = s3SecretKey;
    next.S3_BUCKET = s3Bucket;

    if (port != null) {
      // If user pinned the server port, keep ports + derived URLs stable as well.
      const reservedPorts = await collectReservedStackPorts({ excludeStackName: stackName });
      reservedPorts.add(port);
      const backendPort = existingEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT.trim())
        : await pickNextFreePort(port + 10, { reservedPorts });
      reservedPorts.add(backendPort);
      const pgPort = existingEnv.HAPPY_STACKS_PG_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_PG_PORT.trim())
        : await pickNextFreePort(port + 1000, { reservedPorts });
      reservedPorts.add(pgPort);
      const redisPort = existingEnv.HAPPY_STACKS_REDIS_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_REDIS_PORT.trim())
        : await pickNextFreePort(pgPort + 1, { reservedPorts });
      reservedPorts.add(redisPort);
      const minioPort = existingEnv.HAPPY_STACKS_MINIO_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_MINIO_PORT.trim())
        : await pickNextFreePort(redisPort + 1, { reservedPorts });
      reservedPorts.add(minioPort);
      const minioConsolePort = existingEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT.trim())
        : await pickNextFreePort(minioPort + 1, { reservedPorts });

      const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;
      const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

      next.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT = String(backendPort);
      next.HAPPY_STACKS_PG_PORT = String(pgPort);
      next.HAPPY_STACKS_REDIS_PORT = String(redisPort);
      next.HAPPY_STACKS_MINIO_PORT = String(minioPort);
      next.HAPPY_STACKS_MINIO_CONSOLE_PORT = String(minioConsolePort);

      next.DATABASE_URL = databaseUrl;
      next.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
      next.S3_HOST = '127.0.0.1';
      next.S3_PORT = String(minioPort);
      next.S3_USE_SSL = 'false';
      next.S3_PUBLIC_URL = s3PublicUrl;
    }
  }

  // Apply selections (create worktrees if needed)
  const applyComponent = async (component, key, spec) => {
    if (spec && typeof spec === 'object' && spec.create) {
      next[key] = await createWorktree({ rootDir, component, slug: spec.slug, remoteName: spec.remote || next.HAPPY_STACKS_STACK_REMOTE });
      return;
    }
    const dir = resolveComponentSpecToDir({ rootDir, component, spec });
    if (dir) {
      next[key] = resolve(rootDir, dir);
    }
  };

  const existingHappy = String(next.HAPPY_STACKS_COMPONENT_DIR_HAPPY ?? '').trim();
  const happyMonorepo = Boolean(coerceHappyMonorepoRootFromPath(existingHappy)) || Boolean(coerceHappyMonorepoRootFromPath(getComponentDir(rootDir, 'happy', process.env)));

  if (happyMonorepo) {
    const monoSpecs = [
      { component: 'happy', spec: config.components.happy },
      { component: 'happy-cli', spec: config.components['happy-cli'] },
      { component: 'happy-server', spec: config.components['happy-server'] },
    ].filter((x) => x.spec);

    if (monoSpecs.length) {
      const primary = monoSpecs[0];
      const canon = (spec) => {
        if (spec && typeof spec === 'object' && spec.create) {
          const remote = String(spec.remote || 'upstream');
          return `create:${String(spec.slug)}@${remote}`;
        }
        return String(spec);
      };

      let resolvedDir = '';
      if (primary.spec && typeof primary.spec === 'object' && primary.spec.create) {
        resolvedDir = await createWorktree({
          rootDir,
          component: primary.component,
          slug: primary.spec.slug,
          remoteName: primary.spec.remote || next.HAPPY_STACKS_STACK_REMOTE,
        });
      } else {
        const dir = resolveComponentSpecToDir({ rootDir, component: primary.component, spec: primary.spec });
        if (dir) resolvedDir = resolve(rootDir, dir);
      }

      const monoRoot = resolvedDir ? coerceHappyMonorepoRootFromPath(resolvedDir) : null;
      if (monoRoot) {
        for (const s of monoSpecs.slice(1)) {
          if (canon(s.spec) !== canon(primary.spec)) {
            throw new Error(
              `[stack] edit: conflicting monorepo component specs.\n` +
                `- happy: ${canon(config.components.happy)}\n` +
                `- happy-cli: ${canon(config.components['happy-cli'])}\n` +
                `- happy-server: ${canon(config.components['happy-server'])}\n` +
                `Fix: in monorepo mode, pass only one of --happy/--happy-cli/--happy-server (or pass the same value for all).`
            );
          }
        }

        const subdir = (c) => happyMonorepoSubdirForComponent(c);
        next.HAPPY_STACKS_COMPONENT_DIR_HAPPY = join(monoRoot, subdir('happy'));
        next.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = join(monoRoot, subdir('happy-cli'));
        const serverDir = join(monoRoot, subdir('happy-server'));
        next.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = serverDir;
        if (
          existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma')) ||
          existsSync(join(serverDir, 'prisma', 'sqlite', 'schema.prisma'))
        ) {
          next.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = serverDir;
        }
      } else {
        await applyComponent('happy', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY', config.components.happy);
        await applyComponent('happy-cli', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', config.components['happy-cli']);
        await applyComponent('happy-server', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER', config.components['happy-server']);
      }
    } else {
      await applyComponent('happy', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY', config.components.happy);
      await applyComponent('happy-cli', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', config.components['happy-cli']);
      await applyComponent('happy-server', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER', config.components['happy-server']);
    }
  } else {
    await applyComponent('happy', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY', config.components.happy);
    await applyComponent('happy-cli', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', config.components['happy-cli']);
    if (serverComponent === 'happy-server') {
      await applyComponent('happy-server', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER', config.components['happy-server']);
    }
  }

  if (serverComponent === 'happy-server-light') {
    await applyComponent('happy-server-light', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT', config.components['happy-server-light']);
  }

  const wrote = await writeStackEnv({ stackName, env: next });
  printResult({ json, data: { stackName, envPath: wrote, port, serverComponent }, text: `[stack] updated ${stackName}\n[stack] env: ${wrote}` });
}

async function cmdRunScript({ rootDir, stackName, scriptPath, args, extraEnv = {}, background = false }) {
  await withStackEnv({
    stackName,
    extraEnv,
    fn: async ({ env, envPath, stackEnv, runtimeStatePath, runtimeState }) => {
      const isStartLike = scriptPath === 'dev.mjs' || scriptPath === 'run.mjs';
      if (!isStartLike) {
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
        return;
      }

      const wantsRestart = args.includes('--restart');
      const wantsJson = args.includes('--json');
      const pinnedServerPort = Boolean((stackEnv.HAPPY_STACKS_SERVER_PORT ?? '').trim() || (stackEnv.HAPPY_LOCAL_SERVER_PORT ?? '').trim());
      const serverComponent =
        (stackEnv.HAPPY_STACKS_SERVER_COMPONENT ?? stackEnv.HAPPY_LOCAL_SERVER_COMPONENT ?? '').toString().trim() || 'happy-server-light';
      const managedInfra =
        serverComponent === 'happy-server'
          ? ((stackEnv.HAPPY_STACKS_MANAGED_INFRA ?? stackEnv.HAPPY_LOCAL_MANAGED_INFRA ?? '1').toString().trim() !== '0')
          : false;

      // If this is an ephemeral-port stack and it's already running, avoid spawning a second copy.
      const existingOwnerPid = Number(runtimeState?.ownerPid);
      const existingPort = Number(runtimeState?.ports?.server);
      const existingUiPort = Number(runtimeState?.expo?.webPort);
      const existingPorts =
        runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : null;
      const wasRunning = isPidAlive(existingOwnerPid);
      // True restart = there was an active runner for this stack. If the stack is not running,
      // `--restart` should behave like a normal start (allocate new ephemeral ports if needed).
      const isTrueRestart = wantsRestart && wasRunning;

      // Restart semantics (stack mode):
      // - Stop stack-owned processes first (runner, daemon, Expo, etc.)
      // - Never kill arbitrary port listeners
      // - Preserve previous runtime ports in memory so a true restart can reuse them
      if (wantsRestart && !wantsJson) {
        const baseDir = resolveStackEnvPath(stackName).baseDir;
        try {
          await stopStackWithEnv({
            rootDir,
            stackName,
            baseDir,
            env,
            json: false,
            noDocker: false,
            aggressive: false,
            sweepOwned: true,
          });
        } catch {
          // ignore (fail-closed below on port checks)
        }
        await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
      }
      if (wasRunning) {
        if (!wantsRestart) {
          const serverPart = Number.isFinite(existingPort) && existingPort > 0 ? ` server=${existingPort}` : '';
          const uiPart =
            scriptPath === 'dev.mjs' && Number.isFinite(existingUiPort) && existingUiPort > 0 ? ` ui=${existingUiPort}` : '';
          console.log(`[stack] ${stackName}: already running (pid=${existingOwnerPid}${serverPart}${uiPart})`);

          const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          const noBrowser =
            args.includes('--no-browser') ||
            (env.HAPPY_STACKS_NO_BROWSER ?? env.HAPPY_LOCAL_NO_BROWSER ?? '').toString().trim() === '1';
          const openBrowser = isInteractive && !wantsJson && !noBrowser;

          const host = resolveLocalhostHost({ stackMode: true, stackName });
          const uiUrl =
            scriptPath === 'dev.mjs'
              ? Number.isFinite(existingUiPort) && existingUiPort > 0
                ? `http://${host}:${existingUiPort}`
                : null
              : Number.isFinite(existingPort) && existingPort > 0
                ? `http://${host}:${existingPort}`
                : null;

          if (uiUrl) {
            console.log(`[stack] ${stackName}: ui: ${uiUrl}`);
            if (openBrowser) {
              await openUrlInBrowser(uiUrl);
            }
          } else if (scriptPath === 'dev.mjs') {
            console.log(`[stack] ${stackName}: ui: unknown (missing expo.webPort in stack.runtime.json)`);
          }

          // Opt-in: allow starting mobile Metro alongside an already-running stack without restarting the runner.
          // This is important for workflows like re-running `setup-pr` with --mobile after the stack is already up.
          const wantsMobile = args.includes('--mobile') || args.includes('--with-mobile');
          if (wantsMobile) {
            await run(process.execPath, [join(rootDir, 'scripts', 'mobile.mjs'), '--metro'], { cwd: rootDir, env });
          }
          return;
        }
        // Restart: already handled above (stopStackWithEnv is ownership-gated).
      }

      // Ephemeral ports: allocate at start time, store only in runtime state (not in stack env).
      if (!pinnedServerPort) {
        const reserved = await collectReservedStackPorts({ excludeStackName: stackName });

        // Also avoid ports held by other *running* ephemeral stacks.
        const names = await listAllStackNames();
        for (const n of names) {
          if (n === stackName) continue;
          const p = getStackRuntimeStatePath(n);
          // eslint-disable-next-line no-await-in-loop
          const st = await readStackRuntimeStateFile(p);
          const pid = Number(st?.ownerPid);
          if (!isPidAlive(pid)) continue;
          const ports = st?.ports && typeof st.ports === 'object' ? st.ports : {};
          for (const v of Object.values(ports)) {
            const num = Number(v);
            if (Number.isFinite(num) && num > 0) reserved.add(num);
          }
        }

        const startPort = getDefaultPortStart(stackName);
        const ports = {};

        const parsePortOrNull = (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const candidatePorts =
          isTrueRestart && existingPorts
            ? {
                server: parsePortOrNull(existingPorts.server),
                backend: parsePortOrNull(existingPorts.backend),
                pg: parsePortOrNull(existingPorts.pg),
                redis: parsePortOrNull(existingPorts.redis),
                minio: parsePortOrNull(existingPorts.minio),
                minioConsole: parsePortOrNull(existingPorts.minioConsole),
              }
            : null;

        const canReuse =
          candidatePorts &&
          candidatePorts.server &&
          (serverComponent !== 'happy-server' || candidatePorts.backend) &&
          (!managedInfra ||
            (candidatePorts.pg && candidatePorts.redis && candidatePorts.minio && candidatePorts.minioConsole));

        if (canReuse) {
          ports.server = candidatePorts.server;
          if (serverComponent === 'happy-server') {
            ports.backend = candidatePorts.backend;
            if (managedInfra) {
              ports.pg = candidatePorts.pg;
              ports.redis = candidatePorts.redis;
              ports.minio = candidatePorts.minio;
              ports.minioConsole = candidatePorts.minioConsole;
            }
          }

          // Fail-closed if any of the reused ports are unexpectedly occupied (prevents cross-stack collisions).
          const toCheck = Object.values(ports)
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n > 0);
          for (const p of toCheck) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await isTcpPortFree(p))) {
              if (isTrueRestart && !wantsJson) {
                // Try one more safe cleanup of stack-owned processes and re-check.
                const baseDir = resolveStackEnvPath(stackName).baseDir;
                try {
                  await stopStackWithEnv({
                    rootDir,
                    stackName,
                    baseDir,
                    env,
                    json: false,
                    noDocker: false,
                    aggressive: false,
                    sweepOwned: true,
                  });
                } catch {
                  // ignore
                }
                // eslint-disable-next-line no-await-in-loop
                if (await isTcpPortFree(p)) {
                  continue;
                }

                // Last resort: if we can prove the listener is stack-owned, kill it.
                // eslint-disable-next-line no-await-in-loop
                const pids = await listListenPids(p);
                const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
                const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir, env });
                for (const pid of pids) {
                  // eslint-disable-next-line no-await-in-loop
                  await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: `port:${p}`, json: false });
                }
                // eslint-disable-next-line no-await-in-loop
                if (await isTcpPortFree(p)) {
                  continue;
                }
              }
              throw new Error(
                `[stack] ${stackName}: cannot reuse port ${p} on restart (port is not free).\n` +
                  `[stack] Fix: stop the process using it, or re-run without --restart to allocate new ports.`
              );
            }
          }
        } else {
          ports.server = await pickNextFreeTcpPort(startPort, { reservedPorts: reserved });
          reserved.add(ports.server);

          if (serverComponent === 'happy-server') {
            ports.backend = await pickNextFreeTcpPort(ports.server + 10, { reservedPorts: reserved });
            reserved.add(ports.backend);
            if (managedInfra) {
              ports.pg = await pickNextFreeTcpPort(ports.server + 1000, { reservedPorts: reserved });
              reserved.add(ports.pg);
              ports.redis = await pickNextFreeTcpPort(ports.pg + 1, { reservedPorts: reserved });
              reserved.add(ports.redis);
              ports.minio = await pickNextFreeTcpPort(ports.redis + 1, { reservedPorts: reserved });
              reserved.add(ports.minio);
              ports.minioConsole = await pickNextFreeTcpPort(ports.minio + 1, { reservedPorts: reserved });
              reserved.add(ports.minioConsole);
            }
          }
        }

        // Sanity: if somehow the server port is now occupied, fail closed (avoids killPortListeners nuking random processes).
        if (!(await isTcpPortFree(Number(ports.server)))) {
          throw new Error(`[stack] ${stackName}: picked server port ${ports.server} but it is not free`);
        }

        const childEnv = {
          ...env,
          HAPPY_STACKS_EPHEMERAL_PORTS: '1',
          HAPPY_LOCAL_EPHEMERAL_PORTS: '1',
          HAPPY_STACKS_SERVER_PORT: String(ports.server),
          HAPPY_LOCAL_SERVER_PORT: String(ports.server),
          ...(serverComponent === 'happy-server' && ports.backend
            ? {
                HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT: String(ports.backend),
                HAPPY_LOCAL_HAPPY_SERVER_BACKEND_PORT: String(ports.backend),
              }
            : {}),
          ...(managedInfra && ports.pg
            ? {
                HAPPY_STACKS_PG_PORT: String(ports.pg),
                HAPPY_LOCAL_PG_PORT: String(ports.pg),
                HAPPY_STACKS_REDIS_PORT: String(ports.redis),
                HAPPY_LOCAL_REDIS_PORT: String(ports.redis),
                HAPPY_STACKS_MINIO_PORT: String(ports.minio),
                HAPPY_LOCAL_MINIO_PORT: String(ports.minio),
                HAPPY_STACKS_MINIO_CONSOLE_PORT: String(ports.minioConsole),
                HAPPY_LOCAL_MINIO_CONSOLE_PORT: String(ports.minioConsole),
              }
            : {}),
        };

        // Background dev auth flow (automatic):
        // If we're starting `dev.mjs` in background and the stack is not authenticated yet,
        // keep the stack alive for guided login by marking this as an auth-flow so URL resolution
        // fails closed (never opens server port as "UI").
        //
        // IMPORTANT:
        // We must NOT start the daemon before credentials exist in orchestrated flows (setup-pr/review-pr),
        // because the daemon can enter its own auth flow and become stranded (lock held, no machine registration).
        if (background && scriptPath === 'dev.mjs') {
          const startUi = !args.includes('--no-ui') && (env.HAPPY_LOCAL_UI ?? '1').toString().trim() !== '0';
          const startDaemon = !args.includes('--no-daemon') && (env.HAPPY_LOCAL_DAEMON ?? '1').toString().trim() !== '0';
          if (startUi && startDaemon) {
            try {
              const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
              const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir, env });
              const hasCreds = existsSync(join(cliHomeDir, 'access.key'));
              if (!hasCreds) {
                childEnv.HAPPY_STACKS_AUTH_FLOW = '1';
                childEnv.HAPPY_LOCAL_AUTH_FLOW = '1';
              }
            } catch {
              // If we can't resolve CLI home dir, skip auto auth-flow markers (best-effort).
            }
          }
        }

        // Background mode: send runner output to a stack-scoped log file so quiet flows can
        // remain clean while still providing actionable error logs.
        const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
        const logsDir = join(stackBaseDir, 'logs');
        const logPath = join(logsDir, `${scriptPath.replace(/\.mjs$/, '')}.${Date.now()}.log`);
        if (background) {
          await ensureDir(logsDir);
        }

        let logHandle = null;
        let outFd = null;
        if (background) {
          logHandle = await open(logPath, 'a');
          outFd = logHandle.fd;
        }

        // Spawn the runner (long-lived) and record its pid + ports for other stack-scoped commands.
        const child = spawn(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], {
          cwd: rootDir,
          env: childEnv,
          stdio: background ? ['ignore', outFd ?? 'ignore', outFd ?? 'ignore'] : 'inherit',
          shell: false,
          detached: background && process.platform !== 'win32',
        });
        try {
          await logHandle?.close();
        } catch {
          // ignore
        }

        // Record the chosen ports immediately (before the runner finishes booting), so other stack commands
        // can resolve the correct endpoints and `--restart` can reliably reuse the same ports.
        await recordStackRuntimeStart(runtimeStatePath, {
          stackName,
          script: scriptPath,
          ephemeral: true,
          ownerPid: child.pid,
          ports,
          ...(background ? { logs: { runner: logPath } } : {}),
        }).catch(() => {});

        if (background) {
          // Keep stack.runtime.json so stack-scoped stop/restart can manage this runner.
          // This mode is used by higher-level commands that want to run guided auth steps
          // without mixing them into server logs.
          const internalServerUrl = `http://127.0.0.1:${ports.server}`;

          // Fail fast if the runner dies immediately or never exposes HTTP.
          // IMPORTANT: do not treat "some process answered /health" as success unless our runner
          // is still alive. Otherwise, if the chosen port is already in use, the runner can exit
          // and a different stack/process could satisfy the health check (leading to confusing
          // follow-on behavior like auth using the wrong port).
          try {
            let exited = null;
            const exitPromise = new Promise((resolvePromise) => {
              child.once('exit', (code, sig) => {
                exited = { kind: 'exit', code: code ?? 0, sig: sig ?? null };
                resolvePromise(exited);
              });
              child.once('error', (err) => {
                exited = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
                resolvePromise(exited);
              });
            });
            const readyPromise = (async () => {
              const timeoutMsRaw =
                (process.env.HAPPY_STACKS_STACK_BACKGROUND_READY_TIMEOUT_MS ??
                  process.env.HAPPY_LOCAL_STACK_BACKGROUND_READY_TIMEOUT_MS ??
                  '180000')
                  .toString()
                  .trim();
              const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 180_000;
              await waitForHttpOk(`${internalServerUrl}/health`, {
                timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180_000,
                intervalMs: 300,
              });
              return { kind: 'ready' };
            })();

            const first = await Promise.race([exitPromise, readyPromise]);
            if (first.kind !== 'ready') {
              throw new Error(`[stack] ${stackName}: runner exited before becoming ready. log: ${logPath}`);
            }
            // Even if /health responded, ensure our runner is still alive.
            // (Prevents false positives when another process owns the port.)
            if (exited && exited.kind !== 'ready') {
              throw new Error(`[stack] ${stackName}: runner reported ready but exited immediately. log: ${logPath}`);
            }
            if (!isPidAlive(child.pid)) {
              throw new Error(
                `[stack] ${stackName}: runner health check passed, but runner is not running.\n` +
                  `[stack] This usually means the chosen port (${ports.server}) is already in use by another process.\n` +
                  `[stack] log: ${logPath}`
              );
            }
          } catch (e) {
            // Attach some log context so failures are debuggable even when a higher-level
            // command cleans up the sandbox directory afterwards.
            try {
              const tail = await readLastLines(logPath, 160);
              if (tail && e instanceof Error) {
                e.message = `${e.message}\n\n[stack] last runner log lines:\n${tail}`;
              }
            } catch {
              // ignore
            }
            // Best-effort cleanup on boot failure.
            try {
              // We spawned this runner process, so we can safely terminate it without relying
              // on ownership heuristics (which can be unreliable on some platforms due to `ps` truncation).
              if (background && process.platform !== 'win32') {
                try {
                  process.kill(-child.pid, 'SIGTERM');
                } catch {
                  // ignore
                }
              }
              try {
                child.kill('SIGTERM');
              } catch {
                // ignore
              }
            } catch {
              // ignore
            }
            await deleteStackRuntimeStateFile(runtimeStatePath).catch(() => {});
            throw e;
          }

          if (!wantsJson) {
            console.log(`[stack] ${stackName}: logs: ${logPath}`);
          }
          try { child.unref(); } catch { /* ignore */ }
          return;
        }

        let exit = { code: null, sig: null, ok: false };
        try {
          await new Promise((resolvePromise, rejectPromise) => {
            child.on('error', rejectPromise);
            child.on('exit', (code, sig) => {
              exit = { code: code ?? null, sig: sig ?? null, ok: code === 0 };
              if (code === 0) return resolvePromise();
              return rejectPromise(new Error(`stack ${scriptPath} exited (code=${code ?? 'null'}, sig=${sig ?? 'null'})`));
            });
          });
        } finally {
          const cur = await readStackRuntimeStateFile(runtimeStatePath);
          if (Number(cur?.ownerPid) === Number(child.pid)) {
            // Only delete runtime state when we're confident no child processes are left behind.
            // If the runner crashes but a child (server/expo/daemon) stays alive, keeping stack.runtime.json
            // allows `happys stack stop --aggressive` to kill the recorded PIDs safely.
            const processes = cur?.processes && typeof cur.processes === 'object' ? cur.processes : {};
            const anyAlive = Object.values(processes)
              .map((p) => Number(p))
              .some((pid) => Number.isFinite(pid) && pid > 1 && isPidAlive(pid));
            const portRaw = cur?.ports && typeof cur.ports === 'object' ? cur.ports.server : null;
            const port = Number(portRaw);
            const portOccupied =
              Number.isFinite(port) && port > 0 ? !(await isTcpPortFree(port, { host: '127.0.0.1' }).catch(() => true)) : false;

            if (!anyAlive && !portOccupied) {
              await deleteStackRuntimeStateFile(runtimeStatePath);
            } else if (!wantsJson) {
              console.warn(
                `[stack] ${stackName}: preserving ${runtimeStatePath} after runner exit (child processes still alive). ` +
                  `Run: happys stack stop ${stackName} --yes --aggressive`
              );
            }
          }
        }
        return;
      }

      // Pinned port stack: run normally under the pinned env.
      if (background) {
        throw new Error('[stack] --background is only supported for ephemeral-port stacks');
      }
      if (wantsRestart && !wantsJson) {
        const pinnedPort = coercePort(env.HAPPY_STACKS_SERVER_PORT ?? env.HAPPY_LOCAL_SERVER_PORT);
        if (pinnedPort && !(await isTcpPortFree(pinnedPort))) {
          // Last resort: kill listener only if it is stack-owned.
          const pids = await listListenPids(pinnedPort);
          const stackBaseDir = resolveStackEnvPath(stackName).baseDir;
          const cliHomeDir = getCliHomeDirFromEnvOrDefault({ stackBaseDir, env });
          for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            await killProcessGroupOwnedByStack(pid, { stackName, envPath, cliHomeDir, label: `port:${pinnedPort}`, json: false });
          }
          if (!(await isTcpPortFree(pinnedPort))) {
            throw new Error(
              `[stack] ${stackName}: server port ${pinnedPort} is not free on restart.\n` +
                `[stack] Refusing to kill unknown listeners. Stop the process using it, or change the pinned port.`
            );
          }
        }
      }
      await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
    },
  });
}

function resolveTransientComponentOverrides({ rootDir, kv }) {
  const overrides = {};
  const specs = [
    { flag: '--happy', component: 'happy', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY' },
    { flag: '--happy-cli', component: 'happy-cli', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI' },
    { flag: '--happy-server-light', component: 'happy-server-light', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT' },
    { flag: '--happy-server', component: 'happy-server', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER' },
  ];

  for (const { flag, component, envKey } of specs) {
    const spec = (kv.get(flag) ?? '').trim();
    if (!spec) {
      continue;
    }
    const dir = resolveComponentSpecToDir({ rootDir, component, spec });
    if (dir) {
      overrides[envKey] = dir;
    }
  }

  if (Object.keys(overrides).length > 0) {
    // Mark these as transient so scripts/utils/env.mjs won't clobber them when it loads the stack env file.
    overrides.HAPPY_STACKS_TRANSIENT_COMPONENT_OVERRIDES = '1';
    overrides.HAPPY_LOCAL_TRANSIENT_COMPONENT_OVERRIDES = '1';
  }

  return overrides;
}

async function cmdService({ rootDir, stackName, svcCmd }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'service.mjs'), svcCmd], { cwd: rootDir, env });
    },
  });
}

async function getRuntimePortExtraEnv(stackName) {
  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);
  const runtimePort = Number(runtimeState?.ports?.server);
  return Number.isFinite(runtimePort) && runtimePort > 0
    ? {
        // Ephemeral stacks (PR stacks) store their chosen ports in stack.runtime.json, not the env file.
        // Ensure stack-scoped commands that compute URLs don't fall back to 3005 (main default).
        HAPPY_STACKS_SERVER_PORT: String(runtimePort),
        HAPPY_LOCAL_SERVER_PORT: String(runtimePort),
      }
    : null;
}

async function cmdTailscale({ rootDir, stackName, subcmd, args }) {
  const extraEnv = await getRuntimePortExtraEnv(stackName);
  await withStackEnv({
    stackName,
    ...(extraEnv ? { extraEnv } : {}),
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'tailscale.mjs'), subcmd, ...args], { cwd: rootDir, env });
    },
  });
}

async function cmdSrv({ rootDir, stackName, args }) {
  // Forward to scripts/server_flavor.mjs under the stack env.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'server_flavor.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdWt({ rootDir, stackName, args }) {
  // Forward to scripts/worktrees.mjs under the stack env.
  // This makes `happys stack wt <name> -- ...` behave exactly like `happys wt ...`,
  // but read/write the stack env file (HAPPY_STACKS_ENV_FILE / legacy: HAPPY_LOCAL_ENV_FILE) instead of repo env.local.
  let forwarded = args[0] === '--' ? args.slice(1) : args;

  // Stack users usually want to see what *this stack* is using (active checkout),
  // not an exhaustive enumeration of every worktree on disk.
  //
  // `happys wt list` defaults to showing all worktrees. In stack mode, default to
  // an active-only view unless the caller opts into `--all`.
  if (forwarded[0] === 'list') {
    const wantsAll = forwarded.includes('--all') || forwarded.includes('--all-worktrees');
    const wantsActive = forwarded.includes('--active') || forwarded.includes('--active-only');
    if (!wantsAll && !wantsActive) {
      forwarded = [...forwarded, '--active'];
    }
  }

  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdAuth({ rootDir, stackName, args }) {
  // Forward to scripts/auth.mjs under the stack env.
  // This makes `happys stack auth <name> ...` resolve CLI home/urls for that stack.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  const extraEnv = await getRuntimePortExtraEnv(stackName);
  await withStackEnv({
    stackName,
    ...(extraEnv ? { extraEnv } : {}),
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdMigrate({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const legacyDir = join(getLegacyStorageRoot(), 'stacks');
  const newRoot = getStacksStorageRoot();

  const migrated = [];
  const skipped = [];
  const missing = [];

  let entries = [];
  try {
    entries = await readdir(legacyDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  if (!entries.length) {
    printResult({
      json,
      data: { ok: true, migrated, skipped, missing, legacyDir, newRoot },
      text: `[stack] no legacy stacks found at ${legacyDir}`,
    });
    return;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const legacyEnv = join(legacyDir, name, 'env');
    const targetEnv = join(newRoot, name, 'env');

    const raw = await readExistingEnv(legacyEnv);
    if (!raw.trim()) {
      missing.push({ name, legacyEnv });
      continue;
    }

    const existingTarget = await readExistingEnv(targetEnv);
    if (existingTarget.trim()) {
      skipped.push({ name, targetEnv });
      continue;
    }

    await ensureDir(join(newRoot, name));
    await writeFile(targetEnv, raw, 'utf-8');
    migrated.push({ name, targetEnv });
  }

  printResult({
    json,
    data: { ok: true, migrated, skipped, missing, legacyDir, newRoot },
    text: [
      `[stack] migrate complete`,
      `[stack] legacy: ${legacyDir}`,
      `[stack] new: ${newRoot}`,
      migrated.length ? `[stack] migrated: ${migrated.length}` : `[stack] migrated: none`,
      skipped.length ? `[stack] skipped (already exists): ${skipped.length}` : null,
      missing.length ? `[stack] skipped (missing env): ${missing.length}` : null,
      '',
      `Next steps:`,
      `- Re-run stacks normally (they'll prefer ${newRoot})`,
      `- If you use autostart: re-install to get the new label/paths: happys service install`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function cmdListStacks() {
  try {
    const names = (await listAllStackNames()).filter((n) => n !== 'main');
    if (!names.length) {
      console.log('[stack] no stacks found');
      return;
    }
    console.log('[stack] stacks:');
    for (const n of names) {
      console.log(`- ${n}`);
    }
  } catch {
    console.log('[stack] no stacks found');
  }
}

async function cmdAudit({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const fix = flags.has('--fix');
  const fixMain = flags.has('--fix-main');
  const fixPorts = flags.has('--fix-ports');
  const fixWorkspace = flags.has('--fix-workspace');
  const fixPaths = flags.has('--fix-paths');
  const unpinPorts = flags.has('--unpin-ports');
  const unpinPortsExceptRaw = (kv.get('--unpin-ports-except') ?? '').trim();
  const unpinPortsExcept = new Set(
    unpinPortsExceptRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const wantsEnvRepair = Boolean(fix || fixWorkspace || fixPaths);

  const stacks = await listAllStackNames();

  const report = [];
  const ports = new Map(); // port -> [stackName]
  const otherWorkspaceRoot = join(getHappyStacksHomeDir(), 'workspace');

  for (const stackName of stacks) {
    const resolved = resolveStackEnvPath(stackName);
    const envPath = resolved.envPath;
    const baseDir = resolved.baseDir;

    let raw = await readExistingEnv(envPath);
    let env = parseEnvToObject(raw);

    // If the env file is missing/empty, optionally reconstruct a safe baseline env.
    if (!raw.trim() && wantsEnvRepair && (stackName !== 'main' || fixMain)) {
      const serverComponent =
        getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') ||
        getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') ||
        'happy-server-light';
      const expectedUi = join(baseDir, 'ui');
      const expectedCli = join(baseDir, 'cli');
      // Port strategy: main is pinned by convention; non-main stacks default to ephemeral ports.
      const reservedPorts = stackName === 'main' ? await collectReservedStackPorts({ excludeStackName: stackName }) : new Set();
      const port = stackName === 'main' ? await pickNextFreePort(getDefaultPortStart(), { reservedPorts }) : null;

      const nextEnv = {
        HAPPY_STACKS_STACK: stackName,
        HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
        HAPPY_STACKS_UI_BUILD_DIR: expectedUi,
        HAPPY_STACKS_CLI_HOME_DIR: expectedCli,
        HAPPY_STACKS_STACK_REMOTE: 'upstream',
        ...resolveDefaultComponentDirs({ rootDir }),
      };
      if (port != null) {
        nextEnv.HAPPY_STACKS_SERVER_PORT = String(port);
      }

      if (serverComponent === 'happy-server-light') {
        const dataDir = join(baseDir, 'server-light');
        nextEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
        nextEnv.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
        nextEnv.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
      }

      await writeStackEnv({ stackName, env: nextEnv });
      raw = await readExistingEnv(envPath);
      env = parseEnvToObject(raw);
    }

    // Optional: unpin ports for non-main stacks (ephemeral port model).
    if (unpinPorts && stackName !== 'main' && !unpinPortsExcept.has(stackName) && raw.trim()) {
      const serverComponentTmp =
        getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') || 'happy-server-light';
      const remove = [
        // Always remove pinned public server port.
        'HAPPY_STACKS_SERVER_PORT',
        'HAPPY_LOCAL_SERVER_PORT',
        // Happy-server gateway/backend ports.
        'HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT',
        'HAPPY_LOCAL_HAPPY_SERVER_BACKEND_PORT',
        // Managed infra ports.
        'HAPPY_STACKS_PG_PORT',
        'HAPPY_LOCAL_PG_PORT',
        'HAPPY_STACKS_REDIS_PORT',
        'HAPPY_LOCAL_REDIS_PORT',
        'HAPPY_STACKS_MINIO_PORT',
        'HAPPY_LOCAL_MINIO_PORT',
        'HAPPY_STACKS_MINIO_CONSOLE_PORT',
        'HAPPY_LOCAL_MINIO_CONSOLE_PORT',
      ];
      if (serverComponentTmp === 'happy-server') {
        // These are derived from the ports above; safe to re-compute at start time.
        remove.push('DATABASE_URL', 'REDIS_URL', 'S3_PORT', 'S3_PUBLIC_URL');
      }
      await ensureEnvFilePruned({ envPath, removeKeys: remove });
      raw = await readExistingEnv(envPath);
      env = parseEnvToObject(raw);
    }

    const serverComponent = getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') || 'happy-server-light';
    const portRaw = getEnvValue(env, 'HAPPY_STACKS_SERVER_PORT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_PORT');
    const port = portRaw ? Number(portRaw) : null;
    if (Number.isFinite(port) && port > 0) {
      const existing = ports.get(port) ?? [];
      existing.push(stackName);
      ports.set(port, existing);
    }

    const issues = [];

    if (!raw.trim()) {
      issues.push({ code: 'missing_env', message: `env file missing/empty (${envPath})` });
    }

    const stacksUi = getEnvValue(env, 'HAPPY_STACKS_UI_BUILD_DIR');
    const localUi = getEnvValue(env, 'HAPPY_LOCAL_UI_BUILD_DIR');
    const uiBuildDir = stacksUi || localUi;
    const expectedUi = join(baseDir, 'ui');
    if (!uiBuildDir) {
      issues.push({ code: 'missing_ui_build_dir', message: `missing UI build dir (expected ${expectedUi})` });
    } else if (uiBuildDir !== expectedUi) {
      issues.push({ code: 'ui_build_dir_mismatch', message: `UI build dir points to ${uiBuildDir} (expected ${expectedUi})` });
    }

    const stacksCli = getEnvValue(env, 'HAPPY_STACKS_CLI_HOME_DIR');
    const localCli = getEnvValue(env, 'HAPPY_LOCAL_CLI_HOME_DIR');
    const cliHomeDir = stacksCli || localCli;
    const expectedCli = join(baseDir, 'cli');
    if (!cliHomeDir) {
      issues.push({ code: 'missing_cli_home_dir', message: `missing CLI home dir (expected ${expectedCli})` });
    } else if (cliHomeDir !== expectedCli) {
      issues.push({ code: 'cli_home_dir_mismatch', message: `CLI home dir points to ${cliHomeDir} (expected ${expectedCli})` });
    }

    // Component dirs: require at least server component dir + happy-cli (otherwise stacks can accidentally fall back to some other workspace).
    const requiredComponents = [
      'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI',
      serverComponent === 'happy-server' ? 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER' : 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT',
    ];
    const missingComponentKeys = [];
    for (const k of requiredComponents) {
      const legacyKey = k.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
      if (!getEnvValue(env, k) && !getEnvValue(env, legacyKey)) {
        missingComponentKeys.push(k);
        issues.push({ code: 'missing_component_dir', message: `missing ${k} (or ${legacyKey})` });
      }
    }

    // Workspace/component dir hygiene checks (best-effort).
    const componentDirKeys = [
      { component: 'happy', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY' },
      { component: 'happy-cli', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI' },
      { component: 'happy-server-light', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT' },
      { component: 'happy-server', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER' },
    ];
    for (const { component, key } of componentDirKeys) {
      const legacyKey = key.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
      const v = getEnvValue(env, key) || getEnvValue(env, legacyKey);
      if (!v) continue;
      if (!isAbsolute(v)) {
        issues.push({ code: 'relative_component_dir', message: `${key} is relative (${v}); prefer absolute paths under this workspace` });
        continue;
      }
      const norm = v.replaceAll('\\', '/');
      if (norm.startsWith(otherWorkspaceRoot.replaceAll('\\', '/') + '/')) {
        issues.push({ code: 'foreign_workspace_component_dir', message: `${key} points to another workspace: ${v}` });
        continue;
      }
      const rootNorm = resolve(rootDir).replaceAll('\\', '/') + '/';
      if (norm.includes('/components/') && !norm.startsWith(rootNorm)) {
        issues.push({ code: 'external_component_dir', message: `${key} points outside current workspace: ${v}` });
      }
      // Optional: fail-closed existence check.
      if (!existsSync(v)) {
        issues.push({ code: 'missing_component_path', message: `${key} path does not exist: ${v}` });
      }
    }

    // Server-light DB/files isolation.
    const isServerLight = serverComponent === 'happy-server-light';
    if (isServerLight) {
      const dataDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_DATA_DIR');
      const filesDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_FILES_DIR');
      const dbUrl = getEnvValue(env, 'DATABASE_URL');
      const expectedDataDir = join(baseDir, 'server-light');
      const expectedFilesDir = join(expectedDataDir, 'files');
      const expectedDbUrl = `file:${join(expectedDataDir, 'happy-server-light.sqlite')}`;

      if (!dataDir) issues.push({ code: 'missing_server_light_data_dir', message: `missing HAPPY_SERVER_LIGHT_DATA_DIR (expected ${expectedDataDir})` });
      if (!filesDir) issues.push({ code: 'missing_server_light_files_dir', message: `missing HAPPY_SERVER_LIGHT_FILES_DIR (expected ${expectedFilesDir})` });
      if (!dbUrl) issues.push({ code: 'missing_database_url', message: `missing DATABASE_URL (expected ${expectedDbUrl})` });
      if (dataDir && dataDir !== expectedDataDir) issues.push({ code: 'server_light_data_dir_mismatch', message: `HAPPY_SERVER_LIGHT_DATA_DIR=${dataDir} (expected ${expectedDataDir})` });
      if (filesDir && filesDir !== expectedFilesDir) issues.push({ code: 'server_light_files_dir_mismatch', message: `HAPPY_SERVER_LIGHT_FILES_DIR=${filesDir} (expected ${expectedFilesDir})` });
      if (dbUrl && dbUrl !== expectedDbUrl) issues.push({ code: 'database_url_mismatch', message: `DATABASE_URL=${dbUrl} (expected ${expectedDbUrl})` });

    }

    // Best-effort env repair (opt-in; non-main stacks only by default).
    if ((fix || fixWorkspace || fixPaths) && (stackName !== 'main' || fixMain) && raw.trim()) {
      const updates = [];

      // Always ensure stack directories are explicitly pinned when missing.
      if (!stacksUi && !localUi) updates.push({ key: 'HAPPY_STACKS_UI_BUILD_DIR', value: expectedUi });
      if (!stacksCli && !localCli) updates.push({ key: 'HAPPY_STACKS_CLI_HOME_DIR', value: expectedCli });
      if (fixPaths) {
        if (uiBuildDir && uiBuildDir !== expectedUi) updates.push({ key: 'HAPPY_STACKS_UI_BUILD_DIR', value: expectedUi });
        if (cliHomeDir && cliHomeDir !== expectedCli) updates.push({ key: 'HAPPY_STACKS_CLI_HOME_DIR', value: expectedCli });
      }

      // Pin component dirs if missing (best-effort).
      if (missingComponentKeys.length) {
        const defaults = resolveDefaultComponentDirs({ rootDir });
        for (const k of missingComponentKeys) {
          if (defaults[k]) {
            updates.push({ key: k, value: defaults[k] });
          }
        }
      }

      // Server-light storage isolation.
      if (isServerLight) {
        const dataDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_DATA_DIR');
        const filesDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_FILES_DIR');
        const dbUrl = getEnvValue(env, 'DATABASE_URL');
        const expectedDataDir = join(baseDir, 'server-light');
        const expectedFilesDir = join(expectedDataDir, 'files');
        const expectedDbUrl = `file:${join(expectedDataDir, 'happy-server-light.sqlite')}`;
        if (!dataDir || (fixPaths && dataDir !== expectedDataDir)) updates.push({ key: 'HAPPY_SERVER_LIGHT_DATA_DIR', value: expectedDataDir });
        if (!filesDir || (fixPaths && filesDir !== expectedFilesDir)) updates.push({ key: 'HAPPY_SERVER_LIGHT_FILES_DIR', value: expectedFilesDir });
        if (!dbUrl || (fixPaths && dbUrl !== expectedDbUrl)) updates.push({ key: 'DATABASE_URL', value: expectedDbUrl });
      }

      if (fixWorkspace) {
        const otherNorm = otherWorkspaceRoot.replaceAll('\\', '/') + '/';
        for (const { component, key } of componentDirKeys) {
          const legacyKey = key.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
          const current = getEnvValue(env, key) || getEnvValue(env, legacyKey);
          if (!current) continue;

          let next = current;
          if (!isAbsolute(next) && next.startsWith('components/')) {
            next = resolve(rootDir, next);
          }
          const norm = next.replaceAll('\\', '/');
          if (norm.startsWith(otherNorm)) {
            // Map any path under ~/.happy-stacks/workspace/... back into this repo root.
            const rel = norm.slice(otherNorm.length);
            const candidate = resolve(rootDir, rel);
            if (existsSync(candidate)) {
              next = candidate;
            } else if (rel.includes('/components/.worktrees/')) {
              // Attempt to recreate the referenced worktree inside this workspace.
              const marker = '/components/.worktrees/';
              const idx = rel.indexOf(marker);
              const rest = rel.slice(idx + marker.length); // <component>/<owner>/<slug...>
              const parts = rest.split('/').filter(Boolean);
              if (parts.length >= 3) {
                const comp = parts[0];
                const owner = parts[1];
                const slug = parts.slice(2).join('/');
                const remoteName = owner === 'slopus' ? 'upstream' : 'origin';
                try {
                  // eslint-disable-next-line no-await-in-loop
                  next = await createWorktree({ rootDir, component: comp, slug, remoteName });
                } catch {
                  // Fall back to candidate path (even if missing) and let other checks surface it.
                  next = candidate;
                }
              } else {
                next = candidate;
              }
            } else {
              next = candidate;
            }
          }

          if (next !== current) {
            updates.push({ key, value: next });
          }
        }
      }

      if (updates.length) {
        await ensureEnvFileUpdated({ envPath, updates });
      }
    }

    report.push({
      stackName,
      envPath,
      baseDir,
      serverComponent,
      serverPort: Number.isFinite(port) ? port : null,
      uiBuildDir: uiBuildDir || null,
      cliHomeDir: cliHomeDir || null,
      issues,
    });
  }

  // Port collisions (post-pass)
  const collisions = [];
  for (const [port, names] of ports.entries()) {
    if (names.length <= 1) continue;
    collisions.push({ port, names: Array.from(names) });
  }

  // Optional: fix collisions by reassigning ports (non-main stacks only by default).
  if (fixPorts) {
    const allowMain = Boolean(fixMain);
    const planned = await collectReservedStackPorts();
    const byName = new Map(report.map((r) => [r.stackName, r]));

    const parsePg = (url) => {
      try {
        const u = new URL(url);
        const db = u.pathname?.replace(/^\//, '') || '';
        return {
          user: decodeURIComponent(u.username || ''),
          password: decodeURIComponent(u.password || ''),
          db,
          host: u.hostname || '127.0.0.1',
        };
      } catch {
        return null;
      }
    };

    for (const c of collisions) {
      const names = c.names.slice().sort();
      // Keep the first stack stable; reassign others to reduce churn.
      const keep = names[0];
      for (const stackName of names.slice(1)) {
        if (stackName === 'main' && !allowMain) {
          continue;
        }
        const entry = byName.get(stackName);
        if (!entry) continue;
        if (!entry.envPath) continue;
        const raw = await readExistingEnv(entry.envPath);
        if (!raw.trim()) continue;
        const env = parseEnvToObject(raw);

        const serverComponent =
          getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') || 'happy-server-light';
        const portRaw = getEnvValue(env, 'HAPPY_STACKS_SERVER_PORT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_PORT');
        const currentPort = portRaw ? Number(portRaw) : NaN;
        if (Number.isFinite(currentPort) && currentPort > 0) {
          // Fail-safe: don't rewrite ports for a stack that appears to be actively running.
          // Otherwise we can strand a running server/daemon on a now-stale port.
          // eslint-disable-next-line no-await-in-loop
          const free = await isPortFree(currentPort);
          if (!free) {
            entry.issues.push({
              code: 'port_fix_skipped_running',
              message: `skipped port reassignment because port ${currentPort} is currently in use (stop the stack and re-run --fix-ports)`,
            });
            continue;
          }
        }
        const startFrom = Number.isFinite(currentPort) && currentPort > 0 ? currentPort + 1 : getDefaultPortStart();

        const updates = [];
        const newServerPort = await pickNextFreePort(startFrom, { reservedPorts: planned });
        planned.add(newServerPort);
        updates.push({ key: 'HAPPY_STACKS_SERVER_PORT', value: String(newServerPort) });

        if (serverComponent === 'happy-server') {
          planned.add(newServerPort);
          const backendPort = await pickNextFreePort(newServerPort + 10, { reservedPorts: planned });
          planned.add(backendPort);
          const pgPort = await pickNextFreePort(newServerPort + 1000, { reservedPorts: planned });
          planned.add(pgPort);
          const redisPort = await pickNextFreePort(pgPort + 1, { reservedPorts: planned });
          planned.add(redisPort);
          const minioPort = await pickNextFreePort(redisPort + 1, { reservedPorts: planned });
          planned.add(minioPort);
          const minioConsolePort = await pickNextFreePort(minioPort + 1, { reservedPorts: planned });
          planned.add(minioConsolePort);

          updates.push({ key: 'HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT', value: String(backendPort) });
          updates.push({ key: 'HAPPY_STACKS_PG_PORT', value: String(pgPort) });
          updates.push({ key: 'HAPPY_STACKS_REDIS_PORT', value: String(redisPort) });
          updates.push({ key: 'HAPPY_STACKS_MINIO_PORT', value: String(minioPort) });
          updates.push({ key: 'HAPPY_STACKS_MINIO_CONSOLE_PORT', value: String(minioConsolePort) });

          // Update URLs while preserving existing credentials.
          const pgUser = getEnvValue(env, 'HAPPY_STACKS_PG_USER') || 'handy';
          const pgPassword = getEnvValue(env, 'HAPPY_STACKS_PG_PASSWORD') || '';
          const pgDb = getEnvValue(env, 'HAPPY_STACKS_PG_DATABASE') || 'handy';
          let user = pgUser;
          let pass = pgPassword;
          let db = pgDb;
          const parsed = parsePg(getEnvValue(env, 'DATABASE_URL'));
          if (parsed) {
            if (parsed.user) user = parsed.user;
            if (parsed.password) pass = parsed.password;
            if (parsed.db) db = parsed.db;
          }
          const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${pgPort}/${encodeURIComponent(db)}`;
          updates.push({ key: 'DATABASE_URL', value: databaseUrl });
          updates.push({ key: 'REDIS_URL', value: `redis://127.0.0.1:${redisPort}` });
          updates.push({ key: 'S3_PORT', value: String(minioPort) });
          const bucket = getEnvValue(env, 'S3_BUCKET') || sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
          updates.push({ key: 'S3_PUBLIC_URL', value: `http://127.0.0.1:${minioPort}/${bucket}` });
        }

        await ensureEnvFileUpdated({ envPath: entry.envPath, updates });

        // Update in-memory report for follow-up collision recomputation.
        entry.serverPort = newServerPort;
        entry.issues.push({ code: 'port_reassigned', message: `server port reassigned -> ${newServerPort} (was ${currentPort || 'unknown'})` });
      }
      // Ensure the "kept" one remains reserved in planned as well.
      const keptEntry = byName.get(keep);
      if (keptEntry?.serverPort) planned.add(keptEntry.serverPort);
    }
  }

  // Recompute port collisions after optional fixes.
  for (const r of report) {
    r.issues = (r.issues ?? []).filter((i) => i.code !== 'port_collision');
  }
  const portsNow = new Map();
  for (const r of report) {
    if (!Number.isFinite(r.serverPort) || r.serverPort == null) continue;
    const existing = portsNow.get(r.serverPort) ?? [];
    existing.push(r.stackName);
    portsNow.set(r.serverPort, existing);
  }
  for (const [port, names] of portsNow.entries()) {
    if (names.length <= 1) continue;
    for (const r of report) {
      if (r.serverPort === port) {
        r.issues.push({ code: 'port_collision', message: `server port ${port} is also used by: ${names.filter((n) => n !== r.stackName).join(', ')}` });
      }
    }
  }

  const out = {
    ok: true,
    fixed: Boolean(fix || fixPorts || fixWorkspace || fixPaths || unpinPorts),
    stacks: report,
    summary: {
      total: report.length,
      withIssues: report.filter((r) => (r.issues ?? []).length > 0).length,
    },
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log('[stack] audit');
  for (const r of report) {
    const issueCount = (r.issues ?? []).length;
    const status = issueCount ? `issues=${issueCount}` : 'ok';
    console.log(`- ${r.stackName} (${status})`);
    if (issueCount) {
      for (const i of r.issues) console.log(`  - ${i.code}: ${i.message}`);
    }
  }
  if (fix) {
    console.log('');
    console.log('[stack] audit: applied best-effort fixes (missing keys only).');
  } else {
    console.log('');
    console.log('[stack] tip: run with --fix to add missing safe defaults (non-main stacks only).');
    console.log('[stack] tip: include --fix-main if you also want to modify main stack env defaults.');
  }
}

async function cmdCreateDevAuthSeed({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const name = (positionals[1] ?? '').trim() || 'dev-auth';
  const serverComponent = (kv.get('--server') ?? '').trim() || 'happy-server-light';
  const interactive = !flags.has('--non-interactive') && (flags.has('--interactive') || isTty());
  const bindMode = resolveBindModeFromArgs({ flags, kv });
  const skipDefaultSeed =
    flags.has('--skip-default-seed') || flags.has('--no-default-seed') || flags.has('--no-configure-default-seed');
  const forceLogin =
    flags.has('--login') ? true : flags.has('--no-login') || flags.has('--skip-login') ? false : null;

  if (json) {
    // Keep JSON mode non-interactive and stable by using the existing stack command output.
    // (We intentionally don't run the guided login flow in JSON mode.)
    const createArgs = ['new', name, '--no-copy-auth', '--server', serverComponent, '--json'];
    const created = await runCapture(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), ...createArgs], { cwd: rootDir, env: process.env }).catch((e) => {
      throw new Error(
        `[stack] create-dev-auth-seed: failed to create auth seed stack "${name}": ${e instanceof Error ? e.message : String(e)}`
      );
    });

    printResult({
      json,
      data: {
        ok: true,
        seedStack: name,
        serverComponent,
        created: created.trim() ? JSON.parse(created.trim()) : { ok: true },
        next: {
          login: `happys stack auth ${name} login`,
          setEnv: `# add to ${getHomeEnvLocalPath()}:\nHAPPY_STACKS_AUTH_SEED_FROM=${name}\nHAPPY_STACKS_AUTO_AUTH_SEED=1`,
          reseedAll: `happys auth copy-from ${name} --all --except=main,${name}`,
        },
      },
    });
    return;
  }

  // Create the seed stack as fresh auth (no copy) so it doesn't share main identity.
  // IMPORTANT: do this in-process (no recursive spawn) so the env file is definitely written
  // before we run any guided steps (withStackEnv/login).
  if (!stackExistsSync(name)) {
    await cmdNew({
      rootDir,
      argv: [name, '--no-copy-auth', '--server', serverComponent],
    });
  } else {
    console.log(`[stack] auth seed stack already exists: ${name}`);
  }

  if (!stackExistsSync(name)) {
    throw new Error(`[stack] create-dev-auth-seed: expected stack "${name}" to exist after creation, but it does not`);
  }

  // Interactive convenience: guide login first, then configure env.local + store dev key.
  if (interactive) {
    await withRl(async (rl) => {
      let savedDevKey = false;
      const wantLogin =
        forceLogin != null
          ? forceLogin
          : await promptSelect(rl, {
              title: `${bold('dev-auth seed stack')}\n${dim('Recommended: do the guided login now so the seed is ready immediately.')}`,
              options: [
                { label: `yes (${green('recommended')}) — start temporary server + UI and log in`, value: true },
                { label: `no — I will do this later`, value: false },
              ],
              defaultIndex: 0,
            });

      if (wantLogin) {
        console.log('');
        console.log(`[stack] starting ${serverComponent} temporarily so we can log in...`);

        const verbosity = getVerbosityLevel(process.env);
        const quietAuthFlow = verbosity === 0;
        const steps = createStepPrinter({ enabled: quietAuthFlow });

        // Pick a temporary server port for the guided login flow.
        // Respect HAPPY_STACKS_STACK_PORT_START so VM/CI environments can avoid host port collisions
        // without pinning stack env ports explicitly.
        const serverPortStart = getDefaultPortStart(name);
        const serverPort = await pickNextFreeTcpPort(serverPortStart, { host: '127.0.0.1' });
        const internalServerUrl = `http://127.0.0.1:${serverPort}`;
        const publicServerUrl = await preferStackLocalhostUrl(`http://localhost:${serverPort}`, { stackName: name });

        const logDir = join(getHappyStacksHomeDir(process.env), 'logs', 'dev-auth');
        await mkdir(logDir, { recursive: true }).catch(() => {});
        const serverLogPath = join(logDir, `server.${Date.now()}.log`);
        const expoLogPath = join(logDir, `expo.${Date.now()}.log`);

        const autostart = { stackName: name, baseDir: resolveStackEnvPath(name).baseDir };
        const children = [];

        await withStackEnv({
          stackName: name,
          extraEnv: {
            // Make sure stack auth login uses the same port we just picked, and avoid inheriting
            // any global/public URL (e.g. main stack’s Tailscale URL) for this guided flow.
            HAPPY_STACKS_SERVER_PORT: String(serverPort),
            HAPPY_LOCAL_SERVER_PORT: String(serverPort),
            HAPPY_STACKS_SERVER_URL: '',
            HAPPY_LOCAL_SERVER_URL: '',
            ...(bindMode
              ? applyBindModeToEnv(
                  {
                    // start from empty so we only inject the bind override keys here
                  },
                  bindMode
                )
              : {}),
          },
          fn: async ({ env }) => {
            if (bindMode) {
              applyBindModeToEnv(env, bindMode);
            }
            const serverDir =
              serverComponent === 'happy-server'
                ? env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER
                : env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT;
            const resolvedServerDir =
              (serverDir ?? env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER ?? env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT ?? '').toString().trim() ||
              getComponentDir(rootDir, serverComponent);
            const resolvedCliDir =
              (env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI ?? env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI ?? '').toString().trim() ||
              getComponentDir(rootDir, 'happy-cli');
            const resolvedUiDir =
              (env.HAPPY_STACKS_COMPONENT_DIR_HAPPY ?? env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY ?? '').toString().trim() || getComponentDir(rootDir, 'happy');

            await requireDir(serverComponent, resolvedServerDir);
            await requireDir('happy-cli', resolvedCliDir);
            await requireDir('happy', resolvedUiDir);

            let serverProc = null;
            let uiProc = null;
            let uiStopRequested = false;
            try {
              steps.start('start temporary server');
              const started = await startDevServer({
                serverComponentName: serverComponent,
                serverDir: resolvedServerDir,
                autostart,
                baseEnv: env,
                serverPort,
                internalServerUrl,
                publicServerUrl,
                envPath: env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '',
                stackMode: true,
                runtimeStatePath: null,
                serverAlreadyRunning: false,
                restart: true,
                children,
                spawnOptions: quietAuthFlow ? { silent: true, teeFile: serverLogPath, teeLabel: 'server' } : {},
                quiet: quietAuthFlow,
              });
              serverProc = started.serverProc;
              steps.stop('✓', 'start temporary server');

              // Start Expo (web) so /terminal/connect exists for happy-cli web auth.
              steps.start('start temporary UI');
              const uiRes = await ensureDevExpoServer({
                startUi: true,
                startMobile: false,
                uiDir: resolvedUiDir,
                autostart,
                baseEnv: env,
                // In the browser, prefer localhost for API calls.
                apiServerUrl: publicServerUrl,
                restart: false,
                stackMode: true,
                runtimeStatePath: null,
                stackName: name,
                envPath: env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '',
                children,
                spawnOptions: quietAuthFlow ? { silent: true, teeFile: expoLogPath, teeLabel: 'expo' } : {},
                quiet: quietAuthFlow,
              });
              if (uiRes?.skipped === false && uiRes.proc) {
                uiProc = uiRes.proc;
              }
              steps.stop('✓', 'start temporary UI');

              if (quietAuthFlow && uiProc) {
                uiProc.once('exit', (code, sig) => {
                  // We intentionally SIGINT Expo when we're done with login.
                  if (uiStopRequested && (sig === 'SIGINT' || sig === 'SIGTERM')) return;
                  if (code === 0) return;
                  void (async () => {
                    const c = typeof code === 'number' ? code : null;
                    // eslint-disable-next-line no-console
                    console.error(`[stack] Expo exited unexpectedly (code=${c ?? 'null'}, sig=${sig ?? 'null'})`);
                    // eslint-disable-next-line no-console
                    console.error(`[stack] expo log: ${expoLogPath}`);
                    const tail = await readLastLines(expoLogPath, 80);
                    if (tail) {
                      // eslint-disable-next-line no-console
                      console.error('');
                      // eslint-disable-next-line no-console
                      console.error(tail.trimEnd());
                    }
                  })();
                });
              }

              console.log('');
              const uiPort = uiRes?.port;
              const uiRootLocalhost = Number.isFinite(uiPort) && uiPort > 0 ? `http://localhost:${uiPort}` : null;
              const uiRoot = uiRootLocalhost ? await preferStackLocalhostUrl(uiRootLocalhost, { stackName: name }) : null;
              const uiSettings = uiRoot ? `${uiRoot}/settings/account` : null;

              console.log(`[stack] step 1/3: create a ${cyan('dev-auth')} account in the UI (this generates the dev key)`);
              if (uiRoot) {
                console.log(`[stack] waiting for UI to be ready...`);
                // Prefer localhost for readiness checks (faster/more reliable), even though we
                // instruct the user to use the stack-scoped *.localhost origin for storage isolation.
                await waitForHttpOk(uiRootLocalhost || uiRoot, { timeoutMs: 30_000 });
                console.log(`- open: ${uiRoot}`);
                console.log(`- click: "Create Account"`);
                console.log(`- then open: ${uiSettings}`);
                console.log(`- tap: "Secret Key" to reveal + copy it`);
                console.log('');
                console.log(`${bold('Press Enter')} to open it in your browser.`);
                await prompt(rl, '', { defaultValue: '' });
                if (uiProc && uiProc.exitCode != null && uiProc.exitCode !== 0) {
                  throw new Error(`[stack] Expo exited unexpectedly (code=${uiProc.exitCode}). See log: ${expoLogPath}`);
                }
                await openUrlInBrowser(uiRoot).catch(() => {});
                console.log(`${green('✓')} Browser opened`);
              } else {
                console.log(`- UI is running but the port was not detected; rerun with DEBUG logs if needed`);
              }
              await prompt(rl, `Press Enter once you've created the account in the UI... `);

              console.log('');
              console.log(`[stack] step 2/3: save the dev key locally ${dim('(optional; helps UI restore + automation)')}`);
              const keyInput = (await prompt(
                rl,
                `Paste the Secret Key now (from Settings → Account → Secret Key). Leave empty to skip: `
              )).trim();
              if (keyInput) {
                const res = await writeDevAuthKey({ env: process.env, input: keyInput });
                savedDevKey = true;
                console.log(`[stack] dev key saved: ${res.path}`);
              } else {
                console.log(`[stack] dev key not saved; you can do it later with: ${yellow('happys auth dev-key --set="<key>"')}`);
              }

              console.log('');
              console.log(`[stack] step 3/3: authenticate the CLI against this stack ${dim('(web auth)')}`);
              console.log(`[stack] launching: ${yellow(`happys stack auth ${name} login`)}`);
              await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), 'login', '--no-force'], {
                cwd: rootDir,
                env,
              });
            } finally {
              if (uiProc) {
                console.log('');
                console.log(`[stack] stopping temporary UI (pid=${uiProc.pid})...`);
                uiStopRequested = true;
                killProcessTree(uiProc, 'SIGINT');
                await Promise.race([
                  new Promise((resolve) => uiProc.on('exit', resolve)),
                  new Promise((resolve) => setTimeout(resolve, 15_000)),
                ]);
              }
              if (serverProc) {
                console.log('');
                console.log(`[stack] stopping temporary server (pid=${serverProc.pid})...`);
                killProcessTree(serverProc, 'SIGINT');
                await Promise.race([
                  new Promise((resolve) => serverProc.on('exit', resolve)),
                  new Promise((resolve) => setTimeout(resolve, 15_000)),
                ]);
              }
            }
          },
        });

        console.log('');
        console.log('[stack] login step complete.');
      } else {
        console.log(`[stack] skipping guided login. You can do it later with: ${yellow(`happys stack auth ${name} login`)}`);
      }

      if (!skipDefaultSeed) {
        const envLocalPath = getHomeEnvLocalPath();
        const wantEnv = await promptSelect(rl, {
          title:
            `${bold('Automatic sign-in for new stacks')}\n` +
            `${dim(`Recommended: when you create a new stack, copy/symlink auth from ${cyan(name)} automatically.`)}\n` +
            `${dim(`This writes ${cyan('HAPPY_STACKS_AUTO_AUTH_SEED=1')} + ${cyan(`HAPPY_STACKS_AUTH_SEED_FROM=${name}`)} in ${envLocalPath}.`)}`,
          options: [
            { label: `yes (${green('recommended')}) — enable automatic auth seeding`, value: true },
            { label: `no — I will configure this later`, value: false },
          ],
          defaultIndex: 0,
        });
        if (wantEnv) {
          await ensureEnvFileUpdated({
            envPath: envLocalPath,
            updates: [
              { key: 'HAPPY_STACKS_AUTH_SEED_FROM', value: name },
              { key: 'HAPPY_STACKS_AUTO_AUTH_SEED', value: '1' },
            ],
          });
          console.log(`[stack] updated: ${envLocalPath}`);
        } else {
          console.log(
            `[stack] tip: set in ${envLocalPath}: HAPPY_STACKS_AUTH_SEED_FROM=${name} and HAPPY_STACKS_AUTO_AUTH_SEED=1`
          );
        }
      }

      if (!savedDevKey) {
        const wantKey = await promptSelect(rl, {
          title: `${bold('Dev key (optional, sensitive)')}\n${dim('Save a dev key locally so you can restore the UI account quickly (and support automation).')}`,
          options: [
            { label: 'no (default)', value: false },
            { label: `yes — save a dev key now`, value: true },
          ],
          defaultIndex: 0,
        });
        if (wantKey) {
          console.log(`[stack] paste the secret key (base64url OR backup-format like XXXXX-XXXXX-...):`);
          const input = (await prompt(rl, `dev key: `)).trim();
          if (input) {
            try {
              const res = await writeDevAuthKey({ env: process.env, input });
              console.log(`[stack] dev key saved: ${res.path}`);
            } catch (e) {
              console.warn(`[stack] dev key not saved: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            console.log('[stack] dev key not provided; skipping');
          }
        } else {
          console.log(`[stack] tip: you can set it later with: ${yellow('happys auth dev-key --set="<key>"')}`);
        }
      }
    });
  } else {
    console.log(`- set as default seed (recommended) in ${getHomeEnvLocalPath()}:`);
    console.log(`  HAPPY_STACKS_AUTH_SEED_FROM=${name}`);
    console.log(`  HAPPY_STACKS_AUTO_AUTH_SEED=1`);
    console.log(`- (optional) seed existing stacks: happys auth copy-from ${name} --all --except=main,${name}`);
    console.log(`- (optional) store dev key for UI automation: happys auth dev-key --set="<key>"`);
  }
}

function parseServerComponentFromEnv(env) {
  const v =
    (env.HAPPY_STACKS_SERVER_COMPONENT ?? env.HAPPY_LOCAL_SERVER_COMPONENT ?? '').toString().trim() ||
    'happy-server-light';
  return v === 'happy-server' ? 'happy-server' : 'happy-server-light';
}

async function readStackEnvObject(stackName) {
  const envPath = resolveStackEnvPath(stackName).envPath;
  const raw = await readExistingEnv(envPath);
  const env = raw ? parseEnvToObject(raw) : {};
  return { envPath, env };
}

function getTodayYmd() {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function cmdArchiveStack({ rootDir, argv, stackName }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const dryRun = flags.has('--dry-run');
  const date = (kv.get('--date') ?? '').toString().trim() || getTodayYmd();

  if (!stackExistsSync(stackName)) {
    throw new Error(`[stack] archive: stack does not exist: ${stackName}`);
  }

  const { env } = await readStackEnvObject(stackName);
  const serverComponent = parseServerComponentFromEnv(env);
  const components = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

  const componentsDir = getComponentsDir(rootDir);
  const workspaceDir = dirname(componentsDir);
  const worktreesRoot = join(componentsDir, '.worktrees');

  // Collect unique git worktree roots referenced by this stack.
  const byRoot = new Map();
  for (const component of components) {
    const key = envKeyForComponentDir({ serverComponent, component });
    const legacyKey = key.replace('HAPPY_STACKS_', 'HAPPY_LOCAL_');
    const raw = (env[key] ?? env[legacyKey] ?? '').toString().trim();
    if (!raw) continue;
    const abs = isAbsolute(raw) ? raw : resolve(workspaceDir, raw);
    // Only archive paths that live under components/.worktrees/.
    const rel = relative(worktreesRoot, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const top = (await runCapture('git', ['rev-parse', '--show-toplevel'], { cwd: abs })).trim();
      if (!top) continue;
      if (!byRoot.has(top)) {
        byRoot.set(top, { component, dir: top });
      }
    } catch {
      // ignore invalid git dirs
    }
  }

  const { baseDir } = resolveStackEnvPath(stackName);
  const destStackDir = join(dirname(baseDir), '.archived', date, stackName);

  // Safety: avoid archiving a worktree that is still actively referenced by other stacks.
  // If we did, we'd break those stacks by moving their active checkout.
  if (!dryRun && byRoot.size) {
    const otherStacks = new Map(); // envPath -> Set(keys)
    const otherNames = new Set();

    for (const wt of byRoot.values()) {
      // eslint-disable-next-line no-await-in-loop
      const out = await runCapture(
        process.execPath,
        [join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', wt.component, wt.dir, '--dry-run', `--date=${date}`, '--json'],
        { cwd: rootDir, env: process.env }
      );
      const info = JSON.parse(out);
      const linked = Array.isArray(info.linkedStacks) ? info.linkedStacks : [];
      for (const s of linked) {
        if (!s?.name || s.name === stackName) continue;
        otherNames.add(s.name);
        const envPath = String(s.envPath ?? '').trim();
        if (!envPath) continue;
        const set = otherStacks.get(envPath) ?? new Set();
        for (const k of Array.isArray(s.keys) ? s.keys : []) {
          if (k) set.add(String(k));
        }
        otherStacks.set(envPath, set);
      }
    }

    if (otherNames.size) {
      const names = Array.from(otherNames).sort().join(', ');
      if (json || !isTty()) {
        throw new Error(`[stack] archive: worktree(s) are still referenced by other stacks: ${names}. Resolve first (detach or archive those stacks).`);
      }

      const action = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: `Worktree(s) referenced by "${stackName}" are still in use by other stacks: ${names}`,
          options: [
            { label: 'abort (recommended)', value: 'abort' },
            { label: 'detach those stacks from the shared worktree(s)', value: 'detach' },
            { label: 'archive the linked stacks as well', value: 'archive-stacks' },
          ],
          defaultIndex: 0,
        });
      });

      if (action === 'abort') {
        throw new Error('[stack] archive aborted');
      }
      if (action === 'archive-stacks') {
        for (const name of Array.from(otherNames).sort()) {
          // eslint-disable-next-line no-await-in-loop
          await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'archive', name, `--date=${date}`], { cwd: rootDir, env: process.env });
        }
      } else {
        for (const [envPath, keys] of otherStacks.entries()) {
          // eslint-disable-next-line no-await-in-loop
          await ensureEnvFilePruned({ envPath, removeKeys: Array.from(keys) });
        }
      }
    }
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      stackName,
      date,
      stackBaseDir: baseDir,
      archivedStackDir: destStackDir,
      worktrees: Array.from(byRoot.values()),
    };
  }

  await mkdir(dirname(destStackDir), { recursive: true });
  await rename(baseDir, destStackDir);

  const archivedWorktrees = [];
  for (const wt of byRoot.values()) {
    if (!existsSync(wt.dir)) continue;
    // eslint-disable-next-line no-await-in-loop
    const out = await runCapture(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), 'archive', wt.component, wt.dir, `--date=${date}`, '--json'], {
      cwd: rootDir,
      env: process.env,
    });
    archivedWorktrees.push(JSON.parse(out));
  }

  return { ok: true, dryRun: false, stackName, date, archivedStackDir: destStackDir, archivedWorktrees };
}

function envKeyForComponentDir({ serverComponent, component }) {
  if (component === 'happy') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY';
  if (component === 'happy-cli') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI';
  if (component === 'happy-server') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER';
  if (component === 'happy-server-light') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT';
  // Fallback; caller should not use.
  return `HAPPY_STACKS_COMPONENT_DIR_${component.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

async function cmdDuplicate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const fromStack = (positionals[1] ?? '').trim();
  const toStack = (positionals[2] ?? '').trim();
  if (!fromStack || !toStack) {
    throw new Error('[stack] usage: happys stack duplicate <from> <to> [--duplicate-worktrees] [--deps=...] [--json]');
  }
  if (toStack === 'main') {
    throw new Error('[stack] refusing to duplicate into stack name "main"');
  }
  if (!stackExistsSync(fromStack)) {
    throw new Error(`[stack] duplicate: source stack does not exist: ${fromStack}`);
  }
  if (stackExistsSync(toStack)) {
    throw new Error(`[stack] duplicate: destination stack already exists: ${toStack}`);
  }

  const duplicateWorktrees =
    flags.has('--duplicate-worktrees') ||
    flags.has('--with-worktrees') ||
    (kv.get('--duplicate-worktrees') ?? '').trim() === '1';
  const depsMode = (kv.get('--deps') ?? '').trim(); // forwarded to wt new when duplicating worktrees

  const { env: fromEnv } = await readStackEnvObject(fromStack);
  const serverComponent = parseServerComponentFromEnv(fromEnv);

  // Create the destination stack env with the correct baseDir and defaults (do not copy auth/data).
  await cmdNew({
    rootDir,
    argv: [toStack, '--no-copy-auth', '--server', serverComponent],
  });

  // Build component dir updates (copy overrides; optionally duplicate worktrees).
  // Copy all component directory overrides, not just the currently-selected server flavor.
  // This keeps the duplicated stack fully self-contained even if you later switch server flavor.
  const components = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

  const updates = [];
  for (const component of components) {
    const key = envKeyForComponentDir({ serverComponent, component });
    const legacyKey = key.replace('HAPPY_STACKS_', 'HAPPY_LOCAL_');
    const rawDir = (fromEnv[key] ?? fromEnv[legacyKey] ?? '').toString().trim();
    if (!rawDir) continue;

    let nextDir = rawDir;
    if (duplicateWorktrees && isComponentWorktreePath({ rootDir, component, dir: rawDir, env: fromEnv })) {
      const spec = worktreeSpecFromDir({ rootDir, component, dir: rawDir, env: fromEnv });
      if (spec) {
        const [owner, ...restParts] = spec.split('/').filter(Boolean);
        const rest = restParts.join('/');
        const slug = `dup/${sanitizeSlugPart(toStack)}/${rest}`;

        const repoDir = join(getComponentsDir(rootDir, fromEnv), component);
        const remoteName = await inferRemoteNameForOwner({ repoDir, owner });
        // Base on the existing worktree's HEAD/branch so we get the same commit.
        nextDir = await createWorktreeFromBaseWorktree({
          rootDir,
          component,
          slug,
          baseWorktreeSpec: spec,
          remoteName,
          depsMode,
          env: fromEnv,
        });
      }
    }

    updates.push({ key, value: nextDir });
  }

  // Apply component dir overrides to the destination stack env file.
  const toEnvPath = resolveStackEnvPath(toStack).envPath;
  if (updates.length) {
    await ensureEnvFileUpdated({ envPath: toEnvPath, updates });
  }

  const out = {
    ok: true,
    from: fromStack,
    to: toStack,
    serverComponent,
    duplicatedWorktrees: duplicateWorktrees,
    updatedKeys: updates.map((u) => u.key),
    envPath: toEnvPath,
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log(`[stack] duplicated: ${fromStack} -> ${toStack}`);
  console.log(`[stack] env: ${toEnvPath}`);
  if (duplicateWorktrees) {
    console.log(`[stack] worktrees: duplicated (deps=${depsMode || 'none'})`);
  } else {
    console.log('[stack] worktrees: not duplicated (reusing existing component dirs)');
  }
}

async function cmdInfo({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackName = (positionals[1] ?? '').trim();
  if (!stackName) {
    throw new Error('[stack] usage: happys stack info <name> [--json]');
  }
  if (!stackExistsSync(stackName)) {
    throw new Error(`[stack] info: stack does not exist: ${stackName}`);
  }

  const out = await cmdInfoInternal({ rootDir, stackName });
  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log(`[stack] info: ${stackName}`);
  console.log(`- env: ${out.envPath}`);
  console.log(`- runtime: ${out.runtimeStatePath}`);
  console.log(`- server: ${out.serverComponent}`);
  console.log(`- running: ${out.runtime.running ? 'yes' : 'no'}${out.runtime.ownerPid ? ` (pid=${out.runtime.ownerPid})` : ''}`);
  if (out.ports.server) console.log(`- port: server=${out.ports.server}${out.ports.backend ? ` backend=${out.ports.backend}` : ''}`);
  if (out.ports.ui) console.log(`- port: ui=${out.ports.ui}`);
  if (out.urls.uiUrl) console.log(`- ui: ${out.urls.uiUrl}`);
  if (out.urls.internalServerUrl) console.log(`- internal: ${out.urls.internalServerUrl}`);
  if (out.pinned.serverPort) console.log(`- pinned: serverPort=${out.pinned.serverPort}`);
  console.log('- components:');
  for (const c of out.components) {
    console.log(`  - ${c.component}: ${c.dir}${c.worktreeSpec ? ` (${c.worktreeSpec})` : ''}`);
  }
}

async function cmdPrStack({ rootDir, argv }) {
  // Supports passing args to the eventual `stack dev/start` via `-- ...`.
  const sep = argv.indexOf('--');
  const argv0 = sep >= 0 ? argv.slice(0, sep) : argv;
  const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];

  const { flags, kv } = parseArgs(argv0);
  const json = wantsJson(argv0, { flags });

  if (wantsHelp(argv0, { flags })) {
    printResult({
      json,
      data: {
        usage:
          'happys stack pr <name> --happy=<pr-url|number> [--happy-server-light=<pr-url|number>] [--server=happy-server|happy-server-light] [--remote=upstream] [--deps=none|link|install|link-or-install] [--seed-auth] [--copy-auth-from=<stack>] [--with-infra] [--auth-force] [--dev|--start] [--background] [--mobile] [--expo-tailscale] [--json] [-- <stack dev/start args...>]',
      },
      text: [
        '[stack] usage:',
        '  happys stack pr <name> --happy=<pr-url|number> [--happy-server-light=<pr-url|number>] [--dev|--start]',
        '    [--seed-auth] [--copy-auth-from=<stack>] [--link-auth] [--with-infra] [--auth-force]',
        '    [--remote=upstream] [--deps=none|link|install|link-or-install] [--update] [--force] [--background]',
        '    [--mobile]         # also start Expo dev-client Metro for mobile',
        '    [--expo-tailscale] # forward Expo to Tailscale interface for remote access',
        '    [--json] [-- <stack dev/start args...>]',
        '',
        'examples:',
        '  # Create stack + check out PRs + start dev UI',
        '  happys stack pr pr123 \\',
        '    --happy=https://github.com/slopus/happy/pull/123 \\',
        '    --seed-auth --copy-auth-from=dev-auth \\',
        '    --dev',
        '',
        '  # Use numeric PR refs (remote defaults to upstream)',
        '  happys stack pr pr123 --happy=123 --seed-auth --copy-auth-from=dev-auth --dev',
        '',
        '  # Reuse an existing non-stacks Happy install for auth seeding',
        '  (deprecated) legacy ~/.happy is not supported for reliable seeding',
        '',
        'notes:',
        '  - This composes existing commands: `happys stack new`, `happys stack wt ...`, and `happys stack auth ...`',
        '  - For auth seeding, pass `--seed-auth` and optionally `--copy-auth-from=dev-auth` (or legacy/main)',
        '  - `--link-auth` symlinks auth files instead of copying (keeps credentials in sync, but reduces isolation)',
      ].join('\n'),
    });
    return;
  }

  const positionals = argv0.filter((a) => !a.startsWith('--'));
  const stackName = (positionals[1] ?? '').trim();
  if (!stackName) {
    throw new Error('[stack] pr: missing stack name. Usage: happys stack pr <name> --happy=<pr>');
  }
  if (stackName === 'main') {
    throw new Error('[stack] pr: stack name "main" is reserved; pick a unique name for this PR stack');
  }
  const reuseExisting = flags.has('--reuse') || flags.has('--update-existing') || (kv.get('--reuse') ?? '').trim() === '1';
  const stackExists = stackExistsSync(stackName);
  if (stackExists && !reuseExisting) {
    throw new Error(
      `[stack] pr: stack already exists: ${stackName}\n` +
        `[stack] tip: re-run with --reuse to update the existing PR worktrees and keep the stack wiring intact`
    );
  }

  const remoteNameFromArg = (kv.get('--remote') ?? '').trim();
  const depsMode = (kv.get('--deps') ?? '').trim();

  const prHappy = (kv.get('--happy') ?? '').trim();
  const prCli = (kv.get('--happy-cli') ?? '').trim();
  const prServerLight = (kv.get('--happy-server-light') ?? '').trim();
  const prServer = (kv.get('--happy-server') ?? '').trim();

  if (!prHappy && !prCli && !prServerLight && !prServer) {
    throw new Error(
      '[stack] pr: missing PR inputs. Provide at least one of: --happy, --happy-cli, --happy-server-light, --happy-server'
    );
  }
  if (prServerLight && prServer) {
    throw new Error('[stack] pr: cannot specify both --happy-server and --happy-server-light');
  }

  const happyMonorepoActive = Boolean(coerceHappyMonorepoRootFromPath(getComponentDir(rootDir, 'happy', process.env)));
  if (happyMonorepoActive) {
    if (prCli) {
      throw new Error(
        '[stack] pr: --happy-cli is not supported when using the slopus/happy monorepo.\n' +
          'Fix: use --happy=<pr> to pin the monorepo (UI + CLI + server) in one worktree.'
      );
    }
    if (prServer) {
      throw new Error(
        '[stack] pr: --happy-server is not supported when using the slopus/happy monorepo.\n' +
          'Fix: use --happy=<pr> to pin the monorepo (UI + CLI + server) in one worktree.'
      );
    }
  }

  const serverFromArg = (kv.get('--server') ?? '').trim();
  const inferredServer = prServer ? 'happy-server' : prServerLight ? 'happy-server-light' : '';
  const serverComponent = (serverFromArg || inferredServer || 'happy-server-light').trim();
  if (serverComponent !== 'happy-server' && serverComponent !== 'happy-server-light') {
    throw new Error(`[stack] pr: invalid --server: ${serverFromArg || serverComponent}`);
  }

  const wantsDev = flags.has('--dev') || flags.has('--start-dev');
  const wantsStart = flags.has('--start') || flags.has('--prod');
  if (wantsDev && wantsStart) {
    throw new Error('[stack] pr: choose either --dev or --start (not both)');
  }

  const wantsMobile = flags.has('--mobile') || flags.has('--with-mobile');
  const wantsExpoTailscale = flags.has('--expo-tailscale');
  const background = flags.has('--background') || flags.has('--bg') || (kv.get('--background') ?? '').trim() === '1';

  const seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  const authFromFlag = (kv.get('--copy-auth-from') ?? '').trim();
  const withInfra = flags.has('--with-infra') || flags.has('--ensure-infra') || flags.has('--infra');
  const authForce = flags.has('--auth-force') || flags.has('--force-auth');
  const authLinkFlag = flags.has('--link-auth') || flags.has('--link') || flags.has('--symlink-auth') ? true : null;
  const authLinkEnv =
    (process.env.HAPPY_STACKS_AUTH_LINK ?? process.env.HAPPY_LOCAL_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPY_STACKS_AUTH_MODE ?? process.env.HAPPY_LOCAL_AUTH_MODE ?? '').toString().trim() === 'link';

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !json;

  const mainAccessKeyPath = join(resolveStackEnvPath('main').baseDir, 'cli', 'access.key');
  const legacyAccessKeyPath = join(getLegacyHappyBaseDir(), 'cli', 'access.key');
  const devAuthAccessKeyPath = join(resolveStackEnvPath('dev-auth').baseDir, 'cli', 'access.key');

  const hasMainAccessKey = existsSync(mainAccessKeyPath);
  const allowGlobal = sandboxAllowsGlobalSideEffects();
  const hasLegacyAccessKey = (!isSandboxed() || allowGlobal) && existsSync(legacyAccessKeyPath);
  const hasDevAuthAccessKey = existsSync(devAuthAccessKeyPath) && existsSync(resolveStackEnvPath('dev-auth').envPath);

  const inferredSeedFromEnv = resolveAuthSeedFromEnv(process.env);
  const inferredSeedFromAvailability = hasDevAuthAccessKey ? 'dev-auth' : hasMainAccessKey ? 'main' : hasLegacyAccessKey ? 'legacy' : 'main';
  const defaultAuthFrom = authFromFlag || inferredSeedFromEnv || inferredSeedFromAvailability;

  // Default behavior for stack pr:
  // - if user explicitly flags --seed-auth/--no-seed-auth, obey
  // - otherwise in interactive mode: prompt when we have *some* plausible source, default yes
  // - in non-interactive mode: follow HAPPY_STACKS_AUTO_AUTH_SEED (if set), else default false
  const envAutoSeed =
    (process.env.HAPPY_STACKS_AUTO_AUTH_SEED ?? process.env.HAPPY_LOCAL_AUTO_AUTH_SEED ?? '').toString().trim();
  const autoSeedEnabled = envAutoSeed ? envAutoSeed !== '0' : false;

  let seedAuth = seedAuthFlag != null ? seedAuthFlag : autoSeedEnabled;
  let authFrom = defaultAuthFrom;
  let authLink = authLinkFlag != null ? authLinkFlag : authLinkEnv;

  if (seedAuthFlag == null && isInteractive) {
    const anySource = hasDevAuthAccessKey || hasMainAccessKey || hasLegacyAccessKey;
    if (anySource) {
      seedAuth = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: 'Seed authentication into this PR stack so it works without a re-login?',
          options: [
            { label: 'yes (recommended)', value: true },
            { label: 'no (I will login manually for this stack)', value: false },
          ],
          defaultIndex: 0,
        });
      });
    } else {
      seedAuth = false;
    }
  }

  if (seedAuth && !authFromFlag && isInteractive) {
    const options = [];
    if (hasDevAuthAccessKey) {
      options.push({ label: 'dev-auth (recommended) — use your dedicated dev auth seed stack', value: 'dev-auth' });
    }
    if (hasMainAccessKey) {
      options.push({ label: 'main — use Happy Stacks main credentials', value: 'main' });
    }
    if (hasLegacyAccessKey) {
      options.push({ label: 'legacy — use ~/.happy credentials (best-effort)', value: 'legacy' });
    }
    options.push({ label: 'skip seeding (manual login)', value: 'skip' });

    const defaultIdx = Math.max(
      0,
      options.findIndex((o) => o.value === (hasDevAuthAccessKey ? 'dev-auth' : hasMainAccessKey ? 'main' : hasLegacyAccessKey ? 'legacy' : 'skip'))
    );
    const picked = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'Which auth source should this PR stack use?',
        options,
        defaultIndex: defaultIdx,
      });
    });
    if (picked === 'skip') {
      seedAuth = false;
    } else {
      authFrom = String(picked);
    }
  }

  if (seedAuth && authLinkFlag == null && isInteractive) {
    authLink = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'When seeding, reuse credentials via symlink or copy?',
        options: [
          { label: 'symlink (recommended) — stays up to date', value: true },
          { label: 'copy — more isolated per stack', value: false },
        ],
        defaultIndex: authLink ? 0 : 1,
      });
    });
  }

  const progress = (line) => {
    // In JSON mode, never pollute stdout (reserved for final JSON).
    // eslint-disable-next-line no-console
    (json ? console.error : console.log)(line);
  };

  // 1) Create (or reuse) the stack.
  let created = null;
  if (!stackExists) {
    progress(`[stack] pr: creating stack "${stackName}" (server=${serverComponent})...`);
    created = await cmdNew({
      rootDir,
      argv: [stackName, '--no-copy-auth', `--server=${serverComponent}`, ...(json ? ['--json'] : [])],
      // Prevent cmdNew from printing in JSON mode (we’ll print the final combined object below).
      emit: !json,
    });
  } else {
    progress(`[stack] pr: reusing existing stack "${stackName}"...`);
    // Ensure requested server flavor is compatible with the existing stack.
    const existing = await cmdInfoInternal({ rootDir, stackName });
    if (existing.serverComponent !== serverComponent) {
      throw new Error(
        `[stack] pr: existing stack "${stackName}" uses server=${existing.serverComponent}, but command requested server=${serverComponent}.\n` +
          `Fix: create a new stack name, or switch the stack's server flavor first (happys stack srv ${stackName} -- use ...).`
      );
    }
    created = { ok: true, stackName, reused: true, serverComponent: existing.serverComponent };
  }

  // 2) Checkout PR worktrees and pin them to the stack env file.
  const prSpecs = (
    happyMonorepoActive
      ? [
          ...(prHappy ? [{ component: 'happy', pr: prHappy }] : []),
          ...(serverComponent === 'happy-server-light' && prServerLight ? [{ component: 'happy-server-light', pr: prServerLight }] : []),
        ]
      : [
          ...(prHappy ? [{ component: 'happy', pr: prHappy }] : []),
          ...(prCli ? [{ component: 'happy-cli', pr: prCli }] : []),
          ...(serverComponent === 'happy-server' && prServer ? [{ component: 'happy-server', pr: prServer }] : []),
          ...(serverComponent === 'happy-server-light' && prServerLight ? [{ component: 'happy-server-light', pr: prServerLight }] : []),
        ]
  ).filter((x) => x.pr);

  const worktrees = [];
  const stackEnvPath = resolveStackEnvPath(stackName).envPath;
  for (const { component, pr } of prSpecs) {
    progress(`[stack] pr: ${stackName}: fetching PR for ${component} (${pr})...`);
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        const doUpdate = reuseExisting || flags.has('--update');
        const args = [
          'pr',
          component,
          pr,
          ...(remoteNameFromArg ? [`--remote=${remoteNameFromArg}`] : []),
          '--use',
          ...(depsMode ? [`--deps=${depsMode}`] : []),
          ...(doUpdate ? ['--update'] : []),
          ...(flags.has('--force') ? ['--force'] : []),
          '--json',
        ];
        const stdout = await runCapture(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), ...args], { cwd: rootDir, env });
        const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : null;

        // Fail-closed invariant for PR stacks:
        // If you asked to pin a component to a PR checkout, it MUST be a worktree path under
        // the active workspace components dir (including sandbox workspace).
        if (parsed?.path && !isComponentWorktreePath({ rootDir, component, dir: parsed.path, env })) {
          const expectedRepoKey = parsed?.repoKey ? String(parsed.repoKey) : component;
          throw new Error(
            `[stack] pr: refusing to pin ${component} because the checked out path is not a worktree.\n` +
              `- expected under: ${join(getComponentsDir(rootDir, env), '.worktrees', expectedRepoKey)}/...\n` +
              `- actual: ${String(parsed.path ?? '').trim()}\n` +
              `Fix: this is a bug. Please re-run with --force, or delete/recreate the stack (${stackName}).`
          );
        }

        return parsed;
      },
    });
    if (out) {
      worktrees.push(out);
      // Fail-closed invariant for PR stacks:
      // - if you asked to pin a component to a PR checkout, the stack env file MUST point at that exact worktree dir
      //   before we start dev/start. Otherwise the stack can accidentally run the base checkout.
      //
      // We intentionally do NOT rely solely on `wt pr --use` for this; we make it explicit here.
      const key = componentDirEnvKey(component);
      await ensureEnvFileUpdated({ envPath: stackEnvPath, updates: [{ key, value: out.path }] });
    }
    if (json) {
      // collected above
    } else if (out) {
      const short = (sha) => (sha ? String(sha).slice(0, 8) : '');
      const changed = Boolean(out.updated && out.oldHead && out.newHead && out.oldHead !== out.newHead);
      if (changed) {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: updated ${short(out.oldHead)} -> ${short(out.newHead)}`);
      } else if (out.updated) {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: already up to date (${short(out.newHead)})`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: checked out (${short(out.newHead)})`);
      }
    }
  }

  // Monorepo shortcut:
  // If `--happy=<pr>` was provided and the local checkout is the slopus/happy monorepo, pin
  // happy-cli and server flavors to that same worktree without fetching separate PRs.
  if (happyMonorepoActive && prHappy) {
    const happyWt = worktrees.find((w) => w?.component === 'happy');
    const happyPath = String(happyWt?.path ?? '').trim();
    const happyRoot = happyWt?.worktreeRoot ? resolve(String(happyWt.worktreeRoot)) : happyPath ? coerceHappyMonorepoRootFromPath(happyPath) : null;
    if (!happyRoot) {
      throw new Error('[stack] pr: expected happy monorepo worktree root but could not resolve it from the checked out path.');
    }

    const derive = (component) => {
      const sub = happyMonorepoSubdirForComponent(component);
      if (!sub) return null;
      return join(happyRoot, sub);
    };

    const derivedComponents = [
      'happy-cli',
      ...(serverComponent === 'happy-server' ? ['happy-server'] : []),
      // If the user didn't explicitly provide a separate server-light PR, prefer the monorepo server/ dir.
      ...(serverComponent === 'happy-server-light' && !prServerLight ? ['happy-server-light'] : []),
    ];

    for (const c of derivedComponents) {
      const p = derive(c);
      if (!p) continue;
      if (c === 'happy-server-light') {
        const hasSqliteSchema =
          existsSync(join(p, 'prisma', 'sqlite', 'schema.prisma')) || existsSync(join(p, 'prisma', 'schema.sqlite.prisma'));
        if (!hasSqliteSchema) {
          throw new Error(
            '[stack] pr: happy-server-light was requested, but the monorepo server checkout does not include sqlite schema support.\n' +
              `- expected one of:\n` +
              `  - ${join(p, 'prisma', 'sqlite', 'schema.prisma')}\n` +
              `  - ${join(p, 'prisma', 'schema.sqlite.prisma')}\n` +
              'Fix: either switch to the full server flavor (--server=happy-server), or provide an explicit --happy-server-light=<pr>.'
          );
        }
      }
      if (!isComponentWorktreePath({ rootDir, component: c, dir: p, env: process.env })) {
        throw new Error(`[stack] pr: refusing to pin ${c} because the derived path is not a worktree: ${p}`);
      }
      const key = componentDirEnvKey(c);
      await ensureEnvFileUpdated({ envPath: stackEnvPath, updates: [{ key, value: p }] });
      worktrees.push({ component: c, path: p });
    }
  }

  // Validate that all PR components are pinned correctly before starting.
  // This prevents "wrong daemon" / "wrong UI" errors that are otherwise extremely confusing in review-pr.
  if (prSpecs.length) {
    const afterRaw = await readExistingEnv(stackEnvPath);
    const afterEnv = parseEnvToObject(afterRaw);
    for (const wt of worktrees) {
      const key = componentDirEnvKey(wt.component);
      const val = (afterEnv[key] ?? '').toString().trim();
      const expected = resolve(String(wt.path ?? '').trim());
      const actual = val ? resolve(val) : '';
      if (!actual) {
        throw new Error(
          `[stack] pr: failed to pin ${wt.component} to the PR checkout.\n` +
            `- missing env key: ${key}\n` +
            `- expected: ${expected}\n` +
            `Fix: re-run with --force, or delete/recreate the stack (${stackName}).`
        );
      }
      if (expected && actual !== expected) {
        throw new Error(
          `[stack] pr: stack is pinned to the wrong checkout for ${wt.component}.\n` +
            `- env key: ${key}\n` +
            `- expected: ${expected}\n` +
            `- actual:   ${actual}\n` +
            `Fix: re-run with --force, or delete/recreate the stack (${stackName}).`
        );
      }
    }
  }

  // 3) Optional: seed auth (copies cli creds + master secret + DB Account rows).
  let auth = null;
  if (seedAuth) {
    progress(`[stack] pr: ${stackName}: seeding auth from "${authFrom}"...`);
    const args = [
      'copy-from',
      authFrom,
      ...(authForce ? ['--force'] : []),
      ...(withInfra ? ['--with-infra'] : []),
      ...(authLink ? ['--link'] : []),
    ];
    if (json) {
      const extraEnv = await getRuntimePortExtraEnv(stackName);
      auth = await withStackEnv({
        stackName,
        ...(extraEnv ? { extraEnv } : {}),
        fn: async ({ env }) => {
          const stdout = await runCapture(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...args, '--json'], { cwd: rootDir, env });
          return stdout.trim() ? JSON.parse(stdout.trim()) : null;
        },
      });
    } else {
      await cmdAuth({ rootDir, stackName, args });
      auth = { ok: true, from: authFrom };
    }
  }

  // 4) Optional: start dev / start.
  if (wantsDev) {
    progress(`[stack] pr: ${stackName}: starting dev...`);
    const args = [
      ...(wantsMobile ? ['--mobile'] : []),
      ...(wantsExpoTailscale ? ['--expo-tailscale'] : []),
      ...(passthrough.length ? ['--', ...passthrough] : []),
    ];
    await cmdRunScript({ rootDir, stackName, scriptPath: 'dev.mjs', args, background });
  } else if (wantsStart) {
    progress(`[stack] pr: ${stackName}: starting...`);
    const args = [
      ...(wantsMobile ? ['--mobile'] : []),
      ...(wantsExpoTailscale ? ['--expo-tailscale'] : []),
      ...(passthrough.length ? ['--', ...passthrough] : []),
    ];
    await cmdRunScript({ rootDir, stackName, scriptPath: 'run.mjs', args, background });
  }

  const info = await cmdInfoInternal({ rootDir, stackName });

  const out = {
    ok: true,
    stackName,
    created,
    worktrees: worktrees.length ? worktrees : null,
    auth,
    info,
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }
  // Non-JSON mode already streamed output.
}

async function cmdInfoInternal({ rootDir, stackName }) {
  // Minimal extraction from cmdInfo to avoid re-parsing argv/printing. Used by cmdPrStack.
  const baseDir = resolveStackEnvPath(stackName).baseDir;
  const envPath = resolveStackEnvPath(stackName).envPath;
  const envRaw = await readExistingEnv(envPath);
  const stackEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);

  const serverComponent =
    getEnvValueAny(stackEnv, ['HAPPY_STACKS_SERVER_COMPONENT', 'HAPPY_LOCAL_SERVER_COMPONENT']) || 'happy-server-light';

  const stackRemote =
    getEnvValueAny(stackEnv, ['HAPPY_STACKS_STACK_REMOTE', 'HAPPY_LOCAL_STACK_REMOTE']) || 'upstream';

  const pinnedServerPortRaw = getEnvValueAny(stackEnv, ['HAPPY_STACKS_SERVER_PORT', 'HAPPY_LOCAL_SERVER_PORT']);
  const pinnedServerPort = pinnedServerPortRaw ? Number(pinnedServerPortRaw) : null;

  const ownerPid = Number(runtimeState?.ownerPid);
  const running = isPidAlive(ownerPid);
  const runtimePorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
  const serverPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(runtimePorts?.server) > 0
        ? Number(runtimePorts.server)
        : null;
  const backendPort = Number(runtimePorts?.backend) > 0 ? Number(runtimePorts.backend) : null;
  const uiPort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.webPort) > 0
      ? Number(runtimeState.expo.webPort)
      : null;
  const mobilePort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.mobilePort) > 0
      ? Number(runtimeState.expo.mobilePort)
      : null;

  const host = resolveLocalhostHost({ stackMode: true, stackName });
  const internalServerUrl = serverPort ? `http://127.0.0.1:${serverPort}` : null;
  const uiUrl = uiPort ? `http://${host}:${uiPort}` : null;
  const mobileUrl = mobilePort ? await preferStackLocalhostUrl(`http://localhost:${mobilePort}`, { stackName }) : null;

  const componentSpecs = [
    { component: 'happy', keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY'] },
    { component: 'happy-cli', keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI'] },
    {
      component: 'happy-server-light',
      keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT'],
    },
    { component: 'happy-server', keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER'] },
  ];

  const components = componentSpecs.map((c) => {
    const dir = getEnvValueAny(stackEnv, c.keys) || getComponentDir(rootDir, c.component);
    const spec = worktreeSpecFromDir({ rootDir, component: c.component, dir }) || null;
    return { component: c.component, dir, worktreeSpec: spec };
  });

  return {
    ok: true,
    stackName,
    baseDir,
    envPath,
    runtimeStatePath,
    serverComponent,
    stackRemote,
    pinned: {
      serverPort: Number.isFinite(pinnedServerPort) && pinnedServerPort > 0 ? pinnedServerPort : null,
    },
    runtime: {
      script: typeof runtimeState?.script === 'string' ? runtimeState.script : null,
      ownerPid: Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null,
      running,
      ports: runtimePorts,
      expo: runtimeState?.expo ?? null,
      processes: runtimeState?.processes ?? null,
      startedAt: runtimeState?.startedAt ?? null,
      updatedAt: runtimeState?.updatedAt ?? null,
    },
    urls: {
      host,
      internalServerUrl,
      uiUrl,
      mobileUrl,
    },
    ports: {
      server: serverPort,
      backend: backendPort,
      ui: uiPort,
      mobile: mobilePort,
    },
    components,
  };
}

async function cmdStackCodeOrCursor({ rootDir, stackName, json, editor, includeStackDir, includeAllComponents, includeCliHome }) {
  const ws = await writeStackCodeWorkspace({ rootDir, stackName, includeStackDir, includeAllComponents, includeCliHome });

  if (json) {
    printResult({
      json,
      data: {
        ok: true,
        stackName,
        editor,
        ...ws,
      },
    });
    return;
  }

  await openWorkspaceInEditor({ rootDir, editor, workspacePath: ws.workspacePath });
  console.log(`[stack] opened ${editor === 'code' ? 'VS Code' : 'Cursor'} workspace for "${stackName}": ${ws.workspacePath}`);
}

async function cmdStackOpen({ rootDir, stackName, json, includeStackDir, includeAllComponents, includeCliHome }) {
  const editor = (await isCursorInstalled({ cwd: rootDir, env: process.env })) ? 'cursor' : 'code';
  await cmdStackCodeOrCursor({ rootDir, stackName, json, editor, includeStackDir, includeAllComponents, includeCliHome });
}

async function cmdStackDaemon({ rootDir, stackName, argv, json }) {
  const { flags, kv } = parseArgs(argv);
  const wantsHelpFlag = wantsHelp(argv, { flags });

  const positionals = argv.filter((a) => a && a !== '--' && !a.startsWith('--'));
  const action = (positionals[0] ?? 'status').toString().trim();
  const identity = parseCliIdentityOrThrow((kv.get('--identity') ?? '').trim());
  const noOpen = flags.has('--no-open') || flags.has('--no-browser') || flags.has('--no-browser-open');

  if (wantsHelpFlag || !action || action === 'help') {
    printResult({
      json,
      data: { ok: true, stackName, commands: ['start', 'stop', 'restart', 'status'], flags: ['--identity=<name>'] },
      text: [
        banner('stack daemon', { subtitle: `Manage the happy-cli daemon for stack ${cyan(stackName || 'main')}.` }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('happys stack daemon')} <name> status [--identity=<name>] [--json]`,
        `  ${cyan('happys stack daemon')} <name> start [--identity=<name>] [--json]`,
        `  ${cyan('happys stack daemon')} <name> stop [--identity=<name>] [--json]`,
        `  ${cyan('happys stack daemon')} <name> restart [--identity=<name>] [--json]`,
        '',
        sectionTitle('example:'),
        `  ${cmdFmt(`happys stack daemon ${stackName || 'main'} restart`)}`,
        `  ${cmdFmt(`happys stack daemon ${stackName || 'main'} start --identity=account-b`)}`,
      ].join('\n'),
    });
    return;
  }

  if (!['start', 'stop', 'restart', 'status'].includes(action)) {
    printResult({
      json,
      data: { ok: false, error: 'invalid_daemon_subcommand', stackName, action },
      text: [
        `[stack] invalid daemon subcommand: ${action}`,
        '',
        'usage:',
        '  happys stack daemon <name> start|stop|restart|status [--json]',
      ].join('\n'),
    });
    process.exit(1);
  }

  const res = await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      const cliDir =
        (env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI ?? env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI ?? '').toString().trim() ||
        getComponentDir(rootDir, 'happy-cli');
      const cliBin = join(cliDir, 'bin', 'happy.mjs');
      const baseCliHomeDir = (env.HAPPY_STACKS_CLI_HOME_DIR ??
        env.HAPPY_LOCAL_CLI_HOME_DIR ??
        join(resolveStackEnvPath(stackName).baseDir, 'cli')).toString();
      const cliHomeDir = resolveCliHomeDirForIdentity({ cliHomeDir: baseCliHomeDir, identity });
      const serverPort = resolveServerPortFromEnv({ env, defaultPort: 3005 });
      const urls = await resolveServerUrls({ env, serverPort, allowEnable: false });
      const internalServerUrl = urls.internalServerUrl;
      const publicServerUrl = urls.publicServerUrl;
      const envForIdentity = {
        ...env,
        HAPPY_STACKS_CLI_IDENTITY: identity,
        HAPPY_LOCAL_CLI_IDENTITY: identity,
        ...(identity !== 'default'
          ? {
              HAPPY_STACKS_MIGRATE_CREDENTIALS: '0',
              HAPPY_LOCAL_MIGRATE_CREDENTIALS: '0',
              HAPPY_STACKS_AUTO_AUTH_SEED: '0',
              HAPPY_LOCAL_AUTO_AUTH_SEED: '0',
            }
          : {}),
      };
      await mkdir(cliHomeDir, { recursive: true }).catch(() => {});
      const daemonEnv = getDaemonEnv({ baseEnv: envForIdentity, cliHomeDir, internalServerUrl, publicServerUrl });

      if (action === 'start' || action === 'restart') {
        // UX: if this identity is not authenticated yet and we're in a real TTY, offer to run the
        // guided login flow inline (instead of failing or asking for a second terminal).
        //
        // Important: never prompt in --json mode (automation must not hang).
        const accessKeyPath = join(cliHomeDir, 'access.key');
        const hasCreds = (() => {
          try {
            if (!existsSync(accessKeyPath)) return false;
            return readFileSync(accessKeyPath, 'utf-8').trim().length > 0;
          } catch {
            return false;
          }
        })();

        if (!hasCreds) {
          if (json) {
            const loginCmd = `happys stack auth ${stackName} login${identity !== 'default' ? ` --identity=${identity} --no-open` : ''}`;
            return { ok: false, action, error: 'auth_required', cliIdentity: identity, cliHomeDir, loginCmd };
          }

          if (isTty()) {
            const choice = await withRl(async (rl) => {
              return await promptSelect(rl, {
                title:
                  `Daemon identity "${identity}" is not authenticated yet.\n` +
                  `Authenticate now? (recommended)\n`,
                options: [
                  { label: 'yes (run guided login now)', value: 'yes' },
                  { label: 'no (show command and exit)', value: 'no' },
                ],
                defaultIndex: 0,
              });
            });

            if (choice === 'yes') {
              const authArgs = [
                'login',
                ...(identity !== 'default' ? [`--identity=${identity}`] : []),
                ...(identity !== 'default' || noOpen ? ['--no-open'] : []),
              ];
              await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...authArgs], {
                cwd: rootDir,
                env: envForIdentity,
                stdio: 'inherit',
              });
            } else {
              const loginCmd = `happys stack auth ${stackName} login${identity !== 'default' ? ` --identity=${identity} --no-open` : ''}`;
              throw new Error(`[stack] daemon auth required. Run:\n${loginCmd}`);
            }
          }
        }

        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown: () => false,
          forceRestart: action === 'restart',
          env: envForIdentity,
          stackName,
          cliIdentity: identity,
        });
        const status = await runCapture(process.execPath, [cliBin, 'daemon', 'status'], { cwd: rootDir, env: daemonEnv });
        return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() };
      }

      if (action === 'stop') {
        await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir });
        const status = await runCapture(process.execPath, [cliBin, 'daemon', 'status'], { cwd: rootDir, env: daemonEnv }).catch(() => '');
        return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() || null };
      }

      const status = await runCapture(process.execPath, [cliBin, 'daemon', 'status'], { cwd: rootDir, env: daemonEnv });
      return { ok: true, action, cliIdentity: identity, cliHomeDir, status: status.trim() };
    },
  });

  if (json) {
    printResult({ json, data: { stackName, ...res } });
    return;
  }

  if (res?.status) {
    console.log('');
    console.log(sectionTitle('Daemon'));
    console.log(res.status);
    return;
  }

  console.log(`${green('✓')} daemon command completed`);
}

const STACK_NAME_FIRST_SUPPORTED_COMMANDS = new Set([
  'help',
  'new',
  'edit',
  'list',
  'migrate',
  'audit',
  'archive',
  'duplicate',
  'info',
  'pr',
  'create-dev-auth-seed',
  'daemon',
  'happy',
  'env',
  'auth',
  'dev',
  'start',
  'build',
  'review',
  'typecheck',
  'lint',
  'test',
  'doctor',
  'mobile',
  'mobile:install',
  'mobile-dev-client',
  'resume',
  'stop',
  'code',
  'cursor',
  'open',
  'srv',
  'wt',
  'service',
]);

function isKnownStackCommandToken(token) {
  const t = (token ?? '').toString().trim();
  if (!t) return false;
  if (t.startsWith('service:')) return true;
  if (t.startsWith('tailscale:')) return true;
  return STACK_NAME_FIRST_SUPPORTED_COMMANDS.has(t);
}

function normalizeStackNameFirstArgs(argv) {
  // Back-compat UX:
  // Allow `happys stack <name> <command> ...` (stack name first) as a shortcut for:
  //   `happys stack <command> <name> ...`
  //
  // We only apply this rewrite when the first positional is *not* a known stack subcommand,
  // but *is* an existing stack name.
  const args = Array.isArray(argv) ? argv : [];
  const positionalIdx = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === '--') continue;
    if (a.startsWith('-')) continue;
    positionalIdx.push(i);
    if (positionalIdx.length >= 2) break;
  }
  if (positionalIdx.length < 2) return args;

  const [i0, i1] = positionalIdx;
  const first = args[i0];
  const second = args[i1];

  if (isKnownStackCommandToken(first)) return args;
  if (!isKnownStackCommandToken(second)) return args;
  if (!stackExistsSync(first)) return args;

  const next = [...args];
  next[i0] = second;
  next[i1] = first;
  return next;
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  // pnpm (legacy) passes an extra leading `--` when forwarding args into scripts. Normalize it away so
  // positional slicing behaves consistently.
  const rawArgv = process.argv.slice(2);
  const argv0 = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;
  const argv = normalizeStackNameFirstArgs(argv0);

  const { flags } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] || 'help';
  const json = wantsJson(argv, { flags });

  const wantsHelpFlag = wantsHelp(argv, { flags });
  // Allow subcommand-specific help (so `happys stack pr --help` shows PR stack flags).
  if (wantsHelpFlag && cmd === 'pr') {
    await cmdPrStack({ rootDir, argv });
    return;
  }
  // Allow subcommand-specific help (so `happys stack daemon <name> --help` works).
  if (wantsHelpFlag && cmd === 'daemon') {
    const stackName = stackNameFromArg(positionals, 1) || 'main';
    const passthrough = argv.slice(2);
    await cmdStackDaemon({ rootDir, stackName, argv: passthrough, json });
    return;
  }
  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: {
        commands: [
          'new',
          'edit',
          'list',
          'migrate',
          'audit',
          'archive',
          'duplicate',
          'info',
        'pr',
        'create-dev-auth-seed',
        'daemon',
        'happy',
        'env',
        'auth',
        'dev',
          'start',
          'build',
          'review',
          'typecheck',
          'lint',
          'test',
          'doctor',
          'mobile',
        'mobile:install',
        'mobile-dev-client',
          'resume',
          'stop',
          'code',
          'cursor',
          'open',
          'srv',
          'wt',
          'tailscale:*',
          'service:*',
        ],
      },
      text: [
        '[stack] usage:',
        '  happys stack new <name> [--port=NNN] [--server=happy-server|happy-server-light] [--happy=default|<owner/...>|<path>] [--interactive] [--copy-auth-from=<stack>] [--no-copy-auth] [--force-port] [--json]',
        '  happys stack edit <name> --interactive [--json]',
        '  happys stack list [--json]',
        '  happys stack migrate [--json]   # copy legacy env files from ~/.happy/local/stacks/* -> ~/.happy/stacks/*',
        '  happys stack audit [--fix] [--fix-main] [--fix-ports] [--fix-workspace] [--fix-paths] [--unpin-ports] [--unpin-ports-except=stack1,stack2] [--json]',
        '  happys stack archive <name> [--dry-run] [--date=YYYY-MM-DD] [--json]',
        '  happys stack duplicate <from> <to> [--duplicate-worktrees] [--deps=none|link|install|link-or-install] [--json]',
        '  happys stack info <name> [--json]',
        '  happys stack pr <name> --happy=<pr-url|number> [--happy-server-light=<pr-url|number>] [--dev|--start] [--json] [-- ...]',
        '  happys stack create-dev-auth-seed [name] [--server=happy-server|happy-server-light] [--login|--no-login] [--skip-default-seed] [--non-interactive] [--json]',
        '  happys stack daemon <name> start|stop|restart|status [--json]',
        '  happys stack happy <name> [-- ...]',
        '  happys stack env <name> set KEY=VALUE [KEY2=VALUE2...] | unset KEY [KEY2...] | get KEY | list | path [--json]',
        '  happys stack auth <name> status|login|copy-from [--json]',
        '  happys stack dev <name> [-- ...]',
        '  happys stack start <name> [-- ...]',
        '  happys stack build <name> [-- ...]',
        '  happys stack review <name> [component...] [--reviewers=coderabbit,codex] [--base-remote=<remote>] [--base-branch=<branch>] [--base-ref=<ref>] [--chunks|--no-chunks] [--chunking=auto|head-slice|commit-window] [--chunk-max-files=N] [--json]',
        '  happys stack typecheck <name> [component...] [--json]',
        '  happys stack lint <name> [component...] [--json]',
        '  happys stack test <name> [component...] [--json]',
        '  happys stack doctor <name> [-- ...]',
        '  happys stack mobile <name> [-- ...]',
        '  happys stack mobile:install <name> [--name="Happy (exp1)"] [--device=...] [--json]',
        '  happys stack mobile-dev-client <name> --install [--device=...] [--clean] [--configuration=Debug|Release] [--json]',
        '  happys stack resume <name> <sessionId...> [--json]',
        '  happys stack stop <name> [--aggressive] [--sweep-owned] [--no-docker] [--json]',
        '  happys stack code <name> [--no-stack-dir] [--include-all-components] [--include-cli-home] [--json]',
        '  happys stack cursor <name> [--no-stack-dir] [--include-all-components] [--include-cli-home] [--json]',
        '  happys stack open <name> [--no-stack-dir] [--include-all-components] [--include-cli-home] [--json]   # prefer Cursor, else VS Code',
        '  happys stack srv <name> -- status|use ...',
        '  happys stack wt <name> -- <wt args...>',
        '  happys stack tailscale:status|enable|disable|url <name> [-- ...]',
        '  happys stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
        '  happys stack service:* <name>   # legacy alias',
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'new') {
    await cmdNew({ rootDir, argv: argv.slice(1) });
    return;
  }
  if (cmd === 'edit') {
    await cmdEdit({ rootDir, argv });
    return;
  }
  if (cmd === 'list') {
    let names = [];
    try {
      const stacksDir = getStacksStorageRoot();
      const legacyStacksDir = join(getLegacyStorageRoot(), 'stacks');
      const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();
      const namesSet = new Set();
      const entries = await readdir(stacksDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'main') continue;
        namesSet.add(e.name);
      }
      try {
        if (allowLegacy) {
          const legacyEntries = await readdir(legacyStacksDir, { withFileTypes: true });
          for (const e of legacyEntries) {
            if (!e.isDirectory()) continue;
            namesSet.add(e.name);
          }
        }
      } catch {
        // ignore
      }
      names = Array.from(namesSet).sort();
    } catch {
      names = [];
    }
    if (json) {
      printResult({ json, data: { stacks: names } });
    } else {
      await cmdListStacks();
    }
    return;
  }

  if (cmd === 'migrate') {
    await cmdMigrate({ argv });
    return;
  }
  if (cmd === 'audit') {
    await cmdAudit({ rootDir, argv });
    return;
  }
  if (cmd === 'duplicate') {
    await cmdDuplicate({ rootDir, argv });
    return;
  }
  if (cmd === 'info') {
    await cmdInfo({ rootDir, argv });
    return;
  }
  if (cmd === 'pr') {
    await cmdPrStack({ rootDir, argv });
    return;
  }
  if (cmd === 'create-dev-auth-seed') {
    await cmdCreateDevAuthSeed({ rootDir, argv });
    return;
  }

  // Commands that need a stack name.
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    const helpLines =
      cmd === 'service'
        ? [
            '[stack] usage:',
            '  happys stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
            '',
            'example:',
            '  happys stack service exp1 status',
          ]
        : cmd === 'wt'
          ? [
              '[stack] usage:',
              '  happys stack wt <name> -- <wt args...>',
              '',
              'example:',
              '  happys stack wt exp1 -- use happy slopus/pr/123-fix-thing',
            ]
          : cmd === 'srv'
            ? [
                '[stack] usage:',
                '  happys stack srv <name> -- status|use ...',
                '',
                'example:',
                '  happys stack srv exp1 -- status',
              ]
          : cmd === 'env'
            ? [
                '[stack] usage:',
                '  happys stack env <name> set KEY=VALUE [KEY2=VALUE2...]',
                '  happys stack env <name> unset KEY [KEY2...]',
                '  happys stack env <name> get KEY',
                '  happys stack env <name> list',
                '  happys stack env <name> path',
              ]
            : cmd === 'daemon'
              ? [
                  '[stack] usage:',
                  '  happys stack daemon <name> start|stop|restart|status [--json]',
                  '',
                  'example:',
                  '  happys stack daemon main status',
                ]
            : cmd.startsWith('tailscale:')
              ? [
                  '[stack] usage:',
                  '  happys stack tailscale:status|enable|disable|url <name> [-- ...]',
                  '',
                  'example:',
                  '  happys stack tailscale:status exp1',
                ]
              : [
                  '[stack] missing stack name.',
                  'Run: happys stack --help',
                ];

    printResult({ json, data: { ok: false, error: 'missing_stack_name', cmd }, text: helpLines.join('\n') });
    process.exit(1);
  }

  // Remaining args after "<cmd> <name>"
  const passthrough = argv.slice(2);

  if (cmd === 'archive') {
    const res = await cmdArchiveStack({ rootDir, argv, stackName });
    if (json) {
      printResult({ json, data: res });
    } else if (res.dryRun) {
      console.log(`[stack] would archive "${stackName}" -> ${res.archivedStackDir} (dry-run)`);
    } else {
      console.log(`[stack] archived "${stackName}" -> ${res.archivedStackDir}`);
    }
    return;
  }

  if (cmd === 'env') {
    const hasPositional = passthrough.some((a) => !a.startsWith('-'));
    const envArgv = hasPositional ? passthrough : ['list', ...passthrough];
    // Forward to scripts/env.mjs under the stack env.
    // This keeps stack env editing behavior unified with `happys env ...`.
    await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        await run(process.execPath, [join(rootDir, 'scripts', 'env.mjs'), ...envArgv], { cwd: rootDir, env });
      },
    });
    return;
  }
  if (cmd === 'daemon') {
    await cmdStackDaemon({ rootDir, stackName, argv: passthrough, json });
    return;
  }
  if (cmd === 'eas') {
    // Forward EAS commands under the stack env.
    // Example:
    //   happys stack eas <name> build --platform ios --profile production
    await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        await run(process.execPath, [join(rootDir, 'scripts', 'eas.mjs'), ...passthrough], { cwd: rootDir, env });
      },
    });
    return;
  }
  if (cmd === 'happy') {
    // Allow stack-scoped CLI identity selection:
    // - `happys stack happy <name> --identity=account-a -- <happy-cli args...>`
    // - (no passthrough args) `happys stack happy <name> --identity=account-a`
    //
    // Implementation detail: we set HAPPY_HOME_DIR (highest precedence) so anything that uses
    // the CLI home dir (credentials, daemon control, logs, etc.) uses the selected identity.
    const sepIdx = passthrough.indexOf('--');
    const wrapperArgs = sepIdx === -1 ? passthrough : passthrough.slice(0, sepIdx);
    const forwardedArgsRaw = sepIdx === -1 ? passthrough : passthrough.slice(sepIdx + 1);

    // If there is no explicit `--`, treat `--identity=...` tokens as wrapper flags (since there are no
    // unambiguous happy-cli args to separate).
    const { kv } = parseArgs(wrapperArgs);
    const identityRaw = (kv.get('--identity') ?? '').toString().trim();
    const identity = identityRaw ? parseCliIdentityOrThrow(identityRaw) : null;

    const forwardedArgs =
      sepIdx === -1
        ? forwardedArgsRaw.filter((a) => !(identity && typeof a === 'string' && a.trim().startsWith('--identity=')))
        : forwardedArgsRaw;

    await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        // NOTE: resolve cli home using the *stack env* we just loaded, not the outer process env.
        // If identity is set, prefer our explicit HAPPY_HOME_DIR override.
        const baseCliHomeDir = (env.HAPPY_STACKS_CLI_HOME_DIR ??
          env.HAPPY_LOCAL_CLI_HOME_DIR ??
          join(resolveStackEnvPath(stackName).baseDir, 'cli')).toString();
        const cliHomeDirForIdentity = identity
          ? resolveCliHomeDirForIdentity({ cliHomeDir: baseCliHomeDir, identity })
          : baseCliHomeDir;
        const envForHappy = identity
          ? {
              ...env,
              HAPPY_STACKS_CLI_IDENTITY: identity,
              HAPPY_LOCAL_CLI_IDENTITY: identity,
              // Highest-precedence signal for happy-cli: identity-scoped home dir.
              HAPPY_HOME_DIR: cliHomeDirForIdentity,
              // Keep stack helpers consistent too (some scripts use *_CLI_HOME_DIR).
              HAPPY_STACKS_CLI_HOME_DIR: cliHomeDirForIdentity,
              HAPPY_LOCAL_CLI_HOME_DIR: cliHomeDirForIdentity,
            }
          : env;

        // Passthrough: preserve happy-cli output and exit code; avoid wrapper stack traces.
        const child = spawn(process.execPath, [join(rootDir, 'scripts', 'happy.mjs'), ...forwardedArgs], {
          cwd: rootDir,
          env: envForHappy,
          stdio: 'inherit',
          shell: false,
        });

        const exitCode = await new Promise((resolvePromise) => {
          child.on('error', () => resolvePromise(1));
          child.on('exit', (code) => resolvePromise(code ?? 1));
        });

        process.exit(exitCode);
      },
    });
    return;
  }
  if (cmd === 'dev') {
    const background = passthrough.includes('--background') || passthrough.includes('--bg');
    const args = background ? passthrough.filter((a) => a !== '--background' && a !== '--bg') : passthrough;
    await cmdRunScript({ rootDir, stackName, scriptPath: 'dev.mjs', args, background });
    return;
  }
  if (cmd === 'start') {
    const background = passthrough.includes('--background') || passthrough.includes('--bg');
    const args = background ? passthrough.filter((a) => a !== '--background' && a !== '--bg') : passthrough;
    await cmdRunScript({ rootDir, stackName, scriptPath: 'run.mjs', args, background });
    return;
  }
  if (cmd === 'build') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'build.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'typecheck') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'typecheck.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'lint') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'lint.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'test') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'test.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'review') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'review.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'doctor') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'doctor.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'mobile.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile-dev-client') {
    // Stack-scoped wrapper so the dev-client can be built from the stack's active happy checkout/worktree.
    await cmdRunScript({ rootDir, stackName, scriptPath: 'mobile_dev_client.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile:install') {
    const { flags: mFlags, kv: mKv } = parseArgs(passthrough);
    const device = (mKv.get('--device') ?? '').toString();
    const name = (mKv.get('--name') ?? mKv.get('--app-name') ?? '').toString().trim();
    const jsonOut = wantsJson(passthrough, { flags: mFlags }) || json;

    const envPath = resolveStackEnvPath(stackName).envPath;
    const existingRaw = await readExistingEnv(envPath);
    const existing = parseEnvToObject(existingRaw);

    const priorName =
      (existing.HAPPY_STACKS_MOBILE_RELEASE_IOS_APP_NAME ?? existing.HAPPY_LOCAL_MOBILE_RELEASE_IOS_APP_NAME ?? '').toString().trim();
    const identity = defaultStackReleaseIdentity({
      stackName,
      user: process.env.USER ?? process.env.USERNAME ?? 'user',
      appName: name || priorName || null,
    });

    // Persist the chosen identity so re-installs are stable and user-friendly.
    await ensureEnvFileUpdated({
      envPath,
      updates: [
        { key: 'HAPPY_STACKS_MOBILE_RELEASE_IOS_APP_NAME', value: identity.iosAppName },
        { key: 'HAPPY_STACKS_MOBILE_RELEASE_IOS_BUNDLE_ID', value: identity.iosBundleId },
        { key: 'HAPPY_STACKS_MOBILE_RELEASE_SCHEME', value: identity.scheme },
      ],
    });

    // Install a per-stack release-configured app (isolated container) without starting Metro.
    const args = [
      `--app-env=production`,
      `--ios-app-name=${identity.iosAppName}`,
      `--ios-bundle-id=${identity.iosBundleId}`,
      `--scheme=${identity.scheme}`,
      '--prebuild',
      '--run-ios',
      '--configuration=Release',
      '--no-metro',
      ...(device ? [`--device=${device}`] : []),
    ];

    await cmdRunScript({ rootDir, stackName, scriptPath: 'mobile.mjs', args });

    if (jsonOut) {
      printResult({
        json: true,
        data: { ok: true, stackName, installed: true, identity },
      });
    }
    return;
  }
  if (cmd === 'resume') {
    const sessionIds = passthrough.filter((a) => a && a !== '--' && !a.startsWith('--'));
    if (sessionIds.length === 0) {
      printResult({
        json,
        data: { ok: false, error: 'missing_session_ids' },
        text: [
          '[stack] usage:',
          '  happys stack resume <name> <sessionId...>',
        ].join('\n'),
      });
      process.exit(1);
    }
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        // IMPORTANT: use the stack's pinned happy-cli checkout if set.
        // Do not read component dirs from this process's `process.env` (withStackEnv does not mutate it).
        const cliDir = (env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI ?? env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI ?? '').toString().trim() || getComponentDir(rootDir, 'happy-cli');
        const happyBin = join(cliDir, 'bin', 'happy.mjs');
        // Run stack-scoped happy-cli and ask the stack daemon to resume these sessions.
        return await run(process.execPath, [happyBin, 'daemon', 'resume', ...sessionIds], { cwd: rootDir, env });
      },
    });
    if (json) printResult({ json, data: { ok: true, resumed: sessionIds, out } });
    return;
  }

  if (cmd === 'stop') {
    const { flags: stopFlags } = parseArgs(passthrough);
    const noDocker = stopFlags.has('--no-docker');
    const aggressive = stopFlags.has('--aggressive');
    const sweepOwned = stopFlags.has('--sweep-owned');
    const baseDir = resolveStackEnvPath(stackName).baseDir;
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        return await stopStackWithEnv({ rootDir, stackName, baseDir, env, json, noDocker, aggressive, sweepOwned });
      },
    });
    if (json) printResult({ json, data: { ok: true, stopped: out } });
    return;
  }

  if (cmd === 'code') {
    const includeStackDir = !flags.has('--no-stack-dir');
    const includeAllComponents = flags.has('--include-all-components');
    const includeCliHome = flags.has('--include-cli-home');
    await cmdStackCodeOrCursor({ rootDir, stackName, json, editor: 'code', includeStackDir, includeAllComponents, includeCliHome });
    return;
  }
  if (cmd === 'cursor') {
    const includeStackDir = !flags.has('--no-stack-dir');
    const includeAllComponents = flags.has('--include-all-components');
    const includeCliHome = flags.has('--include-cli-home');
    await cmdStackCodeOrCursor({ rootDir, stackName, json, editor: 'cursor', includeStackDir, includeAllComponents, includeCliHome });
    return;
  }
  if (cmd === 'open') {
    const includeStackDir = !flags.has('--no-stack-dir');
    const includeAllComponents = flags.has('--include-all-components');
    const includeCliHome = flags.has('--include-cli-home');
    await cmdStackOpen({ rootDir, stackName, json, includeStackDir, includeAllComponents, includeCliHome });
    return;
  }

  if (cmd === 'srv') {
    await cmdSrv({ rootDir, stackName, args: passthrough });
    return;
  }
  if (cmd === 'wt') {
    await cmdWt({ rootDir, stackName, args: passthrough });
    return;
  }
  if (cmd === 'auth') {
    await cmdAuth({ rootDir, stackName, args: passthrough });
    return;
  }

  if (cmd === 'service') {
    const svcCmd = passthrough[0];
    if (!svcCmd) {
      printResult({
        json,
        data: { ok: false, error: 'missing_service_subcommand', stackName },
        text: [
          '[stack] usage:',
          '  happys stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
          '',
          'example:',
          `  happys stack service ${stackName} status`,
        ].join('\n'),
      });
      process.exit(1);
    }
    await cmdService({ rootDir, stackName, svcCmd });
    return;
  }

  if (cmd.startsWith('service:')) {
    const svcCmd = cmd.slice('service:'.length);
    await cmdService({ rootDir, stackName, svcCmd });
    return;
  }
  if (cmd.startsWith('tailscale:')) {
    const subcmd = cmd.slice('tailscale:'.length);
    await cmdTailscale({ rootDir, stackName, subcmd, args: passthrough });
    return;
  }

  if (flags.has('--interactive') && cmd === 'help') {
    // no-op
  }

  console.log(`[stack] unknown command: ${cmd}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[stack] failed:', message);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
