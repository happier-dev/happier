import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir, getStackName, resolveExplicitStackEnvFilePath } from './utils/paths/paths.mjs';
import { resolveCliHomeDir } from './utils/stack/dirs.mjs';
import { getPublicServerUrlEnvOverride, resolveStackCanonicalServerUrl, resolveStackServerEndpoint } from './utils/server/urls.mjs';
import { resolveStackEnvPath } from './utils/paths/paths.mjs';
import {
  applyStackActiveServerScopeEnv,
  applyStackDaemonLifecycleScopeEnv,
} from './utils/auth/stable_scope_id.mjs';
import { resolveCliDistEntrypointFromBin } from './utils/cli/cliDistIntegrity.mjs';
import { resolveStackRuntimeLaunchContext } from './runtime/launch/resolveStackRuntimeLaunchContext.mjs';
import {
  applyCliRuntimeLaunchProvenanceEnv,
  resolveCliRuntimeLaunchSpec,
} from './runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { resolveCliEntrypoint } from './runtime/launch/resolveCliEntrypoint.mjs';
import { ensureStackDaemonPreflight, requiresStackDaemonPreflight } from './stack/stack_happier_daemon_preflight.mjs';
import { isPidAlive, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import {
  assertStackServerProfileReconciled,
  buildStackServerProfileSetArgs,
  deriveEnvServerIdFromUrl,
  readActiveServerUrlsFromCliSettings,
} from './utils/stack/server_profile_reconciliation.mjs';
import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';

function isNodeRuntimeEntrypoint(entrypoint) {
  return /\.(?:cjs|js|mjs)$/i.test(String(entrypoint ?? '').trim());
}

function runCliProfileReconciliation({ resolvedCli, env, cliHomeDir, internalServerUrl, publicServerUrl }) {
  const serverId = String(env.HAPPIER_ACTIVE_SERVER_ID ?? '').trim();
  const args = buildStackServerProfileSetArgs({ serverId, internalServerUrl, publicServerUrl });
  const result =
    resolvedCli.kind === 'runtime'
      ? spawnSync(resolvedCli.command, [...resolvedCli.args, ...args], { stdio: 'ignore', env })
      : spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', ...resolvedCli.nodeArgs, ...args], {
          stdio: 'ignore',
          env,
        });
  if (result.error || result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit=${result.status ?? 'unknown'}`;
    throw new Error(`[happier] failed to refresh the stack-owned relay profile before launch (${detail}).`);
  }
  assertStackServerProfileReconciled({
    homeDir: cliHomeDir,
    serverId,
    internalServerUrl,
    publicServerUrl,
  });
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

function splitHstackHappierWrapperArgs(argv) {
  const wrapperFlags = ['--stack-help', '--runtime', '--source'];
  let childIndex = 0;
  while (wrapperFlags.includes(argv[childIndex]) || String(argv[childIndex] ?? '').startsWith('--runtime=')) childIndex += 1;
  // Mode flags belong to the wrapper prefix. Everything from the child command
  // onward, including a child's own separator, belongs to the CLI.
  return {
    wrapperArgv: argv.slice(0, childIndex),
    forwardedArgv: argv.slice(argv[childIndex] === '--' ? childIndex + 1 : childIndex),
  };
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

function isIdentityScopedCliHomeDir(value) {
  return /(^|[\\/])cli-identities([\\/]|$)/.test(String(value ?? '').trim());
}

function resolvePhysicalPathAllowMissing(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const resolved = resolve(raw);
  const missingParts = [];
  let current = resolved;

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolved;
    missingParts.unshift(basename(current));
    current = parent;
  }

  try {
    const physicalExisting = realpathSync(current);
    return missingParts.length > 0 ? resolve(physicalExisting, ...missingParts) : physicalExisting;
  } catch {
    return resolved;
  }
}

function isPathInside(baseDir, candidate) {
  const base = String(baseDir ?? '').trim();
  const value = String(candidate ?? '').trim();
  if (!base || !value) return false;
  try {
    const rel = relative(resolvePhysicalPathAllowMissing(base), resolvePhysicalPathAllowMissing(value));
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function resolveStackCliHomeOverrideForBase(value, stackBaseDir) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return isPathInside(stackBaseDir, raw) ? raw : '';
}

async function main() {
  const argv = process.argv.slice(2);
  const { wrapperArgv, forwardedArgv } = splitHstackHappierWrapperArgs(argv);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wrapperArgv.includes('--stack-help')) {
    printHstackHappierHelp({ json });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const stackName = (process.env.HAPPIER_STACK_STACK ?? '').toString().trim() || getStackName();
  const stackEnvPathInfo = resolveStackEnvPath(stackName, process.env);
  const runtimeStatePath = join(stackEnvPathInfo.baseDir, 'stack.runtime.json');
  const endpoint = await resolveStackServerEndpoint({ stackName });
  const serverPort = endpoint.port;
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
  // Bare --runtime follows the running daemon's code basis. An explicit
  // --runtime=built remains an intentional request for a native snapshot.
  const hasLoadedSourceRuntime = Boolean(activeRuntimeState?.sourceRuntimeIdentities?.daemon?.loaded);
  const runtimeArgv = hasLoadedSourceRuntime
    ? wrapperArgv.map(arg => arg === '--runtime' ? '--runtime=source' : arg)
    : wrapperArgv;
  if (hasLoadedSourceRuntime && !runtimeArgv.includes('--source') && !runtimeArgv.includes('--runtime=built')) {
    const sourceEntrypoint = activeRuntimeState.sourceRuntimeLaunch?.entrypoint;
    if (!sourceEntrypoint || !existsSync(sourceEntrypoint)) {
      throw new Error('[happier] loaded source CLI is unavailable; restore the recorded source runtime before using this stack.');
    }
  }
  const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({
    argv: runtimeArgv,
    env: process.env,
    activeRuntimeState,
  });

  const internalServerUrl = endpoint.internalServerUrl;
  let { publicServerUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort, stackName });

  const cliLaunchSpec = runtimeLaunchContext.cliLaunchSpec
    ?? (runtimeLaunchContext.snapshot ? resolveCliRuntimeLaunchSpec({ snapshot: runtimeLaunchContext.snapshot }) : null);
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
    : resolveCliEntrypoint({
        cliDir,
        preferSource: runtimeLaunchContext.runtimeMode.mode === 'source',
      });
  if (wantsHelp(argv, { flags }) && !resolvedCli) {
    printHstackHappierHelp({ json });
    return;
  }
  if (!resolvedCli) {
    const expectedPackagedEntrypoint = resolveCliDistEntrypointFromBin(join(cliDir, 'bin', 'happier.mjs'));
    console.error(`[happier] missing CLI build at: ${expectedPackagedEntrypoint}`);
    console.error('Run: hstack bootstrap');
    process.exit(1);
  }

  let env = { ...process.env };
  // IMPORTANT:
  // When running under a stack-scoped wrapper (`hstack stack happier <name>` / `hstack <stack> happier`),
  // the user's CLI settings.json may still point at Happier Cloud (or another server). We must not let that
  // override the stack-local server URL; otherwise stack-scoped commands would silently target the wrong
  // server and resolve credentials from the wrong per-server directory.
  //
  // We treat an invocation as "stack-scoped" only when the stack env file actually exists (or when the
  // CLI home dir is explicitly overridden by the stack). This keeps plain `hstack happier` able to
  // reuse the user's CLI settings even when stack helper env vars are present in test/dev harnesses.
  const stackEnvFilePath = resolveExplicitStackEnvFilePath(env);
  const stackCliHomeOverride = resolveStackCliHomeOverrideForBase(
    env.HAPPIER_STACK_CLI_HOME_DIR,
    stackEnvPathInfo.baseDir,
  );
  const isStackScopedInvocation =
    Boolean(stackCliHomeOverride) ||
    Boolean(stackEnvFilePath && existsSync(stackEnvFilePath));
  if (isStackScopedInvocation) {
    publicServerUrl = endpoint.publicServerUrl
      ?? await resolveStackCanonicalServerUrl({ env: process.env, serverPort, stackName });
  }
  const explicitHomeDir = String(env.HAPPIER_HOME_DIR ?? '').trim();
  const explicitStackIdentityHomeDir =
    isIdentityScopedCliHomeDir(explicitHomeDir) && isPathInside(stackEnvPathInfo.baseDir, explicitHomeDir)
      ? explicitHomeDir
      : '';
  const stackScopedCliHomeDir =
    (explicitStackIdentityHomeDir
      ? explicitStackIdentityHomeDir
      : (stackCliHomeOverride || join(stackEnvPathInfo.baseDir, 'cli')));
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
  // Only set default env vars when no explicit server selection flags are present.
  // Stack-scoped invocations must overwrite stale globals loaded by the wrapper bootstrap;
  // otherwise commands can silently target another stack's daemon/server.
  if (!prefixServerSelection.hasExplicitSelection && !settingsDefaults) {
    if (isStackScopedInvocation) {
      env.HAPPIER_PUBLIC_SERVER_URL = publicServerUrl;
      env.HAPPIER_LOCAL_SERVER_URL = internalServerUrl;
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
    // we provide the selected checkout's explicit path. Do not preserve an ambient value here: nested
    // stack/agent invocations often inherit TSX_TSCONFIG_PATH from another checkout.
    env.TSX_TSCONFIG_PATH = resolvedCli.tsconfigPath;
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

  env = applyCliRuntimeLaunchProvenanceEnv({ env, cliLaunchSpec });
  if (isStackScopedInvocation && !prefixServerSelection.hasExplicitSelection) {
    runCliProfileReconciliation({ resolvedCli, env, cliHomeDir, internalServerUrl, publicServerUrl });
  }
  if (isStackScopedInvocation && requiresStackDaemonPreflight(forwardedArgv)) {
    const cliIdentity = (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default';
    await ensureStackDaemonPreflight({
      rootDir,
      stackName,
      env: process.env,
      argv: wrapperArgv,
      cliIdentity,
      activeRuntimeState,
    });
  }
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
