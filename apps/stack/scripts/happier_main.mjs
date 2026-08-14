import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir, getStackName, resolveExplicitStackEnvFilePath } from './utils/paths/paths.mjs';
import { resolveCliHomeDir } from './utils/stack/dirs.mjs';
import { getPublicServerUrlEnvOverride, resolveServerPortFromEnv } from './utils/server/urls.mjs';
import { resolveLocalServerPortForStack } from './utils/server/resolve_stack_server_port.mjs';
import { STACK_RESERVED_PORT_KEYS } from './utils/server/port.mjs';
import { resolveStackEnvPath } from './utils/paths/paths.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import {
  applyStackActiveServerScopeEnv,
  applyStackDaemonLifecycleScopeEnv,
  buildStackStableScopeId,
} from './utils/auth/stable_scope_id.mjs';
import { probeCliDistRuntimeImport, readCliDistIntegrity } from './utils/cli/cliDistIntegrity.mjs';
import { resolveStackRuntimeLaunchContext } from './runtime/launch/resolveStackRuntimeLaunchContext.mjs';
import { isPidAlive, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import {
  applyCliRuntimeLaunchProvenanceEnv,
  resolveCliRuntimeLaunchSpec,
} from './runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/providers/managedJavaScriptRuntime';
import { createServerUrlComparableKey } from '@happier-dev/protocol';

function isNodeRuntimeEntrypoint(entrypoint) {
  return /\.(?:cjs|js|mjs)$/i.test(String(entrypoint ?? '').trim());
}

function printHstackHappierHelp({ json }) {
  printResult({
    json,
    data: { passthrough: true },
    text: [
      '[happier] usage:',
      '  hstack happier <happier-cli args...>',
      '',
      'notes:',
      '  - This runs the monorepo CLI component (apps/cli) with stack env defaults.',
      '  - It auto-fills HAPPIER_HOME_DIR / HAPPIER_SERVER_URL / HAPPIER_WEBAPP_URL when missing.',
      '',
      'stack wrapper options:',
      '  --stack-help  Show this wrapper help (use -h/--help for CLI help)',
    ].join('\n'),
  });
}

function stripHstackHappierWrapperFlags(argv) {
  return argv.filter((arg) => arg !== '--stack-help' && arg !== '--runtime' && arg !== '--source');
}

function takePrefixFlagValue(args, name) {
  const a0 = String(args[0] ?? '');
  if (a0 === name) {
    const next = String(args[1] ?? '');
    const value = next.trim();
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    return { value, consumed: 2 };
  }
  if (a0.startsWith(`${name}=`)) {
    const value = a0.slice(name.length + 1).trim();
    if (!value) {
      throw new Error(`Missing value for ${name}`);
    }
    return { value, consumed: 1 };
  }
  return { value: null, consumed: 0 };
}

function readPrefixServerSelection(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a ?? '')) : [];
  const readExplicitServerFlags = (scanArgs, { includeServer }) => {
    let server = null;
    let serverUrl = null;
    let webappUrl = null;
    let publicServerUrl = null;
    let localServerUrl = null;

    for (let i = 0; i < scanArgs.length; i += 1) {
      const slice = scanArgs.slice(i);

      if (includeServer) {
        const serverFlag = takePrefixFlagValue(slice, '--server');
        if (serverFlag.consumed) {
          server = serverFlag.value;
          i += serverFlag.consumed - 1;
          continue;
        }
      }
      const serverUrlFlag = takePrefixFlagValue(slice, '--server-url');
      if (serverUrlFlag.consumed) {
        serverUrl = serverUrlFlag.value;
        i += serverUrlFlag.consumed - 1;
        continue;
      }
      const webappUrlFlag = takePrefixFlagValue(slice, '--webapp-url');
      if (webappUrlFlag.consumed) {
        webappUrl = webappUrlFlag.value;
        i += webappUrlFlag.consumed - 1;
        continue;
      }
      const localServerUrlFlag = takePrefixFlagValue(slice, '--local-server-url');
      if (localServerUrlFlag.consumed) {
        localServerUrl = localServerUrlFlag.value;
        i += localServerUrlFlag.consumed - 1;
        continue;
      }
      const publicServerUrlFlag = takePrefixFlagValue(slice, '--public-server-url');
      if (publicServerUrlFlag.consumed) {
        publicServerUrl = publicServerUrlFlag.value;
        i += publicServerUrlFlag.consumed - 1;
      }
    }

    return { server, serverUrl, webappUrl, publicServerUrl, localServerUrl };
  };

  const { server, serverUrl, webappUrl, publicServerUrl, localServerUrl } = readExplicitServerFlags(args, { includeServer: true });

  return {
    hasExplicitSelection: Boolean(server || serverUrl || webappUrl || publicServerUrl || localServerUrl),
    explicitServerUrl: serverUrl || publicServerUrl || null,
  };
}

