import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { killProcessTree, runCapture, spawnProc } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { killPortListeners, observeTcpPortAvailability } from './utils/net/ports.mjs';
import { fetchHappierHealth, getServerComponentName, isHappierServerRunning, waitForServerReady } from './utils/server/server.mjs';
import { resolveServerShutdownGraceMs } from './utils/server/shutdown_grace.mjs';
import { ensureDepsInstalled, pmExecBin, requireDir } from './utils/proc/pm.mjs';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { maybeResetTailscaleServe } from './tailscale.mjs';
import { checkDaemonStatePingAware, getDaemonEnv, isDaemonRunning, startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/server/validate.mjs';
import { resolveServerStartScript } from './utils/server/flavor_scripts.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from './utils/server/infra/happy_server_infra.mjs';
import { applyServerLightEnvDefaults } from './utils/server/apply_server_light_env_defaults.mjs';
import {
  getAccountCountForServerComponent,
  prepareDaemonAuthSeedIfNeeded,
  probeExistingAccountCountForServerComponent,
  resolveAutoCopyFromMainEnabled,
} from './utils/stack/startup.mjs';
import {
  captureStackRuntimeStopSnapshot,
  finalizeStackRuntimeStop,
  readStackRuntimeStateFile,
  recordStackRuntimeServerActivation,
  recordStackRuntimeServerPids,
  recordStackRuntimeStart,
} from './utils/stack/runtime_state.mjs';
import { startStackRuntimeDaemonPidReconciler } from './utils/stack/runtime_daemon_state.mjs';
import { startOwnerDaemonLifecycleReconciler } from './utils/dev/daemonLifecycleReconciler.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { getPublicServerUrlEnvOverride, resolveServerUrls } from './utils/server/urls.mjs';
import { preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { ensureDevExpoServer, resolveExpoTailscaleEnabled } from './utils/dev/expo_dev.mjs';
import { resolveStackOwnedServerListenPid } from './utils/dev/server.mjs';
import { maybeRunInteractiveStackAuthSetup } from './utils/auth/interactive_stack_auth.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import {
  daemonStartGate,
  formatDaemonAuthRequiredError,
  resolveDaemonStartAdmission,
  resolveStackDaemonStartRequested,
} from './utils/auth/daemon_gate.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { buildServerRuntimeEnv } from './utils/server/server_env.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';
import { cmd, sectionTitle } from './utils/ui/layout.mjs';
import { renderTerminalUsageInstructions } from './utils/stack/terminal_usage_instructions.mjs';
import { resolveStackActiveServerId } from './utils/auth/stable_scope_id.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { isSandboxed } from './utils/env/sandbox.mjs';
import { installExitCleanup } from './utils/proc/exit_cleanup.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { validateUiServingConfig } from './utils/server/ui_build_check.mjs';
import { observeRuntimePortOwnedByStackDevProxy, selectLocalServerPortCandidateForStack } from './utils/server/resolve_stack_server_port.mjs';
import {
  createListenerOwnershipCommandScope,
  resolveSpawnedProcessGroupListenPid,
} from './utils/server/listener_ownership.mjs';
import { findExistingStackCredentialPath } from './utils/auth/credentials_paths.mjs';
import { createServiceDaemonAutostarter } from './utils/service/daemon_autostart.mjs';
import { applyRuntimeServerLightSqliteEnv } from './utils/server/apply_runtime_server_light_sqlite_env.mjs';
import { spawnSourceServerScript } from './utils/server/source_server_workspace_deps.mjs';
import { applyEffectiveDbProviderEnv } from './utils/server/effective_db_provider.mjs';
import { resolveStackRuntimeLaunchContext } from './runtime/launch/resolveStackRuntimeLaunchContext.mjs';
import {
  resolveCliRuntimeLaunchProvenance,
  resolveCliRuntimeLaunchSpec,
} from './runtime/launch/resolveCliRuntimeLaunchSpec.mjs';
import { resolveServerRuntimeLaunchSpec } from './runtime/launch/resolveServerRuntimeLaunchSpec.mjs';
import { spawnRuntimeServerAfterMigration } from './runtime/launch/runServerRuntimeMigration.mjs';
import { spawnStackOwnerDeathWatchdog } from './utils/stack/owner_death_watchdog.mjs';
import { completeInterruptedStackStopBeforeStart } from './utils/stack/stop.mjs';
import { decideDevStartupTopology, observeDevServerStartupTopology } from './utils/dev/devStartupTopology.mjs';
import { isBorrowedExpoConsumer } from './runtime/shared/borrowed_expo.mjs';

/**
 * Run the local stack in "production-like" mode:
 * - server (happier-server-light by default)
 * - happier-cli daemon
 * - optionally serve prebuilt UI (via server or gateway)
 *
 * Optional: Expo dev-client Metro for mobile reviewers (`--mobile`).
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        flags: [
          '--server=happier-server|happier-server-light',
          '--server-flavor=light|full',
          '--no-ui',
          '--no-daemon',
          '--restart',
          '--no-browser',
          '--mobile',
          '--expo-tailscale',
          '--bind=loopback|lan',
          '--loopback',
          '--lan',
        ],
        json: true,
      },
      text: [
        '[start] usage:',
        '  hstack start [--server=happier-server|happier-server-light] [--server-flavor=light|full] [--restart] [--json]',
        '  hstack start --mobile        # also start Expo dev-client Metro for mobile',
        '  hstack start --expo-tailscale # forward Expo to Tailscale interface for remote access',
        '  hstack start --bind=loopback  # prefer localhost-only URLs (not reachable from phones)',
        '  note: --json prints the resolved config (dry-run) and exits.',
        '',
        'note:',
        '  If run from inside a repo checkout/worktree, that checkout is used for this run (without requiring `hstack wt use`).',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  // Optional bind-mode override (affects Expo host/origins; best-effort sets HOST too).
  const bindMode = resolveBindModeFromArgs({ flags, kv });
  if (bindMode) {
    applyBindModeToEnv(process.env, bindMode);
  }

  // Outside sandbox mode we allow a convenience: if you run `hstack start` from inside a repo checkout/worktree,
  // we use that checkout even if you never ran `hstack wt use`.
  //
  // In sandbox mode this would break isolation by pointing at your "real" checkout, so we disable it.
  if (!isSandboxed()) {
    const inferred = inferComponentFromCwd({
      rootDir,
      invokedCwd: getInvokedCwd(process.env),
      components: ['happier-ui', 'happier-cli', 'happier-server-light', 'happier-server'],
    });
    if (inferred) {
      // Stack env should win. Only infer from CWD when the repo dir isn't already configured.
      if (!(process.env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim()) {
        process.env.HAPPIER_STACK_REPO_DIR = inferred.repoDir;
      }
    }
  }

  let serverPort = 3005;
  let internalServerUrl = '';
  let publicServerUrl = '';
  let defaultPublicUrl = '';

  // Convenience alias: allow `--server-flavor=light|full` for parity with `stack pr` and `tools setup-pr`.
  // `--server=...` always wins when both are specified.
  const serverFlavorFromArg = (kv.get('--server-flavor') ?? '').trim().toLowerCase();
  if (!kv.get('--server') && serverFlavorFromArg) {
    if (serverFlavorFromArg === 'light') kv.set('--server', 'happier-server-light');
    else if (serverFlavorFromArg === 'full') kv.set('--server', 'happier-server');
    else throw new Error(`[start] invalid --server-flavor=${serverFlavorFromArg} (expected: light|full)`);
  }

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for run (pick one: happier-server-light or happier-server)`);
  }
  const autostart = getDefaultAutostartPaths();
  const cleanupEnv = { ...process.env };
  const cleanupStackCtx = resolveStackContext({ env: cleanupEnv, autostart });
  if (!json && cleanupStackCtx.stackMode && cleanupStackCtx.runtimeStatePath) {
    await completeInterruptedStackStopBeforeStart({
      rootDir,
      stackName: cleanupStackCtx.stackName,
      baseDir: autostart.baseDir,
      env: cleanupEnv,
      json,
    });
  }
  const runtimeLaunchContext = await resolveStackRuntimeLaunchContext({ argv, env: process.env });
  const runtimeSnapshot = runtimeLaunchContext.snapshot;
  const runtimeBackedStart = Boolean(runtimeSnapshot);
  const cliLaunchSpec = runtimeSnapshot ? resolveCliRuntimeLaunchSpec({ snapshot: runtimeSnapshot }) : null;
  const cliRuntimeProvenance = resolveCliRuntimeLaunchProvenance(cliLaunchSpec);
  const serverLaunchSpec = runtimeSnapshot
    ? resolveServerRuntimeLaunchSpec({ serverComponent: serverComponentName, snapshot: runtimeSnapshot })
    : null;
  const dbProvider = applyEffectiveDbProviderEnv({ serverComponentName, env: process.env });
  if (dbProvider === 'mysql' && !String(process.env.DATABASE_URL ?? '').trim()) {
    throw new Error('[local] mysql requires an explicit DATABASE_URL before startup');
  }

  const daemonRequested = resolveStackDaemonStartRequested({
    env: process.env,
    noDaemon: flags.has('--no-daemon'),
  });
  let startDaemon = daemonRequested;
  const serveUiWanted = !flags.has('--no-ui') && (process.env.HAPPIER_STACK_SERVE_UI ?? '1') !== '0';
  let serveUi = serveUiWanted;
  // Capability semantics: if UI serving is enabled, default to "required" (fail closed)
  // unless explicitly disabled.
  const uiRequiredRaw = (process.env.HAPPIER_STACK_UI_REQUIRED ?? '').toString().trim();
  const uiRequired = uiRequiredRaw ? uiRequiredRaw !== '0' : Boolean(serveUiWanted);
  const startMobile = flags.has('--mobile') || flags.has('--with-mobile');
  const borrowedExpoProducerStackName = String(process.env.HAPPIER_STACK_EXPO_SOURCE_STACK ?? '').trim();
  const borrowedExpo = isBorrowedExpoConsumer({
    consumerStackName: autostart.stackName,
    producerStackName: borrowedExpoProducerStackName,
  });
  const startOwnedExpo = Boolean(startMobile && !borrowedExpo);
  const expoTailscale = flags.has('--expo-tailscale') || resolveExpoTailscaleEnabled({ env: process.env });
  const noBrowser = flags.has('--no-browser') || (process.env.HAPPIER_STACK_NO_BROWSER ?? '').toString().trim() === '1';
  const uiPrefix = process.env.HAPPIER_STACK_UI_PREFIX?.trim() ? process.env.HAPPIER_STACK_UI_PREFIX.trim() : '/';
  const uiBuildDir = runtimeSnapshot
    ? join(runtimeSnapshot.launchPath ?? runtimeSnapshot.snapshotPath, 'ui')
    : process.env.HAPPIER_STACK_UI_BUILD_DIR?.trim()
      ? process.env.HAPPIER_STACK_UI_BUILD_DIR.trim()
      : join(autostart.baseDir, 'ui');

  const enableTailscaleServe = (process.env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') === '1';

  const sourceServerDir = getComponentDir(rootDir, serverComponentName);
  const serverDir = serverLaunchSpec?.serverDir ?? sourceServerDir;
  const cliDir = cliLaunchSpec?.cliDir ?? getComponentDir(rootDir, 'happier-cli');
  const uiDir = getComponentDir(rootDir, 'happier-ui');

  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const cliNodeEntrypoint = cliLaunchSpec?.nodeEntrypoint ?? '';
  const cliCommand = cliLaunchSpec?.command ?? '';
  const cliCommandArgs = cliLaunchSpec?.args ?? [];

  const cliHomeDir = process.env.HAPPIER_STACK_CLI_HOME_DIR?.trim()
    ? expandHome(process.env.HAPPIER_STACK_CLI_HOME_DIR.trim())
    : join(autostart.baseDir, 'cli');
  const restart = flags.has('--restart');

  if (json) {
    printResult({
      json,
      data: {
        mode: 'start',
        serverComponentName,
        dbProvider,
        serverDir,
        uiDir,
        cliDir,
        serverPort,
        internalServerUrl,
        publicServerUrl,
        startDaemon,
        serveUi,
        uiRequired,
        startMobile,
        startOwnedExpo,
        expoOwnership: borrowedExpo ? 'borrowed' : 'owned',
        uiPrefix,
        uiBuildDir,
        cliHomeDir,
        launchMode: runtimeSnapshot ? 'runtime' : 'source',
        runtimeSnapshotId: runtimeSnapshot?.snapshotId ?? null,
      },
    });
    return;
  }

  const serverStartScript = runtimeSnapshot ? null : resolveServerStartScript({ serverComponentName, serverDir });

  if (!runtimeSnapshot) {
    assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });
    assertServerPrismaProviderMatches({ serverComponentName, serverDir });
  }

  if (!runtimeSnapshot) {
    await requireDir(serverComponentName, serverDir);
    if (startDaemon) {
      await requireDir('happier-cli', cliDir);
    }
  }
  if (startOwnedExpo) {
    await requireDir('happier-ui', uiDir);
  }

  const uiBuildDirExists = await pathExists(uiBuildDir);
  const uiIndexExists = serveUi && uiBuildDirExists ? await pathExists(join(uiBuildDir, 'index.html')) : false;
  {
    const validated = validateUiServingConfig({
      serverComponentName,
      serveUiWanted: serveUi,
      uiRequired,
      uiBuildDir,
      uiBuildDirExists,
      uiIndexExists,
    });
    serveUi = validated.serveUi;
    if (!serveUi && validated.warning) {
      // For happier-server, UI serving is optional; warn and continue.
      if (serverComponentName !== 'happier-server-light') {
        console.log(`${yellow('!')} ${validated.warning}`);
      }
    }
  }

	  const children = [];
	  let shuttingDown = false;
    let shutdown = null;
    let pendingShutdownSignal = null;
    let shutdownDispatchStarted = false;
    const dispatchShutdown = (signal) => {
      if (shutdownDispatchStarted) return;
      if (!shutdown) {
        pendingShutdownSignal = signal;
        for (const child of children.filter((candidate) => candidate?.exitCode == null)) {
          void killProcessTree(child, 'SIGINT').catch(() => {});
        }
        return;
      }
      shutdownDispatchStarted = true;
      shutdown({ signal }).then(() => process.exit(0)).catch((error) => {
        console.error('[local] shutdown failed:', error);
        process.exit(1);
      });
    };
    process.on('SIGINT', () => dispatchShutdown('SIGINT'));
    process.on('SIGTERM', () => dispatchShutdown('SIGTERM'));
	  let ownedDaemonPid = null;
	  let daemonAutostarter = null;
	  let daemonRuntimeReconciler = null;
	  let daemonLifecycleReconciler = null;
	  installExitCleanup({ label: 'local', children });
	  const baseEnv = { ...process.env };
	  const stackCtx = resolveStackContext({ env: baseEnv, autostart });
	  const { stackMode, runtimeStatePath, stackName, envPath, ephemeral } = stackCtx;
	  const daemonScopeEnv = applyStackActiveServerScopeEnv({ env: baseEnv, stackName, cliIdentity: 'default' });
	  const serviceMode = (daemonScopeEnv.HAPPIER_STACK_SERVICE_MODE ?? '').toString().trim() === '1';
  const terminalIsInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  serverPort = await selectLocalServerPortCandidateForStack({
    env: baseEnv,
    stackMode,
    stackName,
    runtimeStatePath,
    defaultPort: 3005,
  });

  // Internal URL used by local processes on this machine.
  internalServerUrl = `http://127.0.0.1:${serverPort}`;
  // Public URL is what you might share/open (e.g. https://<machine>.<tailnet>.ts.net).
  // We auto-prefer the Tailscale HTTPS URL when available, unless explicitly overridden.
  const { publicServerUrl: publicServerUrlPreview } = getPublicServerUrlEnvOverride({ serverPort, env: baseEnv, stackName });
  publicServerUrl = publicServerUrlPreview;

  const daemonStartAdmission = resolveDaemonStartAdmission({
    daemonRequested,
    runtimeBackedStart,
    terminalIsInteractive,
    env: daemonScopeEnv,
    cliHomeDir,
    serverUrl: internalServerUrl,
  });
  startDaemon = daemonStartAdmission.startDaemon;

  const runtimeOwnershipObservationScope = createListenerOwnershipCommandScope();
  const serverHealthObservation = await fetchHappierHealth(internalServerUrl);
  const serverAlreadyRunning = serverHealthObservation.ok;
  const daemonAlreadyRunning = startDaemon
    ? ['running', 'starting'].includes((await checkDaemonStatePingAware(
        cliHomeDir,
        { serverUrl: internalServerUrl, env: daemonScopeEnv },
      )).status)
    : false;
  const serverTopologyObservation = await observeDevServerStartupTopology({
    serverRequested: true, stackMode, serverPort, serverHealthObservation,
    ownershipArgs: { env: baseEnv, port: serverPort, stackName, runtimeStatePath, listenerObservationScope: runtimeOwnershipObservationScope },
  }, {
    observeTcpPortAvailabilityImpl: observeTcpPortAvailability,
    observeRuntimePortOwnedByStackDevProxyImpl: observeRuntimePortOwnedByStackDevProxy,
    resolveStackOwnedServerListenPidImpl: () => resolveStackOwnedServerListenPid(
      { serverPort, stackName, envPath }, { observationScope: runtimeOwnershipObservationScope },
    ),
  });
  const serverTopology = serverTopologyObservation.topology;
  const existingServerOwnership = serverTopologyObservation.proxyOwned
    ? { status: 'proxy-owned', pid: null }
    : serverTopologyObservation.listenerPid
      ? { status: 'known', pid: serverTopologyObservation.listenerPid }
      : { status: serverTopology === 'foreign' ? 'foreign' : 'not-running', pid: null };
  const startupDecision = decideDevStartupTopology({
    serverRequested: true,
    serverTopology,
    daemonRequested: startDaemon,
    daemonRunning: daemonAlreadyRunning,
    expoRequested: startOwnedExpo,
    expoRunning: false,
    restart,
  });

  if (daemonStartAdmission.skipReason) {
    console.log('[local] daemon: not started (credentials unavailable for this runtime snapshot)');
  }

  if (startupDecision.startDaemon && !serviceMode && !terminalIsInteractive) {
    const initialGate = daemonStartGate({ env: daemonScopeEnv, cliHomeDir, serverUrl: internalServerUrl });
    if (!initialGate.ok) {
      throw new Error(
        formatDaemonAuthRequiredError({
          stackName: autostart.stackName,
          cliHomeDir,
          serverUrl: internalServerUrl,
        })
      );
    }
  }

  // Ensure server deps exist before any Prisma/docker work.
  if (!runtimeSnapshot && startupDecision.startServer) {
    await ensureDepsInstalled(serverDir, serverComponentName);
  }
  if (startupDecision.startExpo) {
    await ensureDepsInstalled(uiDir, 'happier-ui');
  }

  // Public URL automation:
  // - Only the main stack should ever auto-enable Tailscale Serve by default.
  // - Local stack URLs retain their stack-scoped hostname so the server's signed auth audience
  //   matches the same origin that stack info and browser launch advertise to the UI.
  const allowEnableTailscale =
    !stackMode ||
    stackName === 'main' ||
    (baseEnv.HAPPIER_STACK_TAILSCALE_SERVE ?? '0').toString().trim() === '1';
  const resolvedUrls = await resolveServerUrls({ env: baseEnv, serverPort, allowEnable: allowEnableTailscale });
  defaultPublicUrl = resolvedUrls.defaultPublicUrl;
  publicServerUrl = resolvedUrls.publicServerUrl;

  const publishExistingServerOwnership = async () => {
    if (!(startupDecision.adoptedServer && stackMode && runtimeStatePath)) return;
    if (existingServerOwnership.status === 'proxy-owned') return;
    if (existingServerOwnership.status === 'known') {
      await recordStackRuntimeServerPids(runtimeStatePath, {
        listenerPid: existingServerOwnership.pid,
        wrapperPid: null,
        serverPort,
        clearProxyState: false,
      });
      return;
    }
  };
  if (startupDecision.adoptedServer) {
    await publishExistingServerOwnership();
  }
  if (!startupDecision.startServer && !startupDecision.startDaemon && !startupDecision.startExpo) {
    console.log(
      `${green('✓')} start: already running ${dim('(')}` +
        `${dim('server=')}${cyan(internalServerUrl)}` +
        `${startDaemon ? ` ${dim('daemon=')}${daemonAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${dim(')')}`
    );
    return;
  }

  // Stack runtime state (stack-scoped commands only): record the runner PID + chosen ports so stop/restart never kills other stacks.
  if (stackMode && runtimeStatePath) {
    const startedRuntime = await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      script: 'run.mjs',
      ephemeral,
      ownerPid: process.pid,
      ports: { server: serverPort },
      runtimeSnapshotId: runtimeSnapshot?.snapshotId ?? null,
      serveUi,
    });
    spawnStackOwnerDeathWatchdog({
      rootDir,
      stackName,
      baseDir: autostart.baseDir,
      envPath,
      runtimeStatePath,
      ownerPid: process.pid,
      ownerStartedAt: startedRuntime.startedAt,
      env: baseEnv,
    });
  }

  // Server
  // If a previous run left a server behind, free the port first (prevents false "ready" checks).
  // NOTE: In stack mode we avoid killing arbitrary port listeners (fail-closed instead).
  if (startupDecision.startServer && !stackMode) {
    await killPortListeners(serverPort, { label: 'server' });
  }

  const serverEnv = buildServerRuntimeEnv({
    baseEnv,
    serverPort,
    publicServerUrl,
    serveUi,
    uiRequired,
    uiBuildDir,
    uiPrefix,
    uiBuildDirExists: Boolean(serveUi && uiBuildDirExists && uiIndexExists),
  });
  let serverLightAccountCount = null;
  let happierServerAccountCount = null;
  if (serverComponentName === 'happier-server-light') {
    applyServerLightEnvDefaults({ baseEnv, serverEnv, baseDir: autostart.baseDir });
    if (runtimeBackedStart) {
      applyRuntimeServerLightSqliteEnv({ env: serverEnv, serverDir });
    }

    if (!runtimeBackedStart && !startupDecision.adoptedServer) {
      // Source-backed starts ensure the light DB schema exists before daemon startup.
      const acct = await getAccountCountForServerComponent({
        serverComponentName,
        serverDir: sourceServerDir,
        env: serverEnv,
        bestEffort: Boolean(serverAlreadyRunning && !restart),
      });
      serverLightAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
    } else {
      const acct = await probeExistingAccountCountForServerComponent({
        serverComponentName,
        serverDir,
        env: serverEnv,
      });
      serverLightAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
    }
  }
  let effectiveInternalServerUrl = internalServerUrl;
  let activeServerProcess = null;
  if (serverComponentName === 'happier-server') {
    const managed = (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0';
    if (managed) {
      if (startupDecision.startServer) {
        const explicitDatabaseUrl = serverEnv.DATABASE_URL;
        const infra = await ensureHappyServerManagedInfra({
          stackName: autostart.stackName,
          baseDir: autostart.baseDir,
          serverPort,
          publicServerUrl,
          envPath,
          env: serverEnv,
          dbProvider,
        });
        if (dbProvider === 'mysql') infra.env.DATABASE_URL = explicitDatabaseUrl;

        // Backend runs on a separate port; gateway owns the public port.
        const backendPortRaw = (baseEnv.HAPPIER_STACK_SERVER_BACKEND_PORT ?? '').trim();
        const backendPort = backendPortRaw ? Number(backendPortRaw) : serverPort + 10;
        const backendUrl = `http://127.0.0.1:${backendPort}`;
        if (!stackMode) {
          await killPortListeners(backendPort, { label: 'happier-server-backend' });
        }

        const backendEnv = { ...serverEnv, ...infra.env, PORT: String(backendPort) };
        if (!runtimeBackedStart) {
          const autoMigrate = (baseEnv.HAPPIER_STACK_PRISMA_MIGRATE ?? '1') !== '0';
          if (autoMigrate) {
            await applyHappyServerMigrations({ serverDir: sourceServerDir, env: backendEnv, dbProvider });
          }
          // Account probe should use the *actual* DATABASE_URL/infra env (ephemeral stacks do not persist it in env files).
          const accountProbeImpl = startupDecision.adoptedServer
            ? probeExistingAccountCountForServerComponent
            : getAccountCountForServerComponent;
          const acct = await accountProbeImpl({
            serverComponentName,
            serverDir: sourceServerDir,
            env: backendEnv,
            bestEffort: true,
          });
          happierServerAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
        }
        const backend = runtimeSnapshot
          ? await spawnRuntimeServerAfterMigration({
              serverLaunchSpec,
              env: backendEnv,
              children,
              isCancellationRequested: () => pendingShutdownSignal !== null,
            })
          : await spawnSourceServerScript({ label: 'server', serverDir, script: 'start', env: backendEnv });
        if (!runtimeSnapshot) children.push(backend);
        activeServerProcess = backend;
        await waitForServerReady(backendUrl, { childProcess: backend });
        if (stackMode && runtimeStatePath) {
          await recordStackRuntimeServerActivation(runtimeStatePath, {
            stablePort: serverPort,
            backendPort,
            managedBackendPid: backend.pid,
            mode: 'managed-backend',
          });
        }

        const gatewayArgs = [
          join(rootDir, 'scripts', 'ui_gateway.mjs'),
          `--port=${serverPort}`,
          `--backend-url=${backendUrl}`,
          `--minio-port=${infra.env.S3_PORT}`,
          `--bucket=${infra.env.S3_BUCKET}`,
        ];
        if (serveUi && (await pathExists(uiBuildDir))) {
          gatewayArgs.push(`--ui-dir=${uiBuildDir}`);
        } else {
          gatewayArgs.push('--no-ui');
        }

        const gateway = spawnProc('ui', process.execPath, gatewayArgs, { ...backendEnv, PORT: String(serverPort) }, { cwd: rootDir });
        children.push(gateway);
        await waitForServerReady(internalServerUrl, { childProcess: gateway });
        if (stackMode && runtimeStatePath) {
          await recordStackRuntimeServerActivation(runtimeStatePath, {
            stablePort: serverPort,
            backendPort,
            managedBackendPid: backend.pid,
            managedGatewayPid: gateway.pid,
            mode: 'managed-gateway',
          });
        }
        effectiveInternalServerUrl = internalServerUrl;

        // Skip default server spawn below
      } else {
        console.log(`${green('✓')} server: already running at ${cyan(internalServerUrl)}`);
      }
    }
  }

  // Default server start (happier-server-light, or happier-server without managed infra).
  if (!(serverComponentName === 'happier-server' && (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0')) {
    if (startupDecision.startServer) {
      const server = runtimeSnapshot && serverComponentName === 'happier-server'
        ? await spawnRuntimeServerAfterMigration({
            serverLaunchSpec,
            env: serverEnv,
            children,
            isCancellationRequested: () => pendingShutdownSignal !== null,
          })
        : runtimeSnapshot
          ? spawnProc('server', serverLaunchSpec.command, serverLaunchSpec.args, serverEnv, { cwd: serverDir })
          : await spawnSourceServerScript({ label: 'server', serverDir, script: serverStartScript, env: serverEnv });
      if (!(runtimeSnapshot && serverComponentName === 'happier-server')) children.push(server);
      activeServerProcess = server;
      await waitForServerReady(internalServerUrl, { childProcess: server });
      if (stackMode && runtimeStatePath) {
        const listenerPid = await resolveSpawnedProcessGroupListenPid({
          port: serverPort,
          spawnedPid: server.pid,
        });
        const provenListenerPid = Number.isFinite(Number(listenerPid)) && Number(listenerPid) > 1
          ? Number(listenerPid)
          : null;
        if (provenListenerPid === null) {
          console.warn(
            `[local] server listener ownership on port ${serverPort} could not be proven ` +
              `(listener discovery inconclusive); keeping the ready server (pid=${server.pid}) ` +
              'and recording no listener PID.'
          );
        }
        await recordStackRuntimeServerActivation(runtimeStatePath, {
          listenerPid: provenListenerPid,
          wrapperPid: server.pid,
          stablePort: serverPort,
          mode: 'direct',
          clearProxyState: true,
        });
      }
    } else {
      console.log(`${green('✓')} server: already running at ${cyan(internalServerUrl)}`);
    }
  }

  if (enableTailscaleServe) {
    try {
      const status = await runCapture(process.execPath, [join(rootDir, 'scripts', 'tailscale.mjs'), 'status']);
      const line = status.split('\n').find((l) => l.toLowerCase().includes('https://'))?.trim();
      if (line) {
        console.log(`${green('✓')} tailscale serve: ${cyan(line)}`);
      } else {
        console.log(`${green('✓')} tailscale serve enabled`);
      }
    } catch {
      console.log(`${green('✓')} tailscale serve enabled`);
    }
  }

  if (serveUi) {
    const localUi = effectiveInternalServerUrl.replace(/\/+$/, '') + '/';
    console.log('');
    console.log(sectionTitle('Web UI'));
    console.log(`${green('✓')} local:  ${cyan(localUi)}`);
    if (publicServerUrl && publicServerUrl !== effectiveInternalServerUrl && publicServerUrl !== localUi && publicServerUrl !== defaultPublicUrl) {
      const pubUi = publicServerUrl.replace(/\/+$/, '') + '/';
      console.log(`${green('✓')} public: ${cyan(pubUi)}`);
    }
    if (enableTailscaleServe) {
      console.log(`${dim('Tip:')} use the HTTPS *.ts.net URL for remote access`);
    }

    console.log('');
    console.log(renderTerminalUsageInstructions({
      internalServerUrl: effectiveInternalServerUrl,
      cliHomeDir,
      publicServerUrl,
      activeServerId: resolveStackActiveServerId({ env: baseEnv, stackName: autostart.stackName }),
      stackName: autostart.stackName,
    }).join('\n'));

    // Auto-open UI (interactive only) using the stack-scoped hostname when applicable.
    if (terminalIsInteractive && !noBrowser) {
      const prefix = uiPrefix.startsWith('/') ? uiPrefix : `/${uiPrefix}`;
      const openUrl = await preferStackLocalhostUrl(`http://localhost:${serverPort}${prefix}`, { stackName: autostart.stackName });
      const res = await openUrlInBrowser(openUrl);
      if (!res.ok) {
        console.warn(`[local] ui: failed to open browser automatically (${res.error}).`);
      }
    }
  }

  // Daemon
  const startDaemonAndRecord = async ({
    forceRestart = restart && !serviceMode,
    preserveExistingRunning = false,
  } = {}) => {
    await startLocalDaemonWithAuth({
      cliBin,
      cliEntrypoint: cliLaunchSpec?.entrypoint ?? '',
      cliNodeEntrypoint,
      cliCommand,
      cliCommandArgs,
      cliHomeDir,
      internalServerUrl: effectiveInternalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => shuttingDown,
      forceRestart,
      preserveExistingRunning,
      env: daemonScopeEnv,
              stackName,
              cliIdentity: 'default',
              ...cliRuntimeProvenance,
    });
    const daemonEnvForState = getDaemonEnv({
      baseEnv: daemonScopeEnv,
      cliHomeDir,
      internalServerUrl: effectiveInternalServerUrl,
      publicServerUrl: publicServerUrl || effectiveInternalServerUrl,
      stackName,
      cliIdentity: 'default',
    });
    const daemonState = await checkDaemonStatePingAware(cliHomeDir, {
      serverUrl: effectiveInternalServerUrl,
      env: daemonEnvForState,
    });
    ownedDaemonPid = typeof daemonState?.pid === 'number' ? daemonState.pid : null;
  };

  if (startupDecision.startDaemon) {
    const initialGate = daemonStartGate({ env: daemonScopeEnv, cliHomeDir, serverUrl: effectiveInternalServerUrl });

    if (initialGate.reason !== 'auth_flow_missing_credentials') {
      if (!runtimeBackedStart && serverComponentName === 'happier-server' && happierServerAccountCount == null) {
        const accountProbeImpl = startupDecision.adoptedServer
          ? probeExistingAccountCountForServerComponent
          : getAccountCountForServerComponent;
        const acct = await accountProbeImpl({
          serverComponentName,
          serverDir: sourceServerDir,
          env: serverEnv,
          bestEffort: true,
        });
        happierServerAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
      }
      const accountCount =
        serverComponentName === 'happier-server-light' ? serverLightAccountCount : happierServerAccountCount;
      const autoSeedEnabled = resolveAutoCopyFromMainEnabled({ env: daemonScopeEnv, stackName, isInteractive: terminalIsInteractive });
      await maybeRunInteractiveStackAuthSetup({
        rootDir,
        env: daemonScopeEnv,
        stackName,
        cliHomeDir,
        accountCount,
        isInteractive: terminalIsInteractive,
        autoSeedEnabled,
      });
      await prepareDaemonAuthSeedIfNeeded({
      rootDir,
      env: daemonScopeEnv,
      stackName,
      cliHomeDir,
        startDaemon,
        isInteractive: terminalIsInteractive,
        accountCount,
        quiet: false,
      });
    }

    const gate = daemonStartGate({ env: daemonScopeEnv, cliHomeDir, serverUrl: effectiveInternalServerUrl });
    if (!gate.ok) {
      // In orchestrated auth flows, keep server/UI up and let the orchestrator start daemon post-auth.
      if (gate.reason === 'auth_flow_missing_credentials') {
        console.log('[local] auth flow: skipping daemon start until credentials exist');
        if (serviceMode) {
          const pollMs = daemonScopeEnv.HAPPIER_STACK_SERVICE_DAEMON_AUTOSTART_POLL_MS ?? '';
          const maxAttemptsPerCredentials =
            daemonScopeEnv.HAPPIER_STACK_SERVICE_DAEMON_AUTOSTART_MAX_ATTEMPTS_PER_CREDENTIALS ?? '';
          const retryBaseMs = daemonScopeEnv.HAPPIER_STACK_SERVICE_DAEMON_AUTOSTART_RETRY_BASE_MS ?? '';
          const retryMaxMs = daemonScopeEnv.HAPPIER_STACK_SERVICE_DAEMON_AUTOSTART_RETRY_MAX_MS ?? '';

          const getCredentialFingerprint = async () => {
            const path = findExistingStackCredentialPath({
              cliHomeDir,
              serverUrl: effectiveInternalServerUrl,
              env: daemonScopeEnv,
            });
            if (!path) return null;
            try {
              const st = statSync(path);
              const mtime = Number(st?.mtimeMs) || 0;
              const size = Number(st?.size) || 0;
              return `${path}:${mtime}:${size}`;
            } catch {
              return String(path);
            }
          };

          daemonAutostarter = createServiceDaemonAutostarter({
            enabled: true,
            isShuttingDown: () => shuttingDown,
            isServerReady: async () => await isHappierServerRunning(effectiveInternalServerUrl),
            pollMs,
            maxAttemptsPerCredentials,
            retryBaseMs,
            retryMaxMs,
            getCredentialFingerprint,
            isDaemonRunning: () => isDaemonRunning(cliHomeDir, { serverUrl: effectiveInternalServerUrl, env: daemonScopeEnv }),
            startDaemon: startDaemonAndRecord,
            logger: console,
          });
          daemonAutostarter.start();
        }
      } else if (!terminalIsInteractive) {
        throw new Error(
          formatDaemonAuthRequiredError({
            stackName: autostart.stackName,
            cliHomeDir,
            serverUrl: effectiveInternalServerUrl,
          })
        );
      }
    } else {
      await startDaemonAndRecord();
	    }
	  }

  if (startDaemon && stackMode && runtimeStatePath) {
    const daemonRuntimeEnv = getDaemonEnv({
      baseEnv: daemonScopeEnv,
      cliHomeDir,
      internalServerUrl: effectiveInternalServerUrl,
      publicServerUrl: publicServerUrl || effectiveInternalServerUrl,
      stackName,
      cliIdentity: 'default',
    });
    daemonRuntimeReconciler = startStackRuntimeDaemonPidReconciler(
      {
        runtimeStatePath,
        cliHomeDir,
        internalServerUrl: effectiveInternalServerUrl,
        env: daemonRuntimeEnv,
        isShuttingDown: () => shuttingDown,
      },
      { checkDaemonStateImpl: checkDaemonStatePingAware },
    );
    await daemonRuntimeReconciler?.syncNow?.();

    if (!serviceMode) {
      daemonLifecycleReconciler = startOwnerDaemonLifecycleReconciler({
        enabled: true,
        isShuttingDown: () => shuttingDown,
        observe: async () => {
          const gate = daemonStartGate({
            env: daemonScopeEnv,
            cliHomeDir,
            serverUrl: effectiveInternalServerUrl,
          });
          if (!gate.ok) return { status: 'inconclusive', reason: gate.reason };
          return await checkDaemonStatePingAware(cliHomeDir, {
            serverUrl: effectiveInternalServerUrl,
            env: daemonRuntimeEnv,
	        stackName,
	        runtimeBacked: cliLaunchSpec?.runtimeBacked === true,
	        admittedDistClosureFingerprint: cliLaunchSpec?.daemonDistClosureFingerprint ?? null,
	    });
        },
        recover: async () => {
          await startDaemonAndRecord({
            forceRestart: false,
            preserveExistingRunning: true,
          });
          return { started: true };
        },
      });
    }
  }

  // Optional: start Expo dev-client Metro for mobile reviewers.
  if (startupDecision.startExpo) {
    const expoRes = await ensureDevExpoServer({
      startUi: false,
      startMobile: true,
      uiDir,
      autostart,
      baseEnv,
      apiServerUrl: publicServerUrl,
      restart,
      stackMode,
      runtimeStatePath,
      stackName,
      envPath,
      children,
      expoTailscale,
    });
    if (expoRes?.tailscale?.ok && expoRes.tailscale.tailscaleIp && expoRes.port) {
      console.log(`[local] expo tailscale: http://${expoRes.tailscale.tailscaleIp}:${expoRes.port}`);
    }
  }

  shutdown = async ({ signal = 'SIGTERM' } = {}) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    let shutdownRequest = null;
    let expectedStopState = null;
    if (runtimeStatePath) {
      shutdownRequest = (await readStackRuntimeStateFile(runtimeStatePath).catch(() => null))?.stopRequest ?? null;
      expectedStopState = await captureStackRuntimeStopSnapshot(runtimeStatePath).catch(() => null);
    }
    console.log(`\n[local] shutting down (${signal})...`);
    if (shutdownRequest) {
      const requestedBy = String(shutdownRequest.requestedBy ?? '').trim();
      const reason = String(shutdownRequest.reason ?? '').trim();
      const preserveDaemon = shutdownRequest.preserveDaemon === true;
      const requestedAt = String(shutdownRequest.requestedAt ?? '').trim();
      console.log(
        `[local] shutdown request: ` +
          [
            requestedBy ? `requestedBy=${requestedBy}` : null,
            reason ? `reason=${reason}` : null,
            preserveDaemon ? 'preserveDaemon=true' : null,
            requestedAt ? `requestedAt=${requestedAt}` : null,
          ]
            .filter(Boolean)
            .join(' ')
      );
    }

    try {
      daemonAutostarter?.stop?.();
    } catch {
      // ignore
    }
    try {
      daemonRuntimeReconciler?.close?.();
    } catch {
      // ignore
    }
    try {
      daemonLifecycleReconciler?.close?.();
    } catch {
      // ignore
    }

    const preserveDaemonOnShutdown = shutdownRequest?.preserveDaemon === true;

	    if (startDaemon && !preserveDaemonOnShutdown) {
	      if (ownedDaemonPid && Number.isFinite(ownedDaemonPid) && ownedDaemonPid > 0) {
		        await stopLocalDaemon({
		          cliBin,
              cliNodeEntrypoint,
              cliCommand,
              cliCommandArgs,
		          internalServerUrl: effectiveInternalServerUrl,
		          cliHomeDir,
		          runtimeStatePath,
		          expectedPid: ownedDaemonPid,
		          env: daemonScopeEnv,
		          stackName,
	          cliIdentity: 'default',
	        });
	      } else {
		        await stopLocalDaemon({
		          cliBin,
              cliNodeEntrypoint,
              cliCommand,
              cliCommandArgs,
		          internalServerUrl: effectiveInternalServerUrl,
		          cliHomeDir,
		          runtimeStatePath,
		          env: daemonScopeEnv,
		          stackName,
		          cliIdentity: 'default',
	        });
	      }
	    }

    const serverShutdownGraceMs = resolveServerShutdownGraceMs(baseEnv);
    const cleanupResults = [];
    for (const child of children) {
      if (child.exitCode == null) {
        cleanupResults.push(await killProcessTree(child, 'SIGINT',
          child === activeServerProcess ? { graceMs: serverShutdownGraceMs } : undefined));
      }
    }

    await delay(1500);
    for (const child of children) {
      if (child.exitCode == null) {
        cleanupResults.push(await killProcessTree(child, 'SIGKILL'));
      }
    }

    await maybeResetTailscaleServe();
    if (runtimeStatePath && expectedStopState) {
      await finalizeStackRuntimeStop(runtimeStatePath, {
        expected: expectedStopState,
        preserveDaemon: preserveDaemonOnShutdown,
        cleanupResults,
        requireNoStopRequest: true,
      }).catch(() => {});
    }
  };

  if (pendingShutdownSignal) dispatchShutdown(pendingShutdownSignal);

  // Keep running
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[local] failed:', err);
  process.exit(1);
});
