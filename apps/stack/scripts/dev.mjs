import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { killProcessTree } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { killPortListeners } from './utils/net/ports.mjs';
import { getServerComponentName, isHappyServerRunning } from './utils/server/server.mjs';
import { requireDir } from './utils/proc/pm.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { isDaemonRunning, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/server/validate.mjs';
import { getExpoStatePaths, isStateProcessRunning } from './utils/expo/expo.mjs';
import { isPidAlive, readStackRuntimeStateFile, recordStackRuntimeStart } from './utils/stack/runtime_state.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import { ensureDevCliReady, prepareDaemonAuthSeed, startDevDaemon, watchHappyCliAndRestartDaemon } from './utils/dev/daemon.mjs';
import { startDevServer, watchDevServerAndRestart } from './utils/dev/server.mjs';
import { ensureDevExpoServer, resolveExpoTailscaleEnabled } from './utils/dev/expo_dev.mjs';
import { preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { waitForHttpOk } from './utils/server/server.mjs';
import { sanitizeDnsLabel } from './utils/net/dns.mjs';
import { getAccountCountForServerComponent, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { maybeRunInteractiveStackAuthSetup } from './utils/auth/interactive_stack_auth.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { daemonStartGate, formatDaemonAuthRequiredError } from './utils/auth/daemon_gate.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';
import { cmd, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green } from './utils/ui/ansi.mjs';

/**
 * Dev mode stack:
 * - happy-server-light
 * - happy-cli daemon
 * - Expo web dev server (watch/reload)
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
          '--server=happy-server|happy-server-light',
          '--no-ui',
          '--no-daemon',
          '--restart',
          '--watch',
          '--no-watch',
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
        '[dev] usage:',
        '  hapsta dev [--server=happy-server|happy-server-light] [--restart] [--json]',
        '  hapsta dev --watch         # rebuild/restart happy-cli daemon on file changes (TTY default)',
        '  hapsta dev --no-watch      # disable watch mode (always disabled in non-interactive mode)',
        '  hapsta dev --no-browser    # do not open the UI in your browser automatically',
        '  hapsta dev --mobile        # also start Expo dev-client Metro for mobile',
        '  hapsta dev --expo-tailscale # forward Expo to Tailscale interface for remote access',
        '  hapsta dev --bind=loopback  # prefer localhost-only URLs (not reachable from phones)',
        '  note: --json prints the resolved config (dry-run) and exits.',
        '',
        'note:',
        '  If run from inside a component checkout/worktree, that checkout is used for this run (without requiring `hapsta wt use`).',
        '',
        'env:',
        '  HAPPIER_STACK_EXPO_TAILSCALE=1   # enable Expo Tailscale forwarding via env var',
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

  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd: getInvokedCwd(process.env),
    components: ['happy', 'happy-cli', 'happy-server-light', 'happy-server'],
  });
  if (inferred) {
    // Stack env should win. Only infer from CWD when the repo dir isn't already configured.
    if (!(process.env.HAPPIER_STACK_REPO_DIR ?? '').toString().trim()) {
      process.env.HAPPIER_STACK_REPO_DIR = inferred.repoDir;
    }
  }

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for dev (pick one: happy-server-light or happy-server)`);
  }

  const startUi = !flags.has('--no-ui');
  const startDaemon = !flags.has('--no-daemon');
  const startMobile = flags.has('--mobile') || flags.has('--with-mobile');
  const noBrowser = flags.has('--no-browser') || (process.env.HAPPIER_STACK_NO_BROWSER ?? '').toString().trim() === '1';
  const expoTailscale = flags.has('--expo-tailscale') || resolveExpoTailscaleEnabled({ env: process.env });

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const uiDir = getComponentDir(rootDir, 'happy');
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });
  assertServerPrismaProviderMatches({ serverComponentName, serverDir });

  await requireDir(serverComponentName, serverDir);
  await requireDir('happy', uiDir);
  await requireDir('happy-cli', cliDir);

  const cliBin = join(cliDir, 'bin', 'happy.mjs');
  const autostart = getDefaultAutostartPaths();
  const baseEnv = { ...process.env };
  const stackCtx = resolveStackContext({ env: baseEnv, autostart });
  const { stackMode, runtimeStatePath, stackName, envPath, ephemeral } = stackCtx;

  const serverPort = resolveServerPortFromEnv({ env: baseEnv, defaultPort: 3005 });
  // IMPORTANT:
  // - Only the main stack should ever auto-enable (or prefer) Tailscale Serve by default.
  // - Non-main stacks should default to localhost URLs unless the user explicitly configured a public URL
  //   OR Tailscale Serve is already configured for this stack's internal URL (status matches).
  const allowEnableTailscale =
    !stackMode ||
    stackName === 'main' ||
    (baseEnv.HAPPIER_STACK_TAILSCALE_SERVE ?? '0').toString().trim() === '1';
  const resolvedUrls = await resolveServerUrls({ env: baseEnv, serverPort, allowEnable: allowEnableTailscale });
  const internalServerUrl = resolvedUrls.internalServerUrl;
  let publicServerUrl = resolvedUrls.publicServerUrl;
  if (stackMode && stackName !== 'main' && !resolvedUrls.envPublicUrl) {
    const src = String(resolvedUrls.publicServerUrlSource ?? '');
    const hasStackScopedTailscale = src.startsWith('tailscale-');
    if (!hasStackScopedTailscale) {
      publicServerUrl = resolvedUrls.defaultPublicUrl;
    }
  }
  // Expo app config: this is what both web + native app use to reach the Happy server.
  // LAN rewrite (for dev-client) is centralized in ensureDevExpoServer.
  const uiApiUrl = resolvedUrls.defaultPublicUrl;
  const restart = flags.has('--restart');
  const cliHomeDir = process.env.HAPPIER_STACK_CLI_HOME_DIR?.trim()
    ? process.env.HAPPIER_STACK_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(autostart.baseDir, 'cli');

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
        startUi,
        startMobile,
        startDaemon,
        cliHomeDir,
      },
    });
    return;
  }

  const children = [];
  let shuttingDown = false;

  // Ensure happy-cli is install+build ready before starting the daemon.
  // Worktrees often don't have dist/ built yet, which causes MODULE_NOT_FOUND on dist/index.mjs.
  const buildCli = (baseEnv.HAPPIER_STACK_CLI_BUILD ?? '1').toString().trim() !== '0';
  await ensureDevCliReady({ cliDir, buildCli });

  // Watch mode (interactive only by default): rebuild happy-cli and restart daemon when code changes.
  const watchEnabled =
    flags.has('--watch') || (!flags.has('--no-watch') && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const watchers = [];

  const serverAlreadyRunning = await isHappyServerRunning(internalServerUrl);
  const daemonAlreadyRunning = startDaemon ? isDaemonRunning(cliHomeDir) : false;

  // Expo dev server state (worktree-scoped): single Expo process per stack/worktree.
  const startExpo = startUi || startMobile;
  const expoPaths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'expo-dev',
    projectDir: uiDir,
    stateFileName: 'expo.state.json',
  });
  const expoRunning = startExpo ? await isStateProcessRunning(expoPaths.statePath) : { running: false, state: null };
  let expoAlreadyRunning = Boolean(expoRunning.running);

  if (!restart && serverAlreadyRunning && (!startDaemon || daemonAlreadyRunning) && (!startExpo || expoAlreadyRunning)) {
    console.log(
      `${green('✓')} dev: already running ${dim('(')}` +
        `${dim('server=')}${cyan(internalServerUrl)}` +
        `${startDaemon ? ` ${dim('daemon=')}${daemonAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${startUi ? ` ${dim('ui=')}${expoAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${startMobile ? ` ${dim('mobile=')}${expoAlreadyRunning ? green('running') : dim('stopped')}` : ''}` +
        `${dim(')')}`
    );
    return;
  }

  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      script: 'dev.mjs',
      ephemeral,
      ownerPid: process.pid,
      ports: { server: serverPort },
    }).catch(() => {});
  }

  // Start server (only if not already healthy)
  // NOTE: In stack mode we avoid killing arbitrary port listeners (fail-closed instead).
  if ((!serverAlreadyRunning || restart) && !stackMode) {
    await killPortListeners(serverPort, { label: 'server' });
  }

  const { serverEnv, serverScript, serverProc } = await startDevServer({
    serverComponentName,
    serverDir,
    autostart,
    baseEnv,
    serverPort,
    internalServerUrl,
    publicServerUrl,
    envPath,
    stackMode,
    runtimeStatePath,
    serverAlreadyRunning,
    restart,
    children,
  });

  if (!serverAlreadyRunning || restart) {
    console.log(`${green('✓')} server: ready at ${cyan(internalServerUrl)}`);
  } else {
    console.log(`${green('✓')} server: already running at ${cyan(internalServerUrl)}`);
  }
  console.log('');
  console.log(sectionTitle('Terminal usage'));
  console.log(dim(`To run ${cyan('happy')} against this stack (and have sessions appear in the UI), export:`));
  console.log(cmd(`export HAPPY_SERVER_URL="${internalServerUrl}"`));
  console.log(cmd(`export HAPPY_HOME_DIR="${cliHomeDir}"`));
  console.log(cmd(`export HAPPY_WEBAPP_URL="${publicServerUrl}"`));

  // Reliability before daemon start:
  // - Ensure schema exists (server-light: prisma migrate deploy; happy-server: migrate deploy if tables missing)
  // - Auto-seed from main only when needed (non-main + non-interactive default, and only if missing creds or 0 accounts)
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const accountProbe = await getAccountCountForServerComponent({
    serverComponentName,
    serverDir,
    env: serverEnv,
    bestEffort: true,
  });
  const accountCount = typeof accountProbe.accountCount === 'number' ? accountProbe.accountCount : null;
  const autoSeedEnabled = resolveAutoCopyFromMainEnabled({ env: baseEnv, stackName, isInteractive });

  let expoResEarly = null;
  const wantsAuthFlow =
    (baseEnv.HAPPIER_STACK_AUTH_FLOW ?? '').toString().trim() === '1' ||
    (baseEnv.HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH ?? '').toString().trim() === '1';

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
            `Re-run without --no-ui, or set HAPPY_WEBAPP_URL to a reachable Happy UI for this stack.`
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
    startDaemon,
    isInteractive,
    serverComponentName,
    serverDir,
    serverEnv,
    quiet: false,
  });

  if (startDaemon) {
    const gate = daemonStartGate({ env: baseEnv, cliHomeDir });
    if (!gate.ok) {
      // In orchestrated auth flows (setup-pr/review-pr), we intentionally keep server/UI up
      // for guided login and start daemon post-auth from the orchestrator.
      if (gate.reason === 'auth_flow_missing_credentials') {
        console.log('[local] auth flow: skipping daemon start until credentials exist');
      } else {
        const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!isInteractive) {
          throw new Error(formatDaemonAuthRequiredError({ stackName, cliHomeDir }));
        }
      }
    } else {
      await startDevDaemon({
        startDaemon,
        cliBin,
        cliHomeDir,
        internalServerUrl,
        publicServerUrl,
        restart,
        isShuttingDown: () => shuttingDown,
      });
    }
  }

  const cliWatcher = watchHappyCliAndRestartDaemon({
    enabled: watchEnabled,
    startDaemon: startDaemon && daemonStartGate({ env: baseEnv, cliHomeDir }).ok,
    buildCli,
    cliDir,
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => shuttingDown,
  });
  if (cliWatcher) watchers.push(cliWatcher);

  const serverProcRef = { current: serverProc };
  if (stackMode && runtimeStatePath && !serverProcRef.current?.pid) {
    // If the server was already running when we started dev, `startDevServer` won't spawn a new process
    // (and therefore we don't have a ChildProcess handle). For safe watch/restart we need a PID.
    const state = await readStackRuntimeStateFile(runtimeStatePath);
    const pid = state?.processes?.serverPid;
    if (isPidAlive(pid)) {
      serverProcRef.current = { pid: Number(pid), exitCode: null };
    }
  }
  const serverWatcher = watchDevServerAndRestart({
    enabled: watchEnabled && Boolean(serverProcRef.current?.pid),
    stackMode,
    serverComponentName,
    serverDir,
    serverPort,
    internalServerUrl,
    serverScript,
    serverEnv,
    runtimeStatePath,
    stackName,
    envPath,
    children,
    serverProcRef,
    isShuttingDown: () => shuttingDown,
  });
  if (serverWatcher) watchers.push(serverWatcher);
  if (watchEnabled && stackMode && serverComponentName === 'happy-server' && !serverWatcher) {
    console.warn(
      `[local] watch: server restart is disabled because the running server PID is unknown.\n` +
        `[local] watch: fix: re-run with --restart so Hapsta can (re)spawn the server and track its PID.`
    );
  }

  const expoRes =
    expoResEarly ??
    (await ensureDevExpoServer({
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
    if (expoRes?.reason === 'already_running' && expoRes.port) {
      console.log(`[local] ui already running (pid=${expoRes.pid}, port=${expoRes.port})`);
      if (uiUrl) console.log(`[local] ui: open ${uiUrl}`);
    } else if (expoRes?.skipped === false && expoRes.port) {
      if (uiUrl) console.log(`[local] ui: open ${uiUrl}`);
    } else if (expoRes?.skipped && expoRes?.reason === 'already_running') {
      console.log('[local] ui already running (skipping Expo start)');
    }

    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const shouldOpen = isInteractive && !noBrowser && Boolean(expoRes?.port);
    if (shouldOpen) {
      // Prefer localhost for readiness checks (faster/more reliable), but open the stack-scoped hostname.
      await waitForHttpOk(`http://localhost:${expoRes.port}`, { timeoutMs: 30_000 }).catch(() => {});
      const res = await openUrlInBrowser(uiUrl);
      if (!res.ok) {
        console.warn(`[local] ui: failed to open browser automatically (${res.error}).`);
      }
    }
  }

  if (startMobile && expoRes?.port) {
    const metroUrl = await preferStackLocalhostUrl(`http://localhost:${expoRes.port}`, { stackName });
    console.log(`[local] mobile: metro ${metroUrl}`);
  }

  // Show Tailscale URL if forwarder is running
  if (expoRes?.tailscale?.ok && expoRes.tailscale.tailscaleIp && expoRes.port) {
    console.log(`[local] expo tailscale: http://${expoRes.tailscale.tailscaleIp}:${expoRes.port}`);
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\n[local] shutting down...');

    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }

    if (startDaemon) {
      await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir });
    }

    for (const child of children) {
      if (child.exitCode == null) {
        killProcessTree(child, 'SIGINT');
      }
    }

    await delay(1500);
    for (const child of children) {
      if (child.exitCode == null) {
        killProcessTree(child, 'SIGKILL');
      }
    }
  };

  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[local] failed:', err);
  process.exit(1);
});