function normalizeServerUrl(url) {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function comparableServerUrl(url) {
  const normalized = normalizeServerUrl(url);
  if (!normalized) return '';
  try {
    return createServerUrlComparableKey(normalized);
  } catch {
    return '';
  }
}

function deriveEnvServerIdFromUrl(url) {
  const normalized = comparableServerUrl(url) || normalizeServerUrl(url);
  if (!normalized) return null;
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function coerceServerProfileFromSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const serverUrl = normalizeServerUrl(raw.serverUrl);
  const webappUrl = normalizeServerUrl(raw.webappUrl);
  const localServerUrl = normalizeServerUrl(raw.localServerUrl);
  const legacyPublicServerUrl = normalizeServerUrl(raw.publicServerUrl);
  const canonicalServerUrl = legacyPublicServerUrl && legacyPublicServerUrl !== serverUrl ? legacyPublicServerUrl : serverUrl;
  if (!id || !canonicalServerUrl || !webappUrl) return null;
  return {
    id,
    serverUrl: canonicalServerUrl,
    localServerUrl: localServerUrl || null,
    webappUrl,
  };
}

function resolveStackScopedWrapperEnv({ env = process.env, stackName }) {
  const base = { ...(env ?? {}) };
  const name = String(stackName ?? '').trim() || getStackName(base);
  const explicitEnvPath = resolveExplicitStackEnvFilePath(base);
  const implicitEnvPath = resolveStackEnvPath(name, base).envPath;
  const stackEnvPath = explicitEnvPath || (existsSync(implicitEnvPath) ? implicitEnvPath : '');
  if (!stackEnvPath || !existsSync(stackEnvPath)) {
    return { env: base, stackEnvPath: '' };
  }

  let parsed = {};
  try {
    parsed = parseEnvToObject(readFileSync(stackEnvPath, 'utf-8'));
  } catch {
    parsed = {};
  }

  const next = {
    ...base,
    ...parsed,
    HAPPIER_STACK_STACK: name,
    HAPPIER_STACK_ENV_FILE: stackEnvPath,
  };
  for (const key of STACK_RESERVED_PORT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      delete next[key];
    }
  }
  return { env: next, stackEnvPath };
}

function readActiveServerUrlsFromCliSettings(homeDir) {
  const baseDir = String(homeDir ?? '').trim();
  if (!baseDir) return null;
  const settingsPath = join(baseDir, 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const schemaVersion = Number(parsed.schemaVersion ?? 0);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 5) return null;
    const activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId.trim() : '';
    const servers = parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : null;
    if (!activeServerId || !servers) return null;
    return coerceServerProfileFromSettings(servers[activeServerId]);
  } catch {
    return null;
  }
}

function isIdentityScopedCliHomeDir(value) {
  return /(^|[\\/])cli-identities([\\/]|$)/.test(String(value ?? '').trim());
}

