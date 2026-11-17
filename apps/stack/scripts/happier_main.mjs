import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir, getStackName } from './utils/paths/paths.mjs';
import { readPrefixServerSelection, resolveStackHappierCliHome, splitHstackHappierWrapperArgs } from './stack/stack_happier_passthrough_entrypoint.mjs';
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
import { readActiveStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { projectBorrowedExpoWebappEnv } from './runtime/shared/borrowed_expo.mjs';
import {
  assertStackServerProfileReconciled,
  buildStackServerProfileSetArgs,
  stackOwnsServerProfile,
  deriveEnvServerIdFromUrl,
  readActiveServerUrlsFromCliSettings,
} from './utils/stack/server_profile_reconciliation.mjs';
import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';

function isNodeRuntimeEntrypoint(entrypoint) {
  return /\.(?:cjs|js|mjs)$/i.test(String(entrypoint ?? '').trim());
}

function runCliProfileReconciliation({ resolvedCli, env, cliHomeDir, internalServerUrl, publicServerUrl, serverId = String(env.HAPPIER_ACTIVE_SERVER_ID ?? '').trim() }) {
  const args = buildStackServerProfileSetArgs({ serverId, internalServerUrl, publicServerUrl });
  const profile = { homeDir: cliHomeDir, serverId, internalServerUrl, publicServerUrl };
  try {
    // Starting a full CLI just to rewrite an already matching profile delays
    // every stack command, including Stop. Reuse the canonical persisted check.
    assertStackServerProfileReconciled(profile);
    return;
  } catch (error) {
    if (error?.code !== 'ESTACKCLIPROFILERECONCILIATION') throw error;
  }
  const result =
    resolvedCli.kind === 'runtime'
      ? spawnSync(resolvedCli.command, [...resolvedCli.args, ...args], { windowsHide: true, stdio: 'ignore', env })
      : spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', ...resolvedCli.nodeArgs, ...args], {
          stdio: 'ignore',
          windowsHide: true,
          env,
        });
  if (result.error || result.status !== 0) {
    const detail = result.error instanceof Error ? result.error.message : `exit=${result.status ?? 'unknown'}`;
    throw new Error(`[happier] failed to refresh the stack-owned relay profile before launch (${detail}).`);
  }
  assertStackServerProfileReconciled(profile);
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
  const prefixServerSelection = readPrefixServerSelection(forwardedArgv);
  const activeRuntimeState = await readActiveStackRuntimeStateFile(runtimeStatePath, { stackName });
  const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({
    argv: wrapperArgv,
    env: process.env,
    activeRuntimeState,
  });

  const internalServerUrl = endpoint.internalServerUrl;
  let { publicServerUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort, stackName });

  const cliLaunchSpec = runtimeLaunchContext.cliLaunchSpec
    ?? (runtimeLaunchContext.snapshot ? await resolveCliRuntimeLaunchSpec({ snapshot: runtimeLaunchContext.snapshot }) : null);
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
    : await resolveCliEntrypoint({
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
  const { cliHomeDir, isStackScopedInvocation } = resolveStackHappierCliHome({ env, stackBaseDir: stackEnvPathInfo.baseDir });
  if (isStackScopedInvocation) {
    publicServerUrl = await resolveStackCanonicalServerUrl({
      env: process.env, serverPort, stackName, envPublicUrl: endpoint.publicServerUrl,
    });
  }
  if (isStackScopedInvocation) {
    env.HAPPIER_HOME_DIR = cliHomeDir;
  } else {
    env.HAPPIER_HOME_DIR = env.HAPPIER_HOME_DIR || cliHomeDir;
  }

  // Bootstrap reloads the stack's authored env and scrubs inherited defaults.
  // Restore the runtime's selected UI through the same projection as startup.
  if (isStackScopedInvocation && !prefixServerSelection.hasExplicitSelection && activeRuntimeState?.sourceUi === 'borrowed') {
    env = await projectBorrowedExpoWebappEnv({
      rootDir,
      consumerStackName: stackName,
      producerStackName: env.HAPPIER_STACK_EXPO_SOURCE_STACK,
      env,
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
  // Only set default env vars when no explicit server selection flags are present.
  // Stack-scoped invocations must overwrite stale globals loaded by the wrapper bootstrap;
  // otherwise commands can silently target another stack's daemon/server.
  if (!prefixServerSelection.hasExplicitSelection && !settingsDefaults) {
    if (isStackScopedInvocation) {
      env.HAPPIER_PUBLIC_SERVER_URL = publicServerUrl;
      env.HAPPIER_LOCAL_SERVER_URL = internalServerUrl;
      env.HAPPIER_SERVER_URL = internalServerUrl;
      env.HAPPIER_WEBAPP_URL = env.HAPPIER_WEBAPP_URL || publicServerUrl;
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

  env = applyCliRuntimeLaunchProvenanceEnv({ env, cliLaunchSpec, sourceCliEnv: resolvedCli.env });
  // Auth recovery supplies the evidence required to refresh a retained Home's
  // endpoints. Its current endpoint and stable scope are already selected by
  // the environment; keep the authenticated descriptor intact until then.
  if (isStackScopedInvocation && !prefixServerSelection.hasExplicitSelection && !prefixServerSelection.isAuthCommand) {
    runCliProfileReconciliation({ resolvedCli, env, cliHomeDir, internalServerUrl, publicServerUrl });
  }
  if (
    isStackScopedInvocation && prefixServerSelection.onlyServerId && !prefixServerSelection.isAuthCommand
    && stackOwnsServerProfile({ homeDir: cliHomeDir, serverId: prefixServerSelection.onlyServerId, publicServerUrl })
  ) {
    runCliProfileReconciliation({
      resolvedCli, env, cliHomeDir, internalServerUrl, publicServerUrl, serverId: prefixServerSelection.onlyServerId,
    });
  }
  if (isStackScopedInvocation && requiresStackDaemonPreflight(forwardedArgv)) {
    const cliIdentity = (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() || 'default';
    await ensureStackDaemonPreflight({
      rootDir,
      stackName,
      env,
      argv: wrapperArgv,
      childArgs: forwardedArgv,
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
