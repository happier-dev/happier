import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { killProcessTree, runCapture, spawnProc } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { killPortListeners } from './utils/net/ports.mjs';
import { getServerComponentName, isHappierServerRunning, waitForServerReady } from './utils/server/server.mjs';
import { ensureCliBuilt, ensureDepsInstalled, pmExecBin, pmSpawnScript, requireDir } from './utils/proc/pm.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { maybeResetTailscaleServe } from './tailscale.mjs';
import { isDaemonRunning, startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/server/validate.mjs';
import { resolveServerStartScript } from './utils/server/flavor_scripts.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from './utils/server/infra/happy_server_infra.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { getPublicServerUrlEnvOverride, resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import { preferStackLocalhostUrl } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { ensureDevExpoServer, resolveExpoTailscaleEnabled } from './utils/dev/expo_dev.mjs';
import { maybeRunInteractiveStackAuthSetup } from './utils/auth/interactive_stack_auth.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { daemonStartGate, formatDaemonAuthRequiredError } from './utils/auth/daemon_gate.mjs';
import { resolveServerUiEnv } from './utils/server/ui_env.mjs';
import { applyBindModeToEnv, resolveBindModeFromArgs } from './utils/net/bind_mode.mjs';
import { cmd, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { isSandboxed } from './utils/env/sandbox.mjs';

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

  const serverPort = resolveServerPortFromEnv({ defaultPort: 3005 });

  // Internal URL used by local processes on this machine.
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  // Public URL is what you might share/open (e.g. https://<machine>.<tailnet>.ts.net).
  // We auto-prefer the Tailscale HTTPS URL when available, unless explicitly overridden.
  const { defaultPublicUrl, envPublicUrl, publicServerUrl: publicServerUrlPreview } = getPublicServerUrlEnvOverride({ serverPort });
  let publicServerUrl = publicServerUrlPreview;

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

  const startDaemon = !flags.has('--no-daemon') && (process.env.HAPPIER_STACK_DAEMON ?? '1') !== '0';
  const serveUiWanted = !flags.has('--no-ui') && (process.env.HAPPIER_STACK_SERVE_UI ?? '1') !== '0';
  const serveUi = serveUiWanted;
  const startMobile = flags.has('--mobile') || flags.has('--with-mobile');
  const expoTailscale = flags.has('--expo-tailscale') || resolveExpoTailscaleEnabled({ env: process.env });
  const noBrowser = flags.has('--no-browser') || (process.env.HAPPIER_STACK_NO_BROWSER ?? '').toString().trim() === '1';
  const uiPrefix = process.env.HAPPIER_STACK_UI_PREFIX?.trim() ? process.env.HAPPIER_STACK_UI_PREFIX.trim() : '/';
  const autostart = getDefaultAutostartPaths();
  const uiBuildDir = process.env.HAPPIER_STACK_UI_BUILD_DIR?.trim()
    ? process.env.HAPPIER_STACK_UI_BUILD_DIR.trim()
    : join(autostart.baseDir, 'ui');

  const enableTailscaleServe = (process.env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') === '1';

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const cliDir = getComponentDir(rootDir, 'happier-cli');
  const uiDir = getComponentDir(rootDir, 'happier-ui');

  const cliBin = join(cliDir, 'bin', 'happier.mjs');

  const cliHomeDir = process.env.HAPPIER_STACK_CLI_HOME_DIR?.trim()
    ? process.env.HAPPIER_STACK_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(autostart.baseDir, 'cli');
  const restart = flags.has('--restart');

  if (json) {
    printResult({
      json,
      data: {
        mode: 'start',
        serverComponentName,
        serverDir,
        uiDir,
        cliDir,
        serverPort,
        internalServerUrl,
        publicServerUrl,
        startDaemon,
        serveUi,
        startMobile,
        uiPrefix,
        uiBuildDir,
        cliHomeDir,
      },
    });
    return;
  }

  const serverStartScript = resolveServerStartScript({ serverComponentName, serverDir });

  assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });
  assertServerPrismaProviderMatches({ serverComponentName, serverDir });

  await requireDir(serverComponentName, serverDir);
  await requireDir('happier-cli', cliDir);
  if (startMobile) {
    await requireDir('happier-ui', uiDir);
  }

  const uiBuildDirExists = await pathExists(uiBuildDir);
  if (serveUi && !uiBuildDirExists) {
    if (serverComponentName === 'happier-server-light') {
      throw new Error(
        `[local] UI build directory not found at ${uiBuildDir}. ` +
          `Run: ${cmd('hstack build')}`
      );
    }
    // For happier-server, UI serving is optional.
    console.log(`${yellow('!')} UI build directory not found at ${uiBuildDir}; UI serving will be disabled`);
  }

  const children = [];
  let shuttingDown = false;
  const baseEnv = { ...process.env };
  const stackCtx = resolveStackContext({ env: baseEnv, autostart });
  const { stackMode, runtimeStatePath, stackName, envPath, ephemeral } = stackCtx;

  // Ensure happier-cli is install+build ready before starting the daemon.
  const buildCli = (baseEnv.HAPPIER_STACK_CLI_BUILD ?? '1').toString().trim() !== '0';
  await ensureCliBuilt(cliDir, { buildCli });

  // Ensure server deps exist before any Prisma/docker work.
  await ensureDepsInstalled(serverDir, serverComponentName);
  if (startMobile) {
    await ensureDepsInstalled(uiDir, 'happier-ui');
  }

  // Public URL automation:
  // - Only the main stack should ever auto-enable Tailscale Serve by default.
  // - Non-main stacks default to localhost unless the user explicitly configured a public URL
  //   OR Tailscale Serve is already configured for this stack's internal URL (status matches).
  const allowEnableTailscale =
    !stackMode ||
    stackName === 'main' ||
    (baseEnv.HAPPIER_STACK_TAILSCALE_SERVE ?? '0').toString().trim() === '1';
  const resolvedUrls = await resolveServerUrls({ env: baseEnv, serverPort, allowEnable: allowEnableTailscale });
  if (stackMode && stackName !== 'main' && !resolvedUrls.envPublicUrl) {
    const src = String(resolvedUrls.publicServerUrlSource ?? '');
    const hasStackScopedTailscale = src.startsWith('tailscale-');
    publicServerUrl = hasStackScopedTailscale ? resolvedUrls.publicServerUrl : resolvedUrls.defaultPublicUrl;
  } else {
    publicServerUrl = resolvedUrls.publicServerUrl;
  }

  const serverAlreadyRunning = await isHappierServerRunning(internalServerUrl);
  const daemonAlreadyRunning = startDaemon ? isDaemonRunning(cliHomeDir) : false;
  if (!restart && serverAlreadyRunning && (!startDaemon || daemonAlreadyRunning)) {
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
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      script: 'run.mjs',
      ephemeral,
      ownerPid: process.pid,
      ports: { server: serverPort },
    }).catch(() => {});
  }

  // Server
  // If a previous run left a server behind, free the port first (prevents false "ready" checks).
  // NOTE: In stack mode we avoid killing arbitrary port listeners (fail-closed instead).
  if ((!serverAlreadyRunning || restart) && !stackMode) {
    await killPortListeners(serverPort, { label: 'server' });
  }

  const serverEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    // Used by server-light for generating public file URLs.
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    // You can override with METRICS_ENABLED=true if you want it.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
    ...resolveServerUiEnv({ serveUi, uiBuildDir, uiPrefix, uiBuildDirExists }),
  };
  let serverLightAccountCount = null;
  let happierServerAccountCount = null;
  if (serverComponentName === 'happier-server-light') {
    const dataDir = baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR?.trim()
      ? baseEnv.HAPPIER_SERVER_LIGHT_DATA_DIR.trim()
      : join(autostart.baseDir, 'server-light');
    serverEnv.HAPPIER_SERVER_LIGHT_DATA_DIR = dataDir;
    serverEnv.HAPPIER_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR?.trim()
      ? baseEnv.HAPPIER_SERVER_LIGHT_FILES_DIR.trim()
      : join(dataDir, 'files');
    serverEnv.HAPPIER_SERVER_LIGHT_DB_DIR = baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR?.trim()
      ? baseEnv.HAPPIER_SERVER_LIGHT_DB_DIR.trim()
      : join(dataDir, 'pglite');

    // Reliability: ensure DB schema exists before daemon hits /v1/machines (health checks don't cover DB readiness).
    // If the server is already running and we are not restarting, skip migrations/probes (pglite is single-connection).
    const acct = await getAccountCountForServerComponent({
      serverComponentName,
      serverDir,
      env: serverEnv,
      bestEffort: Boolean(serverAlreadyRunning && !restart),
    });
    serverLightAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
  }
  let effectiveInternalServerUrl = internalServerUrl;
  if (serverComponentName === 'happier-server') {
    const managed = (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0';
    if (managed) {
      const envPath = baseEnv.HAPPIER_STACK_ENV_FILE ?? '';
      const infra = await ensureHappyServerManagedInfra({
        stackName: autostart.stackName,
        baseDir: autostart.baseDir,
        serverPort,
        publicServerUrl,
        envPath,
        env: baseEnv,
      });

      // Backend runs on a separate port; gateway owns the public port.
      const backendPortRaw = (baseEnv.HAPPIER_STACK_SERVER_BACKEND_PORT ?? '').trim();
      const backendPort = backendPortRaw ? Number(backendPortRaw) : serverPort + 10;
      const backendUrl = `http://127.0.0.1:${backendPort}`;
      if (!stackMode) {
        await killPortListeners(backendPort, { label: 'happier-server-backend' });
      }

      const backendEnv = { ...serverEnv, ...infra.env, PORT: String(backendPort) };
      const autoMigrate = (baseEnv.HAPPIER_STACK_PRISMA_MIGRATE ?? '1') !== '0';
      if (autoMigrate) {
        await applyHappyServerMigrations({ serverDir, env: backendEnv });
      }
      // Account probe should use the *actual* DATABASE_URL/infra env (ephemeral stacks do not persist it in env files).
      const acct = await getAccountCountForServerComponent({
        serverComponentName,
        serverDir,
        env: backendEnv,
        bestEffort: true,
      });
      happierServerAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;

      const backend = await pmSpawnScript({ label: 'server', dir: serverDir, script: 'start', env: backendEnv });
      children.push(backend);
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeUpdate(runtimeStatePath, {
          ports: { server: serverPort, backend: backendPort },
          processes: { happierServerBackendPid: backend.pid },
        }).catch(() => {});
      }
      await waitForServerReady(backendUrl);

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
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeUpdate(runtimeStatePath, { processes: { uiGatewayPid: gateway.pid } }).catch(() => {});
      }
      await waitForServerReady(internalServerUrl);
      effectiveInternalServerUrl = internalServerUrl;

      // Skip default server spawn below
    }
  }

  // Default server start (happier-server-light, or happier-server without managed infra).
  if (!(serverComponentName === 'happier-server' && (baseEnv.HAPPIER_STACK_MANAGED_INFRA ?? '1') !== '0')) {
    if (!serverAlreadyRunning || restart) {
      const server = await pmSpawnScript({ label: 'server', dir: serverDir, script: serverStartScript, env: serverEnv });
      children.push(server);
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeUpdate(runtimeStatePath, { processes: { serverPid: server.pid } }).catch(() => {});
      }
      await waitForServerReady(internalServerUrl);
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
    console.log(sectionTitle('Terminal usage'));
    console.log(dim(`To run ${cyan('happier')} against this stack (and have sessions appear in the UI), export:`));
    console.log(cmd(`export HAPPIER_SERVER_URL="${effectiveInternalServerUrl}"`));
    console.log(cmd(`export HAPPIER_HOME_DIR="${cliHomeDir}"`));
    console.log(cmd(`export HAPPIER_WEBAPP_URL="${publicServerUrl}"`));

    // Auto-open UI (interactive only) using the stack-scoped hostname when applicable.
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (isInteractive && !noBrowser) {
      const prefix = uiPrefix.startsWith('/') ? uiPrefix : `/${uiPrefix}`;
      const openUrl = await preferStackLocalhostUrl(`http://localhost:${serverPort}${prefix}`, { stackName: autostart.stackName });
      const res = await openUrlInBrowser(openUrl);
      if (!res.ok) {
        console.warn(`[local] ui: failed to open browser automatically (${res.error}).`);
      }
    }
  }

  // Daemon
  if (startDaemon) {
    const gate = daemonStartGate({ env: baseEnv, cliHomeDir });
    if (!gate.ok) {
      const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      // In orchestrated auth flows, keep server/UI up and let the orchestrator start daemon post-auth.
      if (gate.reason === 'auth_flow_missing_credentials') {
        console.log('[local] auth flow: skipping daemon start until credentials exist');
      } else if (!isInteractive) {
        throw new Error(formatDaemonAuthRequiredError({ stackName: autostart.stackName, cliHomeDir }));
      }
    } else {
      const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (serverComponentName === 'happier-server' && happierServerAccountCount == null) {
        const acct = await getAccountCountForServerComponent({
          serverComponentName,
          serverDir,
          env: serverEnv,
          bestEffort: true,
        });
        happierServerAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
      }
      const accountCount =
        serverComponentName === 'happier-server-light' ? serverLightAccountCount : happierServerAccountCount;
      const autoSeedEnabled = resolveAutoCopyFromMainEnabled({ env: baseEnv, stackName: autostart.stackName, isInteractive });
      await maybeRunInteractiveStackAuthSetup({
        rootDir,
        env: baseEnv,
        stackName: autostart.stackName,
        cliHomeDir,
        accountCount,
        isInteractive,
        autoSeedEnabled,
      });
      await prepareDaemonAuthSeedIfNeeded({
      rootDir,
      env: baseEnv,
      stackName: autostart.stackName,
      cliHomeDir,
      startDaemon,
      isInteractive,
      accountCount,
      quiet: false,
    });
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: effectiveInternalServerUrl,
      publicServerUrl,
      isShuttingDown: () => shuttingDown,
      forceRestart: restart,
        env: baseEnv,
        stackName: autostart.stackName,
    });
    }
  }

  // Optional: start Expo dev-client Metro for mobile reviewers.
  if (startMobile) {
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

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\n[local] shutting down...');

    if (startDaemon) {
        await stopLocalDaemon({ cliBin, internalServerUrl: effectiveInternalServerUrl, cliHomeDir });
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

    await maybeResetTailscaleServe();
  };

  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  // Keep running
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[local] failed:', err);
  process.exit(1);
});
