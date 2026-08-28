import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { killProcessTree } from './utils/proc/proc.mjs';
import { spawnProc } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { killPortListeners, observeTcpPortAvailability } from './utils/net/ports.mjs';
import { fetchHappierHealth, getServerComponentName } from './utils/server/server.mjs';
import { resolveServerShutdownGraceMs } from './utils/server/shutdown_grace.mjs';
import { requireDir } from './utils/proc/pm.mjs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkDaemonStatePingAware, getDaemonEnv, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/server/validate.mjs';
import { getExpoStatePaths, isStateProcessRunning } from './utils/expo/expo.mjs';
import { selectExpoDevMetroPort } from './utils/expo/metro_ports.mjs';
import {
  captureStackRuntimeStopSnapshot,
  createStackServerRuntimeProcessPatch,
  finalizeStackRuntimeStop,
  readStackRuntimeStateFile,
  recordStackRuntimeServerPids,
  recordStackRuntimeStart,
  recordStackRuntimeUpdate,
} from './utils/stack/runtime_state.mjs';
import { startStackRuntimeDaemonPidReconciler } from './utils/stack/runtime_daemon_state.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import {
  prepareDaemonAuthSeed,
  startDevDaemon,
} from './utils/dev/daemon.mjs';
import { startDevDaemonLifecycleReconciler } from './utils/dev/daemonLifecycleReconciler.mjs';
import {
  resolveStackOwnedServerListenPid,
  resolveStackOwnedServerRuntimePid,
  startDevServer,
} from './utils/dev/server.mjs';
import {
  decideDevStartupTopology,
  observeDevServerStartupTopology,
  shouldExitAdoptedDevRuntime,
} from './utils/dev/devStartupTopology.mjs';
import { resolveDevReloadPollIntervalMs } from './utils/dev/devReloadCoordinator.mjs';
import { startDevReloadComposition } from './utils/dev/devReloadComposition.mjs';
import { prepareDevProxyStartup, resolveDevProxyStableHost, shouldEnableStackDevProxy } from './utils/dev/devProxy.mjs';
import { createDevProxyUnexpectedExitHandler } from './utils/dev/devProxyLifecycle.mjs';
import { resolveDevServerConnection } from './utils/dev/resolveDevServerConnection.mjs';
import { observeRuntimePortOwnedByStackDevProxy, selectLocalServerPortCandidateForStack } from './utils/server/resolve_stack_server_port.mjs';
import { createListenerOwnershipCommandScope } from './utils/server/listener_ownership.mjs';
import {
  ensureDevExpoServer,
  resolveExpoDevHost,
  resolveExpoTailscaleEnabled,
} from './utils/dev/expo_dev.mjs';
import { preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { waitForHttpOk } from './utils/server/server.mjs';
import { sanitizeDnsLabel } from './utils/net/dns.mjs';
import { getAccountCountForServerComponent, probeExistingAccountCountForServerComponent, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { maybeRunInteractiveStackAuthSetup } from './utils/auth/interactive_stack_auth.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { daemonStartGate, formatDaemonAuthRequiredError } from './utils/auth/daemon_gate.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';
import { cmd, sectionTitle } from './utils/ui/layout.mjs';
import { renderTerminalUsageInstructions } from './utils/stack/terminal_usage_instructions.mjs';
import { resolveStackActiveServerId } from './utils/auth/stable_scope_id.mjs';
import { cyan, dim, green } from './utils/ui/ansi.mjs';
import { isSandboxed } from './utils/env/sandbox.mjs';
import { installExitCleanup } from './utils/proc/exit_cleanup.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { buildConfigureServerLinks } from '@happier-dev/cli-common/links';
import { spawnStackOwnerDeathWatchdog } from './utils/stack/owner_death_watchdog.mjs';
import { completeInterruptedStackStopBeforeStart } from './utils/stack/stop.mjs';
import { resolveTauriPaneInvocation } from './utils/tui/tauri_mode.mjs';
import { resolveReactNativeDevtoolsUrl } from './utils/dev/react_native_devtools.mjs';
import {
  loadDevTargetsConfig,
  resolveDevTargetExecutionPolicy,
} from './utils/dev_targets/config.mjs';
import { runDevTargetsDoctor } from './utils/dev_targets/doctor.mjs';
import {
  resolveDevTargetServicePlans,
  resolveServicePlansAfterTargetPreflight,
} from './utils/dev_targets/service_placement.mjs';
import { resolveRemoteServerRuntimeConfig } from './utils/dev_targets/remote_commands.mjs';
import {
  startStackDevTargets,
  startStackDevTargetsInBackground,
} from './utils/dev_targets/supervisor.mjs';
import { findExistingStackCredentialPath } from './utils/auth/credentials_paths.mjs';
import {
  hasExplicitMobileReachableHost,
  resolveMobileReachableServerUrl,
} from './utils/server/mobile_api_url.mjs';

 /**
  * Dev mode stack:
 * - happier-server-light
 * - happier-cli daemon
 * - Expo web dev server (watch/reload)
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (flags.has('--runtime') || flags.has('--source')) {
    throw new Error('[dev] hstack dev does not support runtime mode flags. Use hstack start for runtime snapshots.');
  }
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
	      data: {
		        flags: [
		          '--server=happier-server|happier-server-light',
		          '--server-flavor=light|full',
              '--server-url=http(s)://host[:port]',
              '--no-server',
		          '--no-ui',
		          '--no-daemon',
          '--no-dev-targets',
          '--restart',
          '--watch',
          '--no-watch',
          '--no-browser',
          '--no-proxy',
          '--mobile',
          '--rn-devtools',
          '--react-native-devtools',
          '--tauri',
          '--expo-tailscale',
          '--bind=loopback|lan',
          '--loopback',
          '--lan',
        ],
        json: true,
      },
		      text: [
		        '[dev] usage:',
		        '  hstack dev [--server=happier-server|happier-server-light] [--server-flavor=light|full] [--server-url=<http(s)://...>] [--no-server] [--restart] [--json]',
		        '  hstack dev --watch         # rebuild/restart happier-cli daemon on file changes (TTY default)',
	        '  hstack dev --no-watch      # disable watch mode (always disabled in non-interactive mode)',
	        '  hstack dev --no-browser    # do not open the UI in your browser automatically',
          '  hstack dev --no-dev-targets # skip configured Mutagen-backed remote daemons for this run',
	        '  hstack dev --no-proxy      # bind the dev server directly instead of using the stable-port proxy',
	        '  hstack dev --mobile        # also start Expo dev-client Metro for mobile',
	        '  hstack dev --rn-devtools   # open React Native DevTools (Metro debugger UI) in your browser',
	        '  hstack dev --tauri         # start the desktop Tauri shell against this stack',
	        '  hstack dev --expo-tailscale # forward Expo to Tailscale interface for remote access',
	        '  hstack dev --bind=loopback  # prefer localhost-only URLs (not reachable from phones)',
	        '  hstack dev --no-server --server-url=https://api.example.com',
	        '  note: --json prints the resolved config (dry-run) and exits.',
        '',
        'note:',
        '  If run from inside a repo checkout/worktree, that checkout is used for this run (without requiring `hstack wt use`).',
        '',
        'env:',
        '  HAPPIER_STACK_EXPO_TAILSCALE=1   # enable Expo Tailscale forwarding via env var',
        '  HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB=8192  # default: 8192 (8GB) heap for the Expo/Metro Node process',
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

  // Outside sandbox mode we allow a convenience: if you run `hstack dev` from inside a repo checkout/worktree,
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

  // Convenience alias: allow `--server-flavor=light|full` for parity with `stack pr` and `tools setup-pr`.
  // `--server=...` always wins when both are specified.
	  const serverFlavorFromArg = (kv.get('--server-flavor') ?? '').trim().toLowerCase();
	  if (!kv.get('--server') && serverFlavorFromArg) {
	    if (serverFlavorFromArg === 'light') kv.set('--server', 'happier-server-light');
	    else if (serverFlavorFromArg === 'full') kv.set('--server', 'happier-server');
	    else throw new Error(`[dev] invalid --server-flavor=${serverFlavorFromArg} (expected: light|full)`);
	  }

	  const serverComponentName = getServerComponentName({ kv });
	  if (serverComponentName === 'both') {
	    throw new Error(`[local] --server=both is not supported for dev (pick one: happier-server-light or happier-server)`);
	  }

  const startTauri = flags.has('--tauri') || flags.has('--with-tauri');
  const startUi = !flags.has('--no-ui');
  const requestedStartDaemon = !flags.has('--no-daemon');
  const openReactNativeDevtools = flags.has('--rn-devtools') || flags.has('--react-native-devtools');
  const noBrowser = startTauri || flags.has('--no-browser') || (process.env.HAPPIER_STACK_NO_BROWSER ?? '').toString().trim() === '1';
  const expoTailscale = flags.has('--expo-tailscale') || resolveExpoTailscaleEnabled({ env: process.env });
  const startMobile = flags.has('--mobile') || flags.has('--with-mobile') || expoTailscale;
  const requestedStartExpo = startUi || startMobile;

  if (startTauri && !startUi) {
    throw new Error('[local] --tauri requires the ui');
  }

	  const serverDir = getComponentDir(rootDir, serverComponentName);
	  const uiDir = getComponentDir(rootDir, 'happier-ui');
	  const cliDir = getComponentDir(rootDir, 'happier-cli');

	  const cliBin = join(cliDir, 'bin', 'happier.mjs');
  const autostart = getDefaultAutostartPaths();
  const baseEnv = { ...process.env };
  const parentServerRestartPreflightAlreadyDone = String(
    baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE ?? '',
  ).trim() === '1';
  delete baseEnv.HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE;
  const stackCtx = resolveStackContext({ env: baseEnv, autostart });
  const { stackMode, runtimeStatePath, stackName, envPath, ephemeral } = stackCtx;
  const devTargetsEnabled = !flags.has('--no-dev-targets');
  const loadedDevTargets = await loadDevTargetsConfig({ stackName, env: baseEnv, allowMissing: true });
  const serverPort = await selectLocalServerPortCandidateForStack({
    env: baseEnv,
    stackMode,
    stackName,
    runtimeStatePath,
    defaultPort: 3005,
  });
  // IMPORTANT:
  // - Only the main stack should ever auto-enable (or prefer) Tailscale Serve by default.
  // - Non-main stacks should default to localhost URLs unless the user explicitly configured a public URL
  //   OR Tailscale Serve is already configured for this stack's internal URL (status matches).
  const allowEnableTailscale =
    !stackMode ||
    stackName === 'main' ||
    (baseEnv.HAPPIER_STACK_TAILSCALE_SERVE ?? '0').toString().trim() === '1';
  const resolvedUrls = await resolveServerUrls({ env: baseEnv, serverPort, allowEnable: allowEnableTailscale });
  const serverConnection = resolveDevServerConnection({
    flags,
    kv,
    env: baseEnv,
    resolvedLocalUrls: resolvedUrls,
  });
  const requestedStartServer = serverConnection.startServer;
  const localInternalServerUrl = resolvedUrls.internalServerUrl;
  const internalServerUrl = serverConnection.internalServerUrl;
  let publicServerUrl = serverConnection.publicServerUrl;
  if (requestedStartServer && !serverConnection.hasExplicitPublicServerUrl && stackMode && stackName !== 'main' && !resolvedUrls.envPublicUrl) {
    const src = String(resolvedUrls.publicServerUrlSource ?? '');
    const hasStackScopedTailscale = src.startsWith('tailscale-');
    if (!hasStackScopedTailscale) {
      publicServerUrl = resolvedUrls.defaultPublicUrl;
    }
  }
  // Expo app config: this is what both web + native app use to reach the Happy server.
  // LAN rewrite (for dev-client) is centralized in ensureDevExpoServer.
  const uiApiUrl = requestedStartServer ? resolvedUrls.defaultPublicUrl : serverConnection.uiApiUrl;
  const serverConnectionSource = serverConnection.source;
  const restart = flags.has('--restart');
  const cliHomeDir = process.env.HAPPIER_STACK_CLI_HOME_DIR?.trim()
    ? expandHome(process.env.HAPPIER_STACK_CLI_HOME_DIR.trim())
    : join(autostart.baseDir, 'cli');

  const executionPolicy = resolveDevTargetExecutionPolicy(loadedDevTargets.config, {
    targetsEnabled: devTargetsEnabled,
    serverRequested: requestedStartServer,
  });
  const devTargets = devTargetsEnabled ? loadedDevTargets.config.targets : [];
  const configuredServicePlans = resolveDevTargetServicePlans({
    targets: devTargets,
    policy: executionPolicy,
    requested: {
      server: requestedStartServer,
      expo: requestedStartExpo,
      daemon: requestedStartDaemon,
    },
  });
  if (
    configuredServicePlans.targets.some((plan) => Object.values(plan.services).some(Boolean))
    && !requestedStartServer
  ) {
    throw new Error(
      '[dev-targets] remote runtime placement cannot consume an external --server-url; '
        + 'set runtime placement to local or use --no-dev-targets for this run',
    );
  }
  const remoteServerRuntimeConfig = configuredServicePlans.targets.some((plan) => plan.services.server)
    ? resolveRemoteServerRuntimeConfig({ serverComponentName, env: baseEnv })
    : null;
  let servicePlans = configuredServicePlans;
  const exclusiveTargetPlans = configuredServicePlans.targets.filter((plan) => (
    Object.entries(plan.services).some(([service, enabled]) => enabled && !configuredServicePlans.local[service])
  ));
  if (!json && exclusiveTargetPlans.length > 0) {
    const diagnosis = await runDevTargetsDoctor({
      targets: exclusiveTargetPlans.map((plan) => plan.target),
      env: baseEnv,
    });
    const reachableTargets = new Set(
      diagnosis.targets.filter((target) => target.ok).map((target) => target.name),
    );
    servicePlans = resolveServicePlansAfterTargetPreflight({
      configured: configuredServicePlans,
      mutagenAvailable: diagnosis.mutagen.ok,
      reachableTargets,
    });
  }
  const remoteServerPlan = servicePlans.targets.find((plan) => plan.services.server) ?? null;
  if (!json && remoteServerPlan && (await fetchHappierHealth(localInternalServerUrl)).ok) {
    throw new Error(
      `[dev-targets] the local stable server listener at ${localInternalServerUrl} is still active; `
        + 'stop the current Stack before starting its authoritative remote server',
    );
  }
  const startServer = servicePlans.local.server;
  const startDaemon = servicePlans.local.daemon;
  const startExpo = servicePlans.local.expo;

  if (json) {
    printResult({
      json,
      data: {
        mode: 'dev',
        serverComponentName,
        serverDir,
        uiDir,
        cliDir,
        serverPort,
        internalServerUrl,
        publicServerUrl,
        startServer,
        serverConnectionSource,
        startUi,
        startMobile,
        startTauri,
        startDaemon,
        devTargets,
        executionPolicy,
        servicePlans,
        openReactNativeDevtools,
        cliHomeDir,
      },
    });
    return;
  }

  if (stackMode && runtimeStatePath) {
    await completeInterruptedStackStopBeforeStart({
      rootDir,
      stackName,
      baseDir: autostart.baseDir,
      env: baseEnv,
      json,
    });
  }

  if (startServer) {
    assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });
    assertServerPrismaProviderMatches({ serverComponentName, serverDir });
    await requireDir(serverComponentName, serverDir);
  }
  await requireDir('happier-ui', uiDir);
  await requireDir('happier-cli', cliDir);

  const children = [];
  let devTargetsController = null;
  let shuttingDown = false;
  let shutdown = null;
  let pendingShutdownSignal = null;
  let shutdownDispatchStarted = false;
  const dispatchShutdown = (signal) => {
    if (shutdownDispatchStarted) return;
    if (!shutdown) {
      pendingShutdownSignal = signal;
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
  installExitCleanup({ label: 'local', children });

  const buildCli = (baseEnv.HAPPIER_STACK_CLI_BUILD ?? '1').toString().trim() !== '0';

  // Watch mode (interactive only by default): rebuild happier-cli and restart daemon when code changes.
  const watchEnabled =
    flags.has('--watch') || (!flags.has('--no-watch') && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const watchers = [];

  const serverHealthObservation = startServer
    ? await fetchHappierHealth(localInternalServerUrl)
    : null;
  const serverAlreadyRunning = serverHealthObservation?.ok === true;
  let serverRuntimeProxyAlreadyOwned = false;
  let serverTopology = 'absent';
  if (startServer) {
    const topologyScope = createListenerOwnershipCommandScope();
    const serverTopologyObservation = await observeDevServerStartupTopology({
      serverRequested: true, stackMode, serverPort, serverHealthObservation,
      ownershipArgs: { env: baseEnv, port: serverPort, stackName, runtimeStatePath, listenerObservationScope: topologyScope },
    }, {
      observeTcpPortAvailabilityImpl: observeTcpPortAvailability,
      observeRuntimePortOwnedByStackDevProxyImpl: observeRuntimePortOwnedByStackDevProxy,
      resolveStackOwnedServerListenPidImpl: () => resolveStackOwnedServerListenPid(
        { serverPort, stackName, envPath }, { observationScope: topologyScope },
      ),
    });
    serverTopology = serverTopologyObservation.topology;
    serverRuntimeProxyAlreadyOwned = serverTopologyObservation.proxyOwned;
  }
  const daemonAlreadyRunning = startDaemon
    ? ['running', 'starting'].includes((await checkDaemonStatePingAware(cliHomeDir, {
        serverUrl: internalServerUrl,
        env: baseEnv,
        stackName,
      })).status)
    : false;
  // Expo dev server state (worktree-scoped): single Expo process per stack/worktree.
  const expoPaths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'expo-dev',
    projectDir: uiDir,
    stateFileName: 'expo.state.json',
  });
  const expoRunning = startExpo ? await isStateProcessRunning(expoPaths.statePath) : { running: false, state: null };
  let expoAlreadyRunning = Boolean(expoRunning.running);
  const startupDecision = decideDevStartupTopology({
    serverRequested: startServer,
    serverTopology,
    daemonRequested: startDaemon,
    daemonRunning: daemonAlreadyRunning,
    expoRequested: startExpo,
    expoRunning: expoAlreadyRunning,
    restart,
  });

  if (shouldExitAdoptedDevRuntime({
    devTargetCount: servicePlans.targets.length,
    restart,
    watchEnabled,
    serverRequested: startServer,
    adoptedServer: startupDecision.adoptedServer,
    daemonRequested: startDaemon,
    daemonRunning: daemonAlreadyRunning,
    expoRequested: startExpo,
    expoRunning: expoAlreadyRunning,
  })) {
    console.log(
      `${green('✓')} dev: already running ${dim('(')}` +
        `${dim('server=')}${cyan(internalServerUrl)}${startServer ? '' : dim(' (external)')}` +
        `${startDaemon ? ` ${dim('daemon=')}${daemonAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${startUi ? ` ${dim('ui=')}${expoAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${startMobile ? ` ${dim('mobile=')}${expoAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${dim(')')}`
    );
    return;
  }

  if (stackMode && runtimeStatePath) {
    const startedRuntime = await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      script: 'dev.mjs',
      ephemeral,
      ownerPid: process.pid,
      ports: requestedStartServer ? { server: serverPort } : {},
      runtimeSnapshotId: null,
      serveUi: null,
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

  const remoteExpoPlan = servicePlans.targets.find((plan) => plan.services.expo) ?? null;
  const remoteExpoPort = remoteExpoPlan
    ? (await selectExpoDevMetroPort({
        env: baseEnv,
        stackMode,
        stackName,
        host: resolveExpoDevHost({ env: baseEnv }) === 'lan' ? '0.0.0.0' : '127.0.0.1',
      })).port
    : null;
  const remotePublicServerUrl = startMobile
    ? resolveMobileReachableServerUrl({
        env: baseEnv,
        serverUrl: publicServerUrl,
        serverPort,
      })
    : remoteServerPlan ? publicServerUrl : uiApiUrl;
  const expoPublicUrl = remoteExpoPort
    ? resolveMobileReachableServerUrl({
        env: baseEnv,
        serverUrl: `http://localhost:${remoteExpoPort}`,
        serverPort: remoteExpoPort,
      })
    : '';
  const resolveMobilePublicUrlsOnTarget =
    startMobile
    && !serverConnection.hasExplicitPublicServerUrl
    && !resolvedUrls.envPublicUrl
    && !hasExplicitMobileReachableHost({ env: baseEnv });

  const buildDevTargetsStartOptions = () => {
    if (servicePlans.targets.length === 0) return null;
    const credentialPath = servicePlans.targets.some((plan) => plan.services.daemon)
      ? findExistingStackCredentialPath({
          cliHomeDir,
          serverUrl: internalServerUrl,
          env: baseEnv,
        })
      : null;
    return {
      stackName,
      stackBaseDir: loadedDevTargets.path ? dirname(loadedDevTargets.path) : autostart.baseDir,
      sourceDir: resolve(cliDir, '..', '..'),
      localServerPort: serverPort,
      localExpoPort: remoteExpoPort,
      publicServerUrl: remotePublicServerUrl,
      expoPublicUrl,
      resolveMobilePublicUrlsOnTarget,
      expoListenHost: resolveExpoDevHost({ env: baseEnv }) === 'lan' ? '0.0.0.0' : '127.0.0.1',
      startMobile,
      activeServerId: resolveStackActiveServerId({ env: baseEnv, stackName }),
      credentialPath,
      remoteServerRuntimeConfig,
      syncTargets: devTargets,
      targetPlans: servicePlans.targets,
      onTargetStateChange: async ({ name, ...state }) => {
        if (!stackMode || !runtimeStatePath) return;
        const ownsServer = state.services?.server === true;
        await recordStackRuntimeUpdate(runtimeStatePath, {
          remoteTargets: { [name]: state },
          ...(ownsServer && state.status === 'running'
            ? {
                placement: {
                  server: name,
                  daemon: startDaemon ? 'local' : name,
                  expo: startExpo ? 'local' : remoteExpoPlan?.target.name ?? 'disabled',
                },
                ...createStackServerRuntimeProcessPatch({
                  listenerPid: null,
                  wrapperPid: null,
                  serverPort,
                  clearProxyState: true,
                }),
              }
            : {}),
        }).catch(() => {});
      },
      env: baseEnv,
    };
  };

  // Start server (only if not already healthy)
  // NOTE: In stack mode we avoid killing arbitrary port listeners (fail-closed instead).
  if (startServer && (!serverAlreadyRunning || restart) && !stackMode) {
    await killPortListeners(serverPort, { label: 'server' });
  }

  const devProxyEnabled = shouldEnableStackDevProxy({ startServer, flags, env: baseEnv });
  let proxyPlan = {
    mode: 'direct',
    stablePort: serverPort,
    backendPort: serverPort,
    proxyController: null,
    fallbackReason: null,
  };
  if (startServer && devProxyEnabled && startupDecision.startServer) {
    const stableHost = resolveDevProxyStableHost({ env: baseEnv });
    const onUnexpectedExit = createDevProxyUnexpectedExitHandler({
      stackMode,
      runtimeStatePath,
      requestShutdownImpl: () => {
        process.exitCode = 1;
        process.kill(process.pid, 'SIGTERM');
      },
      logger: console,
    });
    proxyPlan = await prepareDevProxyStartup({
      enabled: true,
      stablePort: serverPort,
      stableHost,
      targetHost: '127.0.0.1',
      label: `${stackName ?? 'stack'}-server-proxy`,
      logger: console,
      onUnexpectedExit,
    });
  }
  const serverBindPort = proxyPlan.backendPort;
  const serverBackendInternalUrl = `http://127.0.0.1:${serverBindPort}`;

  const { serverEnv, serverScript, serverProc } = startServer && startupDecision.startServer
    ? await startDevServer({
        serverComponentName,
        serverDir,
        autostart,
        baseEnv: parentServerRestartPreflightAlreadyDone
          ? { ...baseEnv, HAPPIER_STACK_SERVER_RESTART_PREFLIGHT_ALREADY_DONE: '1' }
          : baseEnv,
        serverPort,
        serverBindPort,
        internalServerUrl: serverBackendInternalUrl,
        publicServerUrl,
        envPath,
        stackMode,
        runtimeStatePath,
        serverAlreadyRunning,
        restart,
        children,
        serverProxyRuntime: proxyPlan.mode === 'proxy'
          ? {
              enabled: true,
              proxyPid: proxyPlan.proxyController?.pid,
              mode: 'proxy',
            }
          : proxyPlan.mode === 'directFallback'
            ? {
                enabled: true,
                proxyPid: null,
                mode: 'directFallback',
                fallbackReason: proxyPlan.fallbackReason,
              }
            : null,
      })
    : { serverEnv: baseEnv, serverScript: null, serverProc: null };
  if (remoteServerPlan) {
    console.log(`${green('✓')} server: remote startup through ${cyan(internalServerUrl)}`);
  } else if (!startServer) {
    console.log(`${green('✓')} server: external ${cyan(internalServerUrl)}`);
  } else if (startupDecision.startServer) {
    console.log(`${green('✓')} server: ready at ${cyan(internalServerUrl)}`);
  } else {
    console.log(`${green('✓')} server: already running at ${cyan(internalServerUrl)}`);
  }
  console.log(
    renderTerminalUsageInstructions({
      internalServerUrl,
      cliHomeDir,
      publicServerUrl,
      activeServerId: resolveStackActiveServerId({ env: baseEnv, stackName }),
      stackName,
    }).join('\n'),
  );

  if (remoteServerPlan) {
    const devTargetsStartOptions = buildDevTargetsStartOptions();
    if (stackMode && runtimeStatePath) {
      await recordStackRuntimeUpdate(runtimeStatePath, {
        placement: {
          server: remoteServerPlan.target.name,
          daemon: startDaemon ? 'local' : remoteServerPlan.target.name,
          expo: startExpo ? 'local' : remoteExpoPlan?.target.name ?? 'disabled',
        },
        remoteTargets: Object.fromEntries(servicePlans.targets.map((plan) => [
          plan.target.name,
          {
            services: plan.services,
            serviceStatus: Object.fromEntries(
              Object.entries(plan.services)
                .filter(([, enabled]) => enabled)
                .map(([service]) => [service, 'starting']),
            ),
            status: 'starting',
          },
        ])),
      });
    }
    devTargetsController = await startStackDevTargets(devTargetsStartOptions);
    console.log(
      `${green('✓')} server: remote ${remoteServerPlan.target.name} ready through ${cyan(internalServerUrl)}`,
    );
  }

  // Reliability before daemon start:
  // - Ensure schema exists (server-light: canonical provider migration script; happier-server: migrate deploy if tables missing)
  // - Auto-seed from main only when needed (non-main + non-interactive default, and only if missing creds or 0 accounts)
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const accountProbeImpl = startupDecision.adoptedServer
    ? probeExistingAccountCountForServerComponent
    : getAccountCountForServerComponent;
  const accountProbe = startServer
    ? await accountProbeImpl({
        serverComponentName,
        serverDir,
        env: serverEnv,
        bestEffort: true,
      })
    : null;
  const accountCount =
    startServer && typeof accountProbe?.accountCount === 'number' ? accountProbe.accountCount : null;
  const autoSeedEnabled = resolveAutoCopyFromMainEnabled({ env: baseEnv, stackName, isInteractive });

  let expoResEarly = null;
  const wantsAuthFlow =
    (baseEnv.HAPPIER_STACK_AUTH_FLOW ?? '').toString().trim() === '1' ||
    (baseEnv.HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH ?? '').toString().trim() === '1';

  if (startServer) {
    // CRITICAL (review-pr / setup-pr guided login):
    // In background/non-interactive runs, the daemon may block on auth. If we wait to start Expo web
    // until after the daemon is authenticated, guided login will have no UI origin and will fall back
    // to the server port (wrong). Start Expo web UI early when running an auth flow.
    if (wantsAuthFlow && startUi && !expoResEarly) {
      expoResEarly = await ensureDevExpoServer({
        startUi,
        startMobile,
        uiDir,
        autostart,
        baseEnv,
        apiServerUrl: uiApiUrl,
        restart,
        stackMode,
        runtimeStatePath,
        stackName,
        envPath,
        children,
        spawnOptions: { stdio: ['ignore', 'ignore', 'ignore'] },
        expoTailscale,
      });
    }
    await maybeRunInteractiveStackAuthSetup({
      rootDir,
      // In dev mode, guided login must target the Expo web UI origin (not the server port).
      // Mark this as an auth-flow so URL resolution fails closed if Expo isn't ready.
      env: startUi ? { ...baseEnv, HAPPIER_STACK_AUTH_FLOW: '1' } : baseEnv,
      stackName,
      cliHomeDir,
      accountCount,
      isInteractive,
      autoSeedEnabled,
      beforeLogin: async () => {
        if (!startUi) {
          throw new Error(
            `[local] auth: interactive login requires the web UI.\n` +
              `Re-run without --no-ui, or set HAPPIER_WEBAPP_URL to a reachable Happier UI for this stack.`
          );
        }
        if (expoResEarly) return;
        expoResEarly = await ensureDevExpoServer({
          startUi,
          startMobile,
          uiDir,
          autostart,
          baseEnv,
          apiServerUrl: uiApiUrl,
          restart,
          stackMode,
          runtimeStatePath,
          stackName,
          envPath,
          children,
          expoTailscale,
        });
      },
    });
    await prepareDaemonAuthSeed({
      rootDir,
      env: baseEnv,
      stackName,
      cliHomeDir,
      startDaemon: startupDecision.startDaemon,
      isInteractive,
      serverComponentName,
      serverDir,
      serverEnv,
      quiet: false,
    });
  }

  if (startupDecision.startDaemon) {
    const gate = daemonStartGate({ env: baseEnv, cliHomeDir, serverUrl: internalServerUrl });
    if (!gate.ok) {
      // In orchestrated auth flows (setup-pr/review-pr), we intentionally keep server/UI up
      // for guided login and start daemon post-auth from the orchestrator.
      if (gate.reason === 'auth_flow_missing_credentials') {
        console.log('[local] auth flow: skipping daemon start until credentials exist');
      } else {
        const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!isInteractive) {
          throw new Error(formatDaemonAuthRequiredError({ stackName, cliHomeDir, serverUrl: internalServerUrl }));
        }
      }
    } else {
      await startDevDaemon({
        startDaemon: true,
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        runtimeStatePath,
        restart,
        startLastGreen: watchEnabled,
        isShuttingDown: () => shuttingDown,
        env: baseEnv,
        stackName,
      });
    }
  }

  if (startDaemon && stackMode && runtimeStatePath) {
    const daemonRuntimeEnv = getDaemonEnv({
      baseEnv,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl: publicServerUrl || internalServerUrl,
      stackName,
      cliIdentity: 'default',
    });
    const daemonRuntimeReconciler = startStackRuntimeDaemonPidReconciler(
      {
        runtimeStatePath,
        cliHomeDir,
        internalServerUrl,
        env: daemonRuntimeEnv,
        isShuttingDown: () => shuttingDown,
      },
      {
        checkDaemonStateImpl: checkDaemonStatePingAware,
      },
    );
    if (daemonRuntimeReconciler) {
      watchers.push(daemonRuntimeReconciler);
      await daemonRuntimeReconciler.syncNow();
    }

    const daemonLifecycleReconciler = startDevDaemonLifecycleReconciler({
      enabled: true,
      isShuttingDown: () => shuttingDown,
      observe: async () => {
        const gate = daemonStartGate({ env: baseEnv, cliHomeDir, serverUrl: internalServerUrl });
        if (!gate.ok) return { status: 'inconclusive', reason: gate.reason };
        return await checkDaemonStatePingAware(cliHomeDir, {
          serverUrl: internalServerUrl,
          env: daemonRuntimeEnv,
          stackName,
        });
      },
      recover: async () => {
        await startDevDaemon({
          startDaemon: true,
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          runtimeStatePath,
          restart: false,
          startLastGreen: watchEnabled,
          isShuttingDown: () => shuttingDown,
          env: baseEnv,
          stackName,
        });
        return { started: true };
      },
    });
    if (daemonLifecycleReconciler) watchers.push(daemonLifecycleReconciler);
  }

  const serverProcRef = { current: serverProc };
  if (startServer && stackMode && runtimeStatePath && !serverProcRef.current?.pid && !serverRuntimeProxyAlreadyOwned) {
    // If the server was already running when we started dev, `startDevServer` won't spawn a new process
    // (and therefore we don't have a ChildProcess handle). For safe watch/restart we need a PID.
    const pid = await resolveStackOwnedServerRuntimePid({
      runtimeStatePath,
      serverPort: proxyPlan.mode === 'proxy' ? serverBindPort : serverPort,
      stackName,
      envPath,
    }, { observationScope: createListenerOwnershipCommandScope() });
    if (Number.isFinite(pid) && pid > 1) {
      serverProcRef.current = { pid: Number(pid), exitCode: null };
      await recordStackRuntimeServerPids(runtimeStatePath, {
        listenerPid: Number(pid),
        wrapperPid: null,
        serverPort,
        clearProxyState: proxyPlan.mode !== 'proxy',
      });
    }
  }

  const daemonReloadEnabled = watchEnabled && startDaemon && daemonStartGate({ env: baseEnv, cliHomeDir, serverUrl: internalServerUrl }).ok;
  const serverReloadEnabled = startServer && watchEnabled && Boolean(serverProcRef.current?.pid);
  const reloadWatcher = startDevReloadComposition({
    watchEnabled,
    daemonReloadEnabled,
    daemonOptions: {
      startDaemon,
      buildCli,
      cliDir,
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      runtimeStatePath,
      isShuttingDown: () => shuttingDown,
      env: baseEnv,
      stackName,
    },
    serverReloadEnabled,
    serverOptions: {
      enabled: true,
      stackMode,
      serverComponentName,
      serverDir,
      serverPort,
      serverBindPort,
      internalServerUrl,
      serverScript,
      serverEnv,
      runtimeStatePath,
      stackName,
      envPath,
      children,
      serverProcRef,
      isShuttingDown: () => shuttingDown,
      proxyController: proxyPlan.mode === 'proxy' ? proxyPlan.proxyController : null,
    },
    debounceMs: 500,
    pollIntervalMs: resolveDevReloadPollIntervalMs(baseEnv),
    isShuttingDown: () => shuttingDown,
    logger: console,
  });
  if (reloadWatcher) watchers.push(reloadWatcher);

  if (startServer && watchEnabled && stackMode && serverComponentName === 'happier-server' && !serverReloadEnabled) {
    console.warn(
      `[local] watch: server restart is disabled because the running server PID is unknown.\n` +
        `[local] watch: fix: re-run with --restart so hstack can (re)spawn the server and track its PID.`
    );
  }

  const expoRes =
    expoResEarly ??
    (remoteExpoPlan
      ? {
          ok: true,
          skipped: true,
          reason: 'remote_target',
          port: remoteExpoPort,
          target: remoteExpoPlan.target.name,
        }
      : await ensureDevExpoServer({
      startUi,
      startMobile,
      uiDir,
      autostart,
      baseEnv,
      apiServerUrl: uiApiUrl,
      restart,
      stackMode,
      runtimeStatePath,
      stackName,
      envPath,
      children,
      expoTailscale,
      }));
  if (startUi) {
    const uiPort = expoRes?.port;
    const uiUrlRaw = uiPort ? `http://localhost:${uiPort}` : '';
    const uiUrl = uiUrlRaw ? await preferStackLocalhostUrl(uiUrlRaw, { stackName }) : '';
    const uiOpenUrl = uiUrl
      ? buildConfigureServerLinks({ webappUrl: uiUrl, serverUrl: publicServerUrl }).webUrl
      : '';
    if (expoRes?.reason === 'already_running' && expoRes.port) {
      console.log(`[local] ui already running (pid=${expoRes.pid}, port=${expoRes.port})`);
      if (uiOpenUrl) console.log(`[local] ui: open ${uiOpenUrl}`);
    } else if (expoRes?.skipped === false && expoRes.port) {
      if (uiOpenUrl) console.log(`[local] ui: open ${uiOpenUrl}`);
    } else if (expoRes?.skipped && expoRes?.reason === 'already_running') {
      console.log('[local] ui already running (skipping Expo start)');
    }

    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const shouldOpen = isInteractive && !noBrowser && Boolean(expoRes?.port);
    if (shouldOpen) {
      // Prefer localhost for readiness checks (faster/more reliable), but open the stack-scoped hostname.
      await waitForHttpOk(`http://localhost:${expoRes.port}`, { timeoutMs: 30_000 }).catch(() => {});
      const res = await openUrlInBrowser(uiOpenUrl || uiUrl);
      if (!res.ok) {
        console.warn(`[local] ui: failed to open browser automatically (${res.error}).`);
      }
    }
  }

  if (openReactNativeDevtools && expoRes?.port) {
    const metroOriginRaw = `http://localhost:${expoRes.port}`;
    const metroOrigin = await preferStackLocalhostUrl(metroOriginRaw, { stackName });
    const devtoolsUrl = resolveReactNativeDevtoolsUrl({ metroUrl: metroOrigin, env: baseEnv });
    if (devtoolsUrl) {
      console.log(`[local] rn-devtools: open ${devtoolsUrl}`);
      const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      const shouldOpen = isInteractive && !noBrowser;
      if (shouldOpen) {
        await waitForHttpOk(devtoolsUrl, { timeoutMs: 30_000 }).catch(() => {});
        const res = await openUrlInBrowser(devtoolsUrl);
        if (!res.ok) {
          console.warn(`[local] rn-devtools: failed to open browser automatically (${res.error}).`);
        }
      }
    }
  }

  if (startMobile && expoRes?.port) {
    const metroUrl = await preferStackLocalhostUrl(`http://localhost:${expoRes.port}`, { stackName });
    console.log(`[local] mobile: metro ${metroUrl}`);
  }

  if (daemonReloadEnabled && reloadWatcher?.requestReload) {
    void reloadWatcher.requestReload('daemon');
  }

  if (servicePlans.targets.length > 0 && !devTargetsController) {
    devTargetsController = startStackDevTargetsInBackground(buildDevTargetsStartOptions());
  }

  if (startTauri) {
    const invocation = resolveTauriPaneInvocation({ rootDir, env: baseEnv });
    const tauri = spawnProc('tauri', invocation.command, invocation.args, baseEnv, {
      cwd: invocation.cwd,
      ...(process.platform === 'win32'
        ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    });
    children.push(tauri);
  }

  // Show Tailscale URL if forwarder is running
  if (expoRes?.tailscale?.ok && expoRes.tailscale.tailscaleIp && expoRes.port) {
    console.log(`[local] expo tailscale: http://${expoRes.tailscale.tailscaleIp}:${expoRes.port}`);
  }

  shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const shutdownRequest = runtimeStatePath
      ? (await readStackRuntimeStateFile(runtimeStatePath).catch(() => null))?.stopRequest ?? null
      : null;
    const expectedStopState = runtimeStatePath
      ? await captureStackRuntimeStopSnapshot(runtimeStatePath).catch(() => null)
      : null;
    const preserveDaemonOnShutdown = shutdownRequest?.preserveDaemon === true;
    console.log('\n[local] shutting down...');

    if (devTargetsController) {
      await devTargetsController.close().catch(() => {});
    }

    for (const w of watchers) {
      try {
        await w.close?.();
      } catch {
        // ignore
      }
    }

    if (proxyPlan?.proxyController) {
      await proxyPlan.proxyController.stop().catch(() => {});
    }

    if (startDaemon && !preserveDaemonOnShutdown) {
      await stopLocalDaemon({
        cliBin,
        internalServerUrl,
        cliHomeDir,
        runtimeStatePath,
        env: baseEnv,
        stackName,
        cliIdentity: String(baseEnv.HAPPIER_STACK_CLI_IDENTITY ?? '').trim() || 'default',
      });
    }

    const serverShutdownGraceMs = resolveServerShutdownGraceMs(baseEnv);
    const cleanupResults = await Promise.all(children
      .filter((child) => child.exitCode == null)
      .map((child) => killProcessTree(child, 'SIGINT',
        child === serverProcRef.current ? { graceMs: serverShutdownGraceMs } : undefined)));

    await delay(1500);
    cleanupResults.push(...await Promise.all(children
      .filter((child) => child.exitCode == null)
      .map((child) => killProcessTree(child, 'SIGKILL'))));
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

  await new Promise(() => {});
}

main().catch(async (err) => {
  console.error('[local] failed:', err);
  if (err?.code === 'ESERVERRUNTIMEPROJECTION' && err?.serverActivationCommitted === true) {
    process.exitCode = 1;
    await new Promise(() => {});
    return;
  }
  process.exit(1);
});