function bestEffortReconcileStackServerProfileInCliSettings({ cliHomeDir, stackName, cliIdentity, internalServerUrl, publicServerUrl }) {
  const home = String(cliHomeDir ?? '').trim();
  if (!home) return;
  const serverUrl = normalizeServerUrl(internalServerUrl);
  const webappUrl = normalizeServerUrl(publicServerUrl);
  if (!serverUrl || !webappUrl) return;

  const settingsPath = join(home, 'settings.json');
  if (!existsSync(settingsPath)) return;

  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const schemaVersion = Number(parsed.schemaVersion ?? 0);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 5) return;

  const serversRaw = parsed.servers && typeof parsed.servers === 'object' ? parsed.servers : {};
  const servers = { ...serversRaw };

  const matchingIds = Object.entries(servers).filter(([, profile]) => {
    const coerced = coerceServerProfileFromSettings(profile);
    if (!coerced) return false;
    const targetComparableKey = comparableServerUrl(serverUrl);
    return (
      (targetComparableKey && comparableServerUrl(coerced.serverUrl) === targetComparableKey)
      || (targetComparableKey && comparableServerUrl(coerced.localServerUrl) === targetComparableKey)
      || normalizeServerUrl(coerced.serverUrl) === serverUrl
      || normalizeServerUrl(coerced.localServerUrl) === serverUrl
    );
  }).map(([id]) => id);

  const stableId = buildStackStableScopeId({ stackName, cliIdentity });
  const activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId.trim() : '';
  const sourceId = matchingIds.includes(activeServerId)
    ? activeServerId
    : matchingIds.length === 1
      ? matchingIds[0]
      : '';
  const targetId = stableId;

  const source = sourceId && servers[sourceId] && typeof servers[sourceId] === 'object' ? servers[sourceId] : {};
  const existing = servers[targetId] && typeof servers[targetId] === 'object' ? servers[targetId] : source;
  const now = Date.now();
  const nextProfile = {
    ...existing,
    id: targetId,
    name: typeof existing.name === 'string' && existing.name.trim() ? existing.name : `Stack ${stackName}`,
    serverUrl,
    localServerUrl: serverUrl,
    webappUrl,
    createdAt: Number.isFinite(existing.createdAt) ? existing.createdAt : now,
    updatedAt: now,
    lastUsedAt: now,
  };

  let nextSettings = { ...parsed, activeServerId: targetId, servers: { ...servers, [targetId]: nextProfile } };
  let didMigrateServerScopedState = false;
  if (sourceId && sourceId !== targetId) {
    const migrateServerScopedEntry = (key) => {
      const sourceMap = parsed[key];
      if (!sourceMap || typeof sourceMap !== 'object' || !(sourceId in sourceMap)) return;
      const targetMap = { ...sourceMap };
      if (!(targetId in targetMap)) {
        targetMap[targetId] = sourceMap[sourceId];
        didMigrateServerScopedState = true;
      }
      nextSettings = { ...nextSettings, [key]: targetMap };
    };
    for (const key of [
      'machineIdByServerId',
      'machineIdByServerIdByAccountId',
      'machineReplacementCandidatesByServerIdByAccountId',
      'lastTokenSubByServerId',
      'machineIdConfirmedByServerByServerId',
      'lastChangesCursorByServerIdByAccountId',
    ]) {
      migrateServerScopedEntry(key);
    }
  }

  const shouldWrite =
    parsed.activeServerId !== targetId ||
    !servers[targetId] ||
    normalizeServerUrl(servers[targetId].serverUrl) !== serverUrl ||
    normalizeServerUrl(servers[targetId].webappUrl) !== webappUrl ||
    didMigrateServerScopedState;

  if (!shouldWrite) return;

  try {
    writeFileSync(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', 'utf-8');
  } catch {
    // best-effort
  }
}

async function resolveCliEntrypoint(cliDir) {
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const distIntegrity = readCliDistIntegrity(distEntrypoint);
  if (distIntegrity.ok) {
    try {
      await probeCliDistRuntimeImport(distEntrypoint, { cwd: cliDir });
      return { kind: 'dist', nodeArgs: [distEntrypoint], distEntrypoint };
    } catch {
      // Fall through to the source entrypoint when the completed build cannot link at runtime.
    }
  }

  const srcEntrypoint = join(cliDir, 'src', 'index.ts');
  if (!existsSync(srcEntrypoint)) {
    return null;
  }

  try {
    const require = createRequire(import.meta.url);
    const tsxPkgJsonPath = require.resolve('tsx/package.json');
    const tsxLoaderPath = join(dirname(tsxPkgJsonPath), 'dist', 'esm', 'index.mjs');
    if (!existsSync(tsxLoaderPath)) return null;
    return {
      kind: 'tsx',
      nodeArgs: ['--import', tsxLoaderPath, srcEntrypoint],
      distEntrypoint,
      tsconfigPath: join(cliDir, 'tsconfig.json'),
    };
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (flags.has('--stack-help')) {
    printHstackHappierHelp({ json });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const initialStackName = (process.env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName();
  const stackEnvContext = resolveStackScopedWrapperEnv({ env: process.env, stackName: initialStackName });
  const baseProcessEnv = stackEnvContext.env;
  const stackName = (baseProcessEnv.HAPPIER_STACK_STACK ?? '').toString().trim() || initialStackName;
  const stackBaseDir = stackEnvContext.stackEnvPath
    ? dirname(stackEnvContext.stackEnvPath)
    : resolveStackEnvPath(stackName, baseProcessEnv).baseDir;
  const runtimeStatePath = join(stackBaseDir, 'stack.runtime.json');
  const serverPort = await resolveLocalServerPortForStack({
    env: baseProcessEnv,
    stackMode: true,
    stackName,
    runtimeStatePath,
    defaultPort: 3005,
  });
  const prefixServerSelection = readPrefixServerSelection(argv);
  const recordedRuntimeState = await readStackRuntimeStateFile(runtimeStatePath);
  const recordedRuntimeOwnerPid = Number(recordedRuntimeState?.ownerPid);
  const activeRuntimeState =
    String(recordedRuntimeState?.stackName ?? '').trim() === stackName &&
    Number.isFinite(recordedRuntimeOwnerPid) &&
    recordedRuntimeOwnerPid > 1 &&
    isPidAlive(recordedRuntimeOwnerPid)
    ? recordedRuntimeState
    : null;
  const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({
    argv,
    env: baseProcessEnv,
    activeRuntimeState,
  });

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const { publicServerUrl } = getPublicServerUrlEnvOverride({ env: baseProcessEnv, serverPort, stackName });

  const cliLaunchSpec = runtimeLaunchContext.snapshot ? resolveCliRuntimeLaunchSpec({ snapshot: runtimeLaunchContext.snapshot }) : null;
  const cliDir = cliLaunchSpec?.cliDir ?? getComponentDir(rootDir, 'happier-cli');
  const resolvedCli = cliLaunchSpec
    ? isNodeRuntimeEntrypoint(cliLaunchSpec.entrypoint)
      ? {
          kind: 'runtime-node',
          nodeArgs: [cliLaunchSpec.entrypoint],
          distEntrypoint: cliLaunchSpec.entrypoint,
        }
      : {
          kind: 'runtime',
          command: cliLaunchSpec.command,
          args: cliLaunchSpec.args,
          distEntrypoint: cliLaunchSpec.entrypoint,
        }
    : await resolveCliEntrypoint(cliDir);
  if (wantsHelp(argv, { flags }) && !resolvedCli) {
    printHstackHappierHelp({ json });
    return;
  }
  if (!resolvedCli) {
    const expectedDistEntrypoint = join(cliDir, 'dist', 'index.mjs');
    console.error(`[happier] missing CLI build at: ${expectedDistEntrypoint}`);
    console.error('Run: hstack bootstrap');
    process.exit(1);
  }

  let env = { ...baseProcessEnv };
  // IMPORTANT:
  // When running under a stack-scoped wrapper (`hstack stack happier <name>` / `hstack <stack> happier`),
  // the user's CLI settings.json may still point at Happier Cloud (or another server). We must not let that
  // override the stack-local server URL; otherwise stack-scoped commands would silently target the wrong
  // server and resolve credentials from the wrong per-server directory.
  //
  // We treat an invocation as "stack-scoped" only when the stack env file actually exists (or when the
  // CLI home dir is explicitly overridden by the stack). This keeps plain `hstack happier` able to
  // reuse the user's CLI settings even when stack helper env vars are present in test/dev harnesses.
  const stackEnvFilePath = stackEnvContext.stackEnvPath || resolveExplicitStackEnvFilePath(env);
  const isStackScopedInvocation =
    Boolean(String(env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim()) ||
    Boolean(stackEnvFilePath && existsSync(stackEnvFilePath));
  const explicitHomeDir = String(env.HAPPIER_HOME_DIR ?? '').trim();
  const stackScopedCliHomeDir =
    (isIdentityScopedCliHomeDir(explicitHomeDir)
      ? explicitHomeDir
      : (String(env.HAPPIER_STACK_CLI_HOME_DIR ?? '').trim() ||
        join(stackBaseDir, 'cli')));
  const cliHomeDir = isStackScopedInvocation
    ? resolveCliHomeDir(
        {
          ...process.env,
          HAPPIER_STACK_CLI_HOME_DIR: stackScopedCliHomeDir,
        },
        { preferStackCliHomeDir: true },
      )
    : resolveCliHomeDir(process.env);

  if (isStackScopedInvocation) {
    env.HAPPIER_HOME_DIR = cliHomeDir;
  } else {
    env.HAPPIER_HOME_DIR = env.HAPPIER_HOME_DIR || cliHomeDir;
  }

  if (isStackScopedInvocation && !prefixServerSelection.hasExplicitSelection) {
    const cliIdentity = (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default';
    bestEffortReconcileStackServerProfileInCliSettings({
      cliHomeDir,
      stackName,
      cliIdentity,
      internalServerUrl,
      publicServerUrl,
    });
  }

  const settingsDefaults =
    !isStackScopedInvocation && !prefixServerSelection.hasExplicitSelection
      ? readActiveServerUrlsFromCliSettings(env.HAPPIER_HOME_DIR)
      : null;
  if (settingsDefaults) {
    if (settingsDefaults.localServerUrl && settingsDefaults.localServerUrl !== settingsDefaults.serverUrl) {
      env.HAPPIER_PUBLIC_SERVER_URL = settingsDefaults.serverUrl;
      env.HAPPIER_LOCAL_SERVER_URL = settingsDefaults.localServerUrl;
      env.HAPPIER_SERVER_URL = settingsDefaults.localServerUrl;
    } else {
      delete env.HAPPIER_PUBLIC_SERVER_URL;
      delete env.HAPPIER_LOCAL_SERVER_URL;
      env.HAPPIER_SERVER_URL = settingsDefaults.serverUrl;
    }
    env.HAPPIER_WEBAPP_URL = settingsDefaults.webappUrl;
    delete env.HAPPIER_ACTIVE_SERVER_ID;
    delete env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID;
  }
  // Only set default env vars when no explicit server selection flags are present
  if (!prefixServerSelection.hasExplicitSelection && !settingsDefaults) {
    if (isStackScopedInvocation) {
      env.HAPPIER_SERVER_URL = internalServerUrl;
      env.HAPPIER_WEBAPP_URL = publicServerUrl;
    } else {
      env.HAPPIER_SERVER_URL = env.HAPPIER_SERVER_URL || internalServerUrl;
      env.HAPPIER_WEBAPP_URL = env.HAPPIER_WEBAPP_URL || publicServerUrl;
    }
  }
  if (resolvedCli.kind === 'tsx') {
    // TSX resolves path aliases (`@/...`) using the tsconfig it finds. When the CLI runs from arbitrary
    // working directories (common in stack + daemon flows), it can pick up the wrong tsconfig unless
    // we provide an explicit path.
    env.TSX_TSCONFIG_PATH = env.TSX_TSCONFIG_PATH || resolvedCli.tsconfigPath;
  }
  if (prefixServerSelection.hasExplicitSelection) {
    // If the user explicitly selects a server/profile, do not force a stack-stable active server id.
    // Otherwise credentials can be resolved from the wrong per-server directory, causing 401s.
    const derived = prefixServerSelection.explicitServerUrl
      ? deriveEnvServerIdFromUrl(prefixServerSelection.explicitServerUrl)
      : null;
    if (derived) {
      env.HAPPIER_ACTIVE_SERVER_ID = derived;
    } else {
      delete env.HAPPIER_ACTIVE_SERVER_ID;
    }
    delete env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID;
  } else if (!settingsDefaults) {
    env = applyStackDaemonLifecycleScopeEnv({
      env: applyStackActiveServerScopeEnv({
        env,
        stackName,
        cliIdentity: (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
      }),
      stackName,
      cliIdentity: (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default',
    });
  }

  if (cliLaunchSpec?.nodeEntrypoint) {
    const runtimeCommand = resolveJavaScriptRuntimeCommand({
      isBunRuntime: false,
      processEnv: env,
      currentExecPath: cliLaunchSpec.command || '',
    });
    if (runtimeCommand) {
      env.HAPPIER_DAEMON_SERVICE_NODE_PATH = runtimeCommand;
      env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH = cliLaunchSpec.nodeEntrypoint;
    }
  }

  env = applyCliRuntimeLaunchProvenanceEnv({ env, cliLaunchSpec });
  const forwardedArgv = stripHstackHappierWrapperFlags(argv);
  const res =
    resolvedCli.kind === 'runtime'
      ? spawnSync(resolvedCli.command, [...resolvedCli.args, ...forwardedArgv], {
          stdio: 'inherit',
          env,
        })
      : spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', ...resolvedCli.nodeArgs, ...forwardedArgv], {
          stdio: 'inherit',
          env,
        });

  if (res.error) {
    const msg = res.error instanceof Error ? res.error.message : String(res.error);
    console.error(`[happier] failed to run CLI: ${msg}`);
    process.exit(1);
  }

  process.exit(res.status ?? 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[happier] failed:', message);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
