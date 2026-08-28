import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve, sep } from 'node:path';

import { printResult } from './utils/cli/cli.mjs';
import { resolveCommandInvocation } from './utils/process/resolveCommandInvocation.mjs';
import { readEnvObjectFromFile } from './utils/env/read.mjs';
import { getComponentDir, getRepoDir, getRootDir, resolveStackBaseDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { resolveLocalhostHost } from './utils/paths/localhost_host.mjs';
import {
  getStackRuntimeStatePath,
  hasTrustedStackRuntimeLifecycle,
  readStackRuntimeStateFile,
  readStackServerLifecycle,
} from './utils/stack/runtime_state.mjs';
import { getEnvValueAny } from './utils/env/values.mjs';
import { padRight, parsePrefixedLabel, stripAnsi } from './utils/ui/text.mjs';
import { formatBoxLine } from './utils/ui/box_line.mjs';
import { commandExists } from './utils/proc/commands.mjs';
import { renderQrAscii } from './utils/ui/qr.mjs';
import { resolveMobileQrPayload } from './utils/mobile/dev_client_links.mjs';
import { worktreeSpecFromDir } from './utils/git/worktrees.mjs';
import { stopStackForTuiExit } from './utils/tui/cleanup.mjs';
import {
  extractTuiLaunchOptions,
  inferTuiStackName,
  isTuiHelpRequest,
  isTuiRestartableForwardedArgs,
  isTuiStartLikeForwardedArgs,
} from './utils/tui/args.mjs';
import {
  buildTuiBackgroundOwnerArgs,
  buildTuiChildArgs,
  buildTuiRestartChildArgs,
  extractTuiBackgroundOwnerRunnerLogPath,
  resolveTauriPaneSpawnConfig,
  shouldStartTauriPane,
  waitForTauriPaneExpoReady,
} from './utils/tui/tauri_mode.mjs';
import { killProcessGroupOwnedByStack } from './utils/proc/ownership.mjs';
import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { mergeEnvForTuiSummary } from './utils/tui/summary_env.mjs';
import {
  formatRuntimeExpoDevClientLines,
  formatRuntimePlacementSummaryLines,
  resolveRuntimeRemoteServiceObservation,
  shouldPresentRuntimeServiceEndpoint,
} from './utils/tui/runtime_placement_summary.mjs';
import { hasStackCredentials } from './utils/auth/daemon_gate.mjs';
import { applyTuiStackAuthScopeEnv } from './utils/tui/stack_scope_env.mjs';
import { buildDaemonAuthNotice, parseStartDaemonFlagFromEnv } from './utils/tui/daemon_auth_notice.mjs';
import { ensureTuiStdinMode, runWithTuiStdinHandoff } from './utils/tui/stdin_handoff.mjs';
import { waitForHappierHealthOk } from './utils/server/server.mjs';
import { buildTuiAuthArgs, buildTuiAuthExitNotice } from './utils/tui/actions.mjs';
import { reconcileDaemonPaneAfterDaemonStarts } from './utils/tui/daemon_pane_reconcile.mjs';
import { buildScriptPtyArgs } from './utils/tui/script_pty_command.mjs';
import { resolveTuiChildTerminationPlan } from './utils/tui/child_termination_plan.mjs';
import { installTuiStdinErrorGuard } from './utils/tui/stdin_error_guard.mjs';
import { enableTuiRescuePriority } from './utils/tui/rescue_priority.mjs';
import { resolveTuiChildEnv } from './utils/tui/resolve_child_env.mjs';
import {
  beginTuiRestartOperation,
  createTuiRuntimeOwnershipTracker,
  formatTuiForwardedChildExit,
  resolveTuiShutdownChildren,
} from './utils/tui/restart_operation.mjs';
import { checkDaemonStatePingAware } from './daemon.mjs';
import { getObservedStackDaemonAsync } from './utils/stack/runtime_daemon_state.mjs';
import { loadDevTargetsConfig, resolveDevTargetExecutionPolicy } from './utils/dev_targets/config.mjs';
import { resolveDevTargetServicePlans } from './utils/dev_targets/service_placement.mjs';
import {
  createDevTargetPaneSpecs,
  routeDevTargetLogPaneId,
  routeRemoteServiceLogPaneId,
} from './utils/tui/dev_target_panes.mjs';
import {
  createExecutionFabricSummaryReader,
  formatExecutionFabricSummaryLines,
} from './utils/tui/execution_fabric_summary.mjs';
import { inspectActiveRuntimeSnapshot } from './runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { resolveStackRuntimeMode } from './runtime/shared/runtime_mode.mjs';
import { buildBorrowedExpoUiUrl, isBorrowedExpoConsumer, resolveBorrowedExpoLogPath, resolveBorrowedExpoRuntime } from './runtime/shared/borrowed_expo.mjs';
import { followLogFile } from './utils/tui/follow_log_file.mjs';
import { resolveTuiRuntimeLogAttachments } from './utils/tui/runtime_log_attachments.mjs';
import { applyTuiExitPolicy, resolveTuiExitPolicy } from './utils/tui/exit_semantics.mjs';
import { formatTuiRuntimePublicationSummaryLines } from './utils/tui/runtime_publication_summary.mjs';

const tuiChildProcessInstances = new WeakMap();

function recordTuiChildProcessInstance(child) {
  const pid = Number(child?.pid);
  const processInstanceFingerprint = Number.isFinite(pid) && pid > 1
    ? readProcessInstanceFingerprintSync(pid)
    : null;
  if (child && typeof child === 'object') {
    tuiChildProcessInstances.set(child, processInstanceFingerprint);
  }
  return child;
}

async function terminateTuiChildProcessTree(child, { stackName, envPath, cliHomeDir }) {
  const plan = resolveTuiChildTerminationPlan({
    childPid: child?.pid,
    processInstanceFingerprint: tuiChildProcessInstances.get(child) ?? null,
  });
  if (plan.strategy === 'owned') {
    return await killProcessGroupOwnedByStack(plan.target, {
      stackName,
      envPath,
      cliHomeDir,
      label: 'TUI child',
      json: true,
      graceMs: 900,
      processInstanceFingerprint: plan.processInstanceFingerprint,
    });
  }
  return null;
}

function nowTs() {
  const d = new Date();
  return d.toISOString().slice(11, 19);
}

function supportsAnsi() {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  if ((process.env.TERM ?? '').toLowerCase() === 'dumb') return false;
  return true;
}

function cyan(s) {
  return supportsAnsi() ? `\x1b[36m${s}\x1b[0m` : String(s);
}

function redBold(s) {
  return supportsAnsi() ? `\x1b[1;31m${s}\x1b[0m` : String(s);
}

function yellowBold(s) {
  return supportsAnsi() ? `\x1b[1;33m${s}\x1b[0m` : String(s);
}

function greenBold(s) {
  return supportsAnsi() ? `\x1b[1;32m${s}\x1b[0m` : String(s);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function styleDaemonNoticeLines(lines) {
  const raw = Array.isArray(lines) ? lines : [];
  return raw.map((line) => {
    const s = String(line ?? '');
    if (s.toLowerCase().includes('sign-in required')) return yellowBold(s);
    if (s.startsWith('Without daemon sign-in')) return yellowBold(s);
    if (s.startsWith('press "a"')) return greenBold(s);
    if (s.startsWith('action: press "a"')) return greenBold(s);
    return s;
  });
}

function mkPane(id, title, { visible = true, kind = 'log' } = {}) {
  return { id, title, kind, visible, lines: [], scroll: 0 };
}

function pushLine(pane, line, { maxLines = 4000 } = {}) {
  pane.lines.push(line);
  if (pane.lines.length > maxLines) {
    pane.lines.splice(0, pane.lines.length - maxLines);
  }
}

function getPaneHeightForLines(lines, { min = 3, max = 16 } = {}) {
  const n = Array.isArray(lines) ? lines.length : 0;
  // +2 for box borders
  return clamp(n + 2, min, max);
}

function drawBox({ x, y, w, h, title, lines, scroll, active = false, allowAnsi = false }) {
  const top = y;
  const bottom = y + h - 1;
  const left = x;
  const horiz = '─'.repeat(Math.max(0, w - 2));
  const t = title ? ` ${title} ` : '';
  const titleStart = Math.max(1, Math.min(w - 2 - t.length, 2));
  const topLine =
    '┌' +
    horiz
      .split('')
      .map((ch, i) => {
        const pos = i + 1;
        if (t && pos >= titleStart && pos < titleStart + t.length) {
          return t[pos - titleStart];
        }
        return ch;
      })
      .join('') +
    '┐';

  const midLine = '│' + ' '.repeat(Math.max(0, w - 2)) + '│';
  const botLine = '└' + horiz + '┘';

  const style = (s) => (active ? cyan(s) : s);

  const out = [];
  out.push({ row: top, col: left, text: style(topLine) });
  for (let r = top + 1; r < bottom; r++) {
    out.push({ row: r, col: left, text: style(midLine) });
  }
  out.push({ row: bottom, col: left, text: style(botLine) });

  const innerW = Math.max(0, w - 2);
  const innerH = Math.max(0, h - 2);
  const maxScroll = Math.max(0, lines.length - innerH);
  const s = clamp(scroll, 0, maxScroll);
  const start = Math.max(0, lines.length - innerH - s);
  const slice = lines.slice(start, start + innerH);
  for (let i = 0; i < innerH; i++) {
    const raw = slice[i] ?? '';
    const formatted = formatBoxLine({
      text: raw,
      width: innerW,
      allowAnsi: Boolean(allowAnsi && supportsAnsi()),
    });
    out.push({ row: top + 1 + i, col: left + 1, text: formatted });
  }

  return { out, maxScroll };
}

function resolveStacklessSummaryEnv({ rootDir }) {
  const invokedCwd = getInvokedCwd(process.env);
  const inferred = inferComponentFromCwd({
    rootDir,
    invokedCwd,
    components: ['happier-ui', 'happier-cli', 'happier-server-light', 'happier-server'],
  });
  if (!inferred?.repoDir) {
    return { env: process.env, invokedCwd };
  }
  return {
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: inferred.repoDir },
    invokedCwd,
  };
}

const readEnvObject = readEnvObjectFromFile;

async function preflightCorepackYarnForStack({ envPath }) {
  // Corepack caches (and therefore "download yarn?" prompts) are tied to XDG/HOME.
  // In stack mode we isolate HOME/XDG caches per stack, which can cause Corepack to prompt
  // the first time a stack runs Yarn.
  //
  // In `hstack tui`, the child runs under a pseudo-TTY (via `script`) and the TUI consumes
  // all keyboard input, so Corepack's interactive prompt deadlocks.
  //
  // Fix: pre-download Yarn in a *non-tty* subprocess using the stack's isolated HOME/XDG,
  // so later pty runs don't prompt.
  if (!envPath) return;
  const baseDir = resolve(join(envPath, '..'));
  const stackHome = join(baseDir, 'home');
  const cacheBase = join(baseDir, 'cache');
  const env = {
    ...process.env,
    HOME: stackHome,
    USERPROFILE: stackHome,
    XDG_CACHE_HOME: join(cacheBase, 'xdg'),
    YARN_CACHE_FOLDER: join(cacheBase, 'yarn'),
    npm_config_cache: join(cacheBase, 'npm'),
    // Avoid Corepack mutating package.json automatically.
    COREPACK_ENABLE_AUTO_PIN: '0',
    // Best-effort: disable download prompts (may not be honored by all Corepack versions).
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    // Treat this as non-interactive (helps some tooling).
    CI: process.env.CI ?? '1',
  };

  await mkdir(stackHome, { recursive: true }).catch(() => {});
  await mkdir(env.XDG_CACHE_HOME, { recursive: true }).catch(() => {});
  await mkdir(env.YARN_CACHE_FOLDER, { recursive: true }).catch(() => {});
  await mkdir(env.npm_config_cache, { recursive: true }).catch(() => {});
  await mkdir(env.COREPACK_HOME, { recursive: true }).catch(() => {});

  await new Promise((resolvePromise) => {
    const invocation = resolveCommandInvocation({ command: 'yarn', args: ['--version'], env });
    const proc = spawn(invocation.command, invocation.args, {
      env,
      cwd: baseDir,
      // Non-tty stdio: Corepack typically won't prompt; if it does, we still provide "y\n".
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false,
      ...(process.platform === 'win32'
        ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : null),
    });
    try {
      proc.stdin?.write('y\n');
      proc.stdin?.end();
    } catch {
      // ignore
    }

    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolvePromise();
    }, 60_000);

    proc.on('exit', () => {
      clearTimeout(t);
      resolvePromise();
    });
    proc.on('error', () => {
      clearTimeout(t);
      resolvePromise();
    });
  });
}

function getEnvVal(env, key) {
  return getEnvValueAny(env, [key]) || '';
}

function nextLineBreakIndex(s) {
  const n = s.indexOf('\n');
  const r = s.indexOf('\r');
  if (n < 0) return r;
  if (r < 0) return n;
  return Math.min(n, r);
}

function consumeLineBreak(buf) {
  if (buf.startsWith('\r\n')) return buf.slice(2);
  if (buf.startsWith('\n') || buf.startsWith('\r')) return buf.slice(1);
  return buf;
}

function formatRepoRef({ rootDir, dir }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return '(unset)';

  const abs = resolve(raw);
  const defaultDir = resolve(getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' }));
  if (abs === defaultDir) return 'main';

  const spec = worktreeSpecFromDir({ rootDir, component: 'happier-ui', dir: abs, env: process.env });
  if (spec) return spec;
  return abs;
}

async function buildStackSummaryLines({ rootDir, stackName }) {
  if (!stackName) {
    const { env, invokedCwd } = resolveStacklessSummaryEnv({ rootDir });
    const serverComponent =
      getEnvValueAny(env, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';

    const lines = [];
    lines.push('stack: (stackless)');
    lines.push(`server: ${serverComponent}`);
    lines.push(`invokedCwd: ${invokedCwd}`);
    lines.push('runtime: (stackless)');

    lines.push('');
    lines.push('ports:');
    lines.push('  server: (stackless)');

    lines.push('');
    lines.push('pids:');

    lines.push('');
    lines.push('dirs:');
    const repoRoot = getRepoDir(rootDir, env);
    lines.push(`  ${padRight('repo', 16)} ${formatRepoRef({ rootDir, dir: repoRoot })}`);
    const uiDir = getComponentDir(rootDir, 'happier-ui', env);
    const cliDir = getComponentDir(rootDir, 'happier-cli', env);
    const serverDir = getComponentDir(rootDir, serverComponent, env);
    const relOrAbs = (absPath) => {
      const p = resolve(String(absPath ?? '').trim());
      const repo = resolve(String(repoRoot ?? '').trim());
      if (!repo) return p;
      const prefix = repo.endsWith(sep) ? repo : repo + sep;
      return p === repo ? '.' : p.startsWith(prefix) ? p.slice(prefix.length) : p;
    };
    lines.push(`  ${padRight('ui', 16)} ${relOrAbs(uiDir)}`);
    lines.push(`  ${padRight('cli', 16)} ${relOrAbs(cliDir)}`);
    lines.push(`  ${padRight('server', 16)} ${relOrAbs(serverDir)}`);

    return lines;
  }

  const { envPath, baseDir } = resolveStackEnvPath(stackName);
  const envFromFile = await readEnvObject(envPath);
  const env = mergeEnvForTuiSummary({ stackEnvFromFile: envFromFile, processEnv: process.env });
  const authScopeEnv = applyTuiStackAuthScopeEnv({ env, stackName });
  const runtimePath = getStackRuntimeStatePath(stackName);
  const runtime = await readStackRuntimeStateFile(runtimePath);
  const runtimeInspection = await inspectActiveRuntimeSnapshot({ stackBaseDir: baseDir, env });
  const selectedSnapshotId = runtimeInspection.activeSnapshotId;
  const runtimeLifecycleLive = await hasTrustedStackRuntimeLifecycle(runtime, {
    stackName,
    envPath,
    cliHomeDir: join(baseDir, 'cli'),
  }, {
    throwOnInconclusive: false,
  });
  const loadedSnapshotId = runtimeLifecycleLive
    ? String(runtime?.runtimeSnapshotId ?? '').trim() || null
    : null;
  const runtimeMode = resolveStackRuntimeMode({ argv: [], env }).mode;

  const serverComponent =
    getEnvValueAny(env, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';

  const ports = runtime?.ports && typeof runtime.ports === 'object' ? runtime.ports : {};
  const expo = runtime?.expo && typeof runtime.expo === 'object' ? runtime.expo : {};
  const expoPort = expo?.port ?? expo?.webPort ?? expo?.mobilePort ?? null;
  const expoDevClientEnabled = Boolean(expo?.devClientEnabled);
  const borrowedExpoProducerStackName = getEnvValueAny(env, ['HAPPIER_STACK_EXPO_SOURCE_STACK']);
  const borrowedExpo = isBorrowedExpoConsumer({
    consumerStackName: stackName,
    producerStackName: borrowedExpoProducerStackName,
  })
    ? await resolveBorrowedExpoRuntime({
        rootDir,
        producerStackName: borrowedExpoProducerStackName,
        env,
      }).catch(() => null)
    : null;
  const presentedExpoPort = borrowedExpo?.running ? borrowedExpo.port : expoPort;
  const presentedExpoDevClientEnabled = borrowedExpo
    ? borrowedExpo.devClientEnabled
    : expoDevClientEnabled;
  const processes = runtime?.processes && typeof runtime.processes === 'object' ? runtime.processes : {};
  const serverLifecycle = readStackServerLifecycle(runtime);

  const serverPort = Number(ports?.server);
  const internalServerUrl =
    Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '';
  const cliHomeDir = join(baseDir, 'cli');
  const authed = internalServerUrl
    ? hasStackCredentials({ cliHomeDir, serverUrl: internalServerUrl, env: authScopeEnv })
    : hasStackCredentials({ cliHomeDir, serverUrl: '', env: authScopeEnv });
  const remoteDaemon = resolveRuntimeRemoteServiceObservation(runtime, 'daemon');
  const startDaemon = parseStartDaemonFlagFromEnv(env) && !remoteDaemon.target;
  const observedDaemon = await getObservedStackDaemonAsync({
    cliHomeDir,
    internalServerUrl,
    runtimeDaemonPid: processes?.daemonPid ?? null,
    runtimeDaemonPids: processes?.daemonPids ?? [],
    env: authScopeEnv,
  }, {
    checkDaemonStateImpl: checkDaemonStatePingAware,
  });

  const lines = [];
  lines.push(`stack: ${stackName}`);
  lines.push(`server: ${serverComponent}`);
  lines.push(`baseDir: ${baseDir}`);
  lines.push(`env: ${envPath}`);
  lines.push(`runtime: ${runtimePath}${runtime ? '' : ' (missing)'}`);
  lines.push(`runtimeMode: ${runtimeMode}`);
  if (selectedSnapshotId) {
    lines.push(`selectedSnapshot: ${selectedSnapshotId}${runtimeInspection.producerStackName ? ` (${runtimeInspection.producerStackName})` : ''}`);
  }
  if (loadedSnapshotId) lines.push(`loadedSnapshot: ${loadedSnapshotId}`);
  if (runtimeLifecycleLive && selectedSnapshotId && selectedSnapshotId !== loadedSnapshotId) {
    lines.push('runtimeUpdate: pending manual restart');
  }
  if (borrowedExpo) {
    lines.push(
      `expoProvider: borrowed from ${borrowedExpo.producerStackName} `
        + `(${borrowedExpo.status}${borrowedExpo.remoteTarget ? ` via ${borrowedExpo.remoteTarget}` : ''})`,
    );
  }
  if (runtime?.startedAt) lines.push(`startedAt: ${runtime.startedAt}`);
  if (runtime?.updatedAt) lines.push(`updatedAt: ${runtime.updatedAt}`);
  if (runtime?.ownerPid) lines.push(`ownerPid: ${runtime.ownerPid}`);
  const runtimePublicationLines = formatTuiRuntimePublicationSummaryLines(runtime);
  if (runtimePublicationLines.length > 0) {
    lines.push('');
    lines.push(...runtimePublicationLines);
  }

  // Make daemon auth issues obvious even if the user never focuses the daemon pane.
  const notice = buildDaemonAuthNotice({
    stackName,
    internalServerUrl,
    daemonPid: observedDaemon.pid,
    daemonRunning: observedDaemon.running,
    authed,
    startDaemon,
  });
  if (notice.show) {
    lines.push('');
    for (const l of styleDaemonNoticeLines(notice.summaryLines)) lines.push(l);
  }

  const placementLines = formatRuntimePlacementSummaryLines(runtime);
  if (placementLines.length > 0) {
    lines.push('');
    lines.push(...placementLines);
  }

  lines.push('');
  lines.push('ports:');
  lines.push(`  server: ${ports?.server ?? '(unknown)'}`);
  if (ports?.serverBackend) lines.push(`  serverBackend: ${ports.serverBackend}`);
  if (presentedExpoPort) lines.push(`  expo: ${presentedExpoPort}${borrowedExpo ? ' (borrowed)' : ''}`);
  if (ports?.backend) lines.push(`  backend: ${ports.backend}`);

  if (runtime?.serverProxy) {
    lines.push('');
    lines.push('server proxy:');
    lines.push(`  mode: ${runtime.serverProxy.mode ?? '(unknown)'}`);
    if (runtime.serverProxy.restartMode) lines.push(`  restartMode: ${runtime.serverProxy.restartMode}`);
    if (runtime.serverProxy.fallbackReason) lines.push(`  fallbackReason: ${runtime.serverProxy.fallbackReason}`);
  }

  if (serverLifecycle) {
    lines.push('');
    lines.push('server refresh:');
    lines.push(`  phase: ${serverLifecycle.phase}`);
    if (serverLifecycle.planned) {
      lines.push(
        `  planned: ${serverLifecycle.planned.mode} generation=${serverLifecycle.planned.generation} ` +
          `reason=${serverLifecycle.planned.reason}`,
      );
    }
    if (serverLifecycle.lastCompleted) {
      lines.push(
        `  lastCompleted: ${serverLifecycle.lastCompleted.mode} ` +
          `generation=${serverLifecycle.lastCompleted.generation}`,
      );
    }
    if (serverLifecycle.retry) lines.push(`  retryAfterMs: ${serverLifecycle.retry.afterMs}`);
    if (serverLifecycle.disposition) lines.push(`  disposition: ${serverLifecycle.disposition.code}`);
    if (serverLifecycle.phase === 'blocked') {
      lines.push('  running service: unchanged by failed refresh');
    }
  }

  if (presentedExpoPort && presentedExpoDevClientEnabled) {
    const payload = resolveMobileQrPayload({ env: process.env, port: Number(presentedExpoPort) });
    const borrowedWebUrl = borrowedExpo
      ? buildBorrowedExpoUiUrl({
          consumerHost: resolveLocalhostHost({ stackMode: true, stackName }),
          expoPort: presentedExpoPort,
          serverPort,
        })
      : null;
    lines.push('');
    lines.push(...(borrowedExpo
      ? [
          'expo dev-client links (borrowed):',
          ...(borrowedWebUrl ? [`  web:   ${borrowedWebUrl}`] : []),
          ...(payload?.metroUrl ? [`  metro: ${payload.metroUrl}`] : []),
          ...(payload?.scheme && payload?.deepLink ? [`  link:  ${payload.deepLink}`] : []),
        ]
      : formatRuntimeExpoDevClientLines(runtime, payload)));
  }

  lines.push('');
  lines.push('pids:');
  if (processes?.serverPid) lines.push(`  serverPid: ${processes.serverPid}`);
  if (processes?.serverBackendPid) lines.push(`  serverBackendPid: ${processes.serverBackendPid}`);
  if (processes?.expoPid) lines.push(`  expoPid: ${processes.expoPid}`);
  if (observedDaemon.pid) lines.push(`  daemonPid: ${observedDaemon.pid}`);
  if (processes?.uiGatewayPid) lines.push(`  uiGatewayPid: ${processes.uiGatewayPid}`);

  lines.push('');
  lines.push('dirs:');
  const repoRoot = getRepoDir(rootDir, env);
  lines.push(`  ${padRight('repo', 16)} ${formatRepoRef({ rootDir, dir: repoRoot })}`);
  // Service subdirs (best-effort; shown relative to repo when possible).
  const uiDir = getComponentDir(rootDir, 'happier-ui', env);
  const cliDir = getComponentDir(rootDir, 'happier-cli', env);
  const serverDir = getComponentDir(rootDir, serverComponent, env);
  const relOrAbs = (absPath) => {
    const p = resolve(String(absPath ?? '').trim());
    const repo = resolve(String(repoRoot ?? '').trim());
    if (!repo) return p;
    const prefix = repo.endsWith(sep) ? repo : repo + sep;
    return p === repo ? '.' : p.startsWith(prefix) ? p.slice(prefix.length) : p;
  };
  lines.push(`  ${padRight('ui', 16)} ${relOrAbs(uiDir)}`);
  lines.push(`  ${padRight('cli', 16)} ${relOrAbs(cliDir)}`);
  lines.push(`  ${padRight('server', 16)} ${relOrAbs(serverDir)}`);

  return lines;
}

async function buildExpoQrPaneLines({ rootDir, stackName }) {
  if (!stackName) {
    return { visible: false, lines: [] };
  }
  const { envPath } = resolveStackEnvPath(stackName);
  const stackEnvFromFile = await readEnvObject(envPath);
  const env = mergeEnvForTuiSummary({ stackEnvFromFile, processEnv: process.env });
  const producerStackName = getEnvValueAny(env, ['HAPPIER_STACK_EXPO_SOURCE_STACK']);
  const borrowedExpo = isBorrowedExpoConsumer({
    consumerStackName: stackName,
    producerStackName,
  })
    ? await resolveBorrowedExpoRuntime({ rootDir, producerStackName, env }).catch(() => null)
    : null;
  const runtimePath = getStackRuntimeStatePath(stackName);
  const runtime = await readStackRuntimeStateFile(runtimePath);
  const expo = runtime?.expo && typeof runtime.expo === 'object' ? runtime.expo : {};
  const port = Number(borrowedExpo?.mobilePort ?? expo?.port ?? expo?.mobilePort ?? expo?.webPort);
  const enabled = borrowedExpo ? borrowedExpo.running && borrowedExpo.devClientEnabled : Boolean(expo?.devClientEnabled);
  if (!enabled || !Number.isFinite(port) || port <= 0) {
    return { visible: false, lines: [] };
  }
  if (!borrowedExpo && !shouldPresentRuntimeServiceEndpoint(runtime, 'expo')) {
    return { visible: false, lines: [] };
  }

  const payload = resolveMobileQrPayload({ env: process.env, port });
  // Try to keep the QR compact:
  // - qrcode-terminal uses a terminal-friendly pattern with adequate quiet-zone.
  const qr = await renderQrAscii(payload.payload, { small: true });
  const lines = [];
  if (qr.ok) {
    lines.push(...qr.lines);
  } else {
    lines.push(`(QR unavailable) ${qr.error || ''}`.trim());
  }
  return { visible: true, lines };
}

async function main() {
  const argvRaw = process.argv.slice(2);
  const { forwardedArgs: rawForwardedArgs, rescue, withTauri } = extractTuiLaunchOptions(argvRaw);
  const forwarded = rawForwardedArgs;

  if (isTuiHelpRequest(argvRaw)) {
    printResult({
      json: false,
      data: { usage: 'hstack tui [<hstack args...>]', json: false, defaultCommand: 'dev' },
      text: [
        '[tui] usage:',
        '  hstack tui [<hstack args...>] [--tauri] [--rescue]',
        '',
        'defaults:',
        '  hstack tui                 => hstack tui dev --mobile',
        '  hstack tui --tauri         => hstack tui dev with a Tauri pane',
        '  hstack tui --tauri --mobile => hstack tui dev --mobile with a Tauri pane',
        '  hstack tui --rescue          => prioritize stack controls during severe system load',
        '  hstack tui --no-mobile     => hstack tui dev --no-mobile (web only)',
        '',
        'examples:',
        '  hstack tui stack dev resume-upstream',
        '  hstack tui stack start resume-upstream',
        '  hstack tui stack auth dev-auth login',
        '',
        'layouts:',
        '  single  : one pane (focused)',
        '  split   : two panes (left=orchestration, right=focused)',
        '  columns : multiple panes stacked in two columns (toggle visibility per pane)',
        '',
        'keys:',
        '  tab / shift+tab : focus next/prev (visible panes only)',
        '  1..9            : jump to pane index',
        '  v               : cycle layout (single → split → columns)',
        '  m               : toggle focused pane visibility (columns layout)',
        '  c               : clear focused pane',
        '  p               : pause/resume rendering',
        '  ↑/↓, PgUp/PgDn   : scroll focused pane',
        '  Home/End        : jump bottom/top (focused pane)',
        '  a               : run stack auth login (when stack context exists)',
        '  A               : run stack auth login --force',
        '  r               : restart stack processes (dev/start only)',
        '  q / Ctrl+C      : quit (stops a runtime owner admitted by this TUI)',
        '',
        'panes (default):',
        '  orchestration | summary | execution fabric | local | server | expo | daemon | stack logs',
      ].join('\n'),
    });
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('[tui] requires a TTY (interactive terminal)');
  }

  if (rescue) {
    console.error('[tui] rescue mode: requesting elevated scheduling priority for stack controls...');
    const applied = await enableTuiRescuePriority();
    console.error(`[tui] rescue mode enabled (control nice=${applied.nice}); agent sessions remain at normal/background priority.`);
  }

  const rootDir = getRootDir(import.meta.url);
  const happysBin = join(rootDir, 'bin', 'hstack.mjs');
  const stackName = inferTuiStackName(forwarded, process.env);
  const childForwarded = buildTuiBackgroundOwnerArgs({
    childArgs: buildTuiChildArgs({ forwardedArgs: forwarded, withTauri }),
    stackName,
  });
  const detachedBackgroundOwner = childForwarded.includes('--background') || childForwarded.includes('--bg');
  const stackEnvPath = stackName ? resolveStackEnvPath(stackName).envPath : null;
  const stackCliHomeDir = stackName ? join(resolveStackEnvPath(stackName).baseDir, 'cli') : '';
  const summaryTitle = stackName ? `stack summary (${stackName})` : 'session summary (stackless)';
  let configuredDevTargetPlans = [];
  let configuredDevTargets = [];
  if (stackName && !forwarded.includes('--no-dev-targets')) {
    const { config } = await loadDevTargetsConfig({ stackName, env: process.env, allowMissing: true });
    const configuredPlans = resolveDevTargetServicePlans({
      targets: config.targets,
      policy: resolveDevTargetExecutionPolicy(config),
      requested: { server: true, expo: true, daemon: true },
    });
    configuredDevTargetPlans = configuredPlans.targets;
    configuredDevTargets = configuredPlans.targets.map((plan) => plan.target);
  }

  const panes = [
    mkPane('orch', 'orchestration', { visible: true, kind: 'log' }),
    mkPane('summary', summaryTitle, { visible: true, kind: 'summary' }),
    mkPane('tauri', 'tauri', { visible: withTauri, kind: 'log' }),
    // Data-only pane: we render QR inside the Expo pane (no separate box).
    mkPane('qr', 'expo QR', { visible: false, kind: 'qr' }),
    mkPane('local', 'local', { visible: true, kind: 'log' }),
    mkPane('server', 'server', { visible: false, kind: 'log' }),
    mkPane('expo', 'expo', { visible: false, kind: 'log' }),
    mkPane('daemon', 'daemon', { visible: false, kind: 'log' }),
    mkPane('stacklog', 'stack logs', { visible: false, kind: 'log' }),
    ...createDevTargetPaneSpecs(configuredDevTargets).map((spec) =>
      mkPane(spec.id, spec.title, { visible: spec.visible, kind: spec.kind }),
    ),
  ];

  const paneIndexById = new Map(panes.map((p, i) => [p.id, i]));
  const configuredDevTargetNames = new Set(configuredDevTargets.map((target) => target.name));

  const routeLine = (line) => {
    const label = parsePrefixedLabel(line);
    const normalized = label ? label.toLowerCase() : '';

    let paneId =
      routeRemoteServiceLogPaneId(line, configuredDevTargetPlans)
      ?? routeDevTargetLogPaneId(normalized, configuredDevTargetNames)
      ?? 'local';
    if (paneId !== 'local') {
      // Already routed by the dev-target lifecycle owner.
    } else if (normalized.includes('server')) paneId = 'server';
    else if (normalized === 'ui') paneId = 'expo';
    else if (normalized === 'mobile') paneId = 'expo';
    else if (normalized === 'expo') paneId = 'expo';
    else if (normalized.includes('daemon')) paneId = 'daemon';
    else if (normalized === 'stack') paneId = 'stacklog';
    else if (normalized === 'local') paneId = 'local';

    const idx = paneIndexById.get(paneId) ?? paneIndexById.get('local');
    if (panes[idx] && !panes[idx].visible && panes[idx].kind === 'log') {
      panes[idx].visible = true;
      // If the focused pane was hidden before, keep focus stable but ensure render updates layout.
    }
    pushLine(panes[idx], line);
  };

  const logOrch = (msg) => {
    pushLine(panes[paneIndexById.get('orch')], `[${nowTs()}] ${msg}`);
  };

  // Prevent rare TTY `read EIO` crashes during restart/shutdown transitions.
  // Without an 'error' listener, Node treats stdin errors as unhandled and aborts the TUI.
  installTuiStdinErrorGuard({
    stdin: process.stdin,
    onError: (err) => {
      const code = err && typeof err === 'object' ? String(err.code ?? '') : '';
      logOrch(`stdin error ignored${code ? ` (${code})` : ''}`);
    },
  });

  // Preflight Yarn/Corepack for this stack before spawning the pty child.
  // This prevents Corepack "download yarn? [Y/n]" prompts from deadlocking the TUI.
  await preflightCorepackYarnForStack({ envPath: stackEnvPath });

  let layout = 'columns'; // single | split | columns
  let focused = paneIndexById.get('local'); // default focus
  let paused = false;
  let renderScheduled = false;
  let sawDaemonAuthRequired = false;
  let restartOperation = null;
  let observedRuntimeOwner = null;
  let tauriLaunchState = { cancelled: false };
  const runtimeOwnerBeforeSpawn = stackName
    ? await readStackRuntimeStateFile(getStackRuntimeStatePath(stackName)).catch(() => null)
    : null;
  const runtimeOwnershipTracker = createTuiRuntimeOwnershipTracker({
    runtimeOwnerBeforeSpawn,
  });

  const wantsPty = process.platform !== 'win32' && (await commandExists('script', { cwd: rootDir }));
  // In TUI mode, we intentionally do not forward keyboard input to the child process (stdin is ignored),
  // so any interactive prompts inside the child would deadlock.
  // Mark the child env so dependency installers can auto-approve safe prompts (Corepack yarn downloads).
  const stackEnvFromFile = stackEnvPath ? await readEnvObject(stackEnvPath) : {};
  const childEnv = resolveTuiChildEnv({
    stackEnvFromFile,
    processEnv: {
      ...process.env,
      ...(rescue ? { HAPPIER_STACK_RESCUE: '1' } : {}),
    },
  });
  const executionFabricSummaryReader = stackName && configuredDevTargets.length > 0
    ? createExecutionFabricSummaryReader({
        stackBaseDir: resolveStackBaseDir(stackName, childEnv).baseDir,
        targetNames: configuredDevTargets.map((target) => target.name),
      })
    : null;
  const borrowedExpoProducerStackName = String(childEnv.HAPPIER_STACK_EXPO_SOURCE_STACK ?? '').trim();
  let borrowedExpoLogFollower = null;
  let borrowedExpoLogPath = '';
  const runtimeLogFollowers = new Map();
  const refreshRuntimeLogFollowers = (runtimeState) => {
    if (!stackName) return;
    const { baseDir } = resolveStackBaseDir(stackName, childEnv);
    const attachments = resolveTuiRuntimeLogAttachments({
      stackBaseDir: baseDir,
      runtimeState,
      remoteTargetNames: configuredDevTargets,
    });
    const attachmentIds = new Set(attachments.map((attachment) => attachment.id));
    for (const [id, current] of runtimeLogFollowers) {
      if (!attachmentIds.has(id) || attachments.find((attachment) => attachment.id === id)?.path !== current.path) {
        current.follower.close();
        runtimeLogFollowers.delete(id);
      }
    }
    for (const attachment of attachments) {
      if (runtimeLogFollowers.has(attachment.id)) continue;
      const follower = followLogFile({
        path: attachment.path,
        onLine: (line) => {
          routeLine(attachment.id === 'runner' ? `[stack] ${line}` : line);
          scheduleRender();
        },
      });
      runtimeLogFollowers.set(attachment.id, { path: attachment.path, follower });
    }
  };
  const closeRuntimeLogFollowers = () => {
    for (const { follower } of runtimeLogFollowers.values()) follower.close();
    runtimeLogFollowers.clear();
  };
  const refreshBorrowedExpoLogFollower = async () => {
    if (!isBorrowedExpoConsumer({
      consumerStackName: stackName,
      producerStackName: borrowedExpoProducerStackName,
    })) return;
    const borrowedExpo = await resolveBorrowedExpoRuntime({
      rootDir,
      producerStackName: borrowedExpoProducerStackName,
      env: childEnv,
    }).catch(() => null);
    const { baseDir: producerStackBaseDir } = resolveStackBaseDir(borrowedExpoProducerStackName, childEnv);
    const nextLogPath = resolveBorrowedExpoLogPath({
      producerStackBaseDir,
      remoteTarget: borrowedExpo?.remoteTarget ?? null,
    });
    if (!nextLogPath || nextLogPath === borrowedExpoLogPath) return;

    borrowedExpoLogFollower?.close();
    borrowedExpoLogPath = nextLogPath;
    const expoPane = panes[paneIndexById.get('expo')];
    expoPane.visible = true;
    expoPane.title = `expo (borrowed: ${borrowedExpoProducerStackName})`;
    pushLine(expoPane, `[expo] borrowing logs from ${nextLogPath}`);
    borrowedExpoLogFollower = followLogFile({
      path: nextLogPath,
      onLine: (line) => {
        routeLine(`[expo] [borrowed:${borrowedExpoProducerStackName}] ${line}`);
        scheduleRender();
      },
    });
  };
  await refreshBorrowedExpoLogFollower();
  let child = null;

  const spawnForwardedChild = (forwardedArgs = childForwarded) => {
    const pty = wantsPty
      ? buildScriptPtyArgs({
          platform: process.platform,
          file: '/dev/null',
          command: [process.execPath, happysBin, ...forwardedArgs],
        })
      : null;
    const proc = wantsPty
      ? // Use a pseudo-terminal so tools like Expo print QR/status output that they hide in non-TTY mode.
        // `script` is available by default on macOS (and common on Linux).
        spawn(pty.cmd, pty.args, {
          cwd: rootDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        })
      : spawn(process.execPath, [happysBin, ...forwardedArgs], {
          cwd: rootDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });

    logOrch(
      `spawned: ${wantsPty ? `${pty.cmd} ${pty.args.join(' ')} ` : ''}node ${happysBin} ${forwardedArgs.join(' ')} (pid=${proc.pid})`
    );

    const buf = { out: '', err: '' };
    const flush = (kind) => {
      const key = kind === 'stderr' ? 'err' : 'out';
      let b = buf[key];
      while (true) {
        const idx = nextLineBreakIndex(b);
        if (idx < 0) break;
        const line = b.slice(0, idx);
        b = consumeLineBreak(b.slice(idx));
        if (detachedBackgroundOwner) {
          const runnerLogPath = extractTuiBackgroundOwnerRunnerLogPath({
            line: stripAnsi(line),
            stackName,
          });
          if (runnerLogPath) runtimeOwnershipTracker.recordDetachedRunnerLogPath(runnerLogPath);
        }
        routeLine(line);
      }
      buf[key] = b;
    };

    proc.stdout?.on('data', (d) => {
      buf.out += d.toString();
      flush('stdout');
      scheduleRender();
    });
    proc.stderr?.on('data', (d) => {
      buf.err += d.toString();
      flush('stderr');
      scheduleRender();
    });
    proc.on('exit', (code, sig) => {
      logOrch(formatTuiForwardedChildExit({
        code,
        signal: sig,
        detachedBackgroundOwner,
      }));
      scheduleRender();
    });
    proc.on('error', (error) => {
      logOrch(`child error: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRender();
    });

    return recordTuiChildProcessInstance(proc);
  };

  const cancelPendingTauriLaunch = () => {
    tauriLaunchState.cancelled = true;
    tauriLaunchState = { cancelled: false };
  };

  const spawnTauriProcess = ({ expoPort = null, skipExpoWait = false } = {}) => {
    if (!withTauri || !shouldStartTauriPane(rawForwardedArgs)) {
      return null;
    }

    const { invocation, env: tauriEnv } = resolveTauriPaneSpawnConfig({
      rootDir,
      env: childEnv,
      expoPort,
      skipExpoWait,
      resolveUserHomeDir: () => {
        try {
          return String(os.userInfo()?.homedir ?? '').trim();
        } catch {
          return String(os.homedir() ?? '').trim();
        }
      },
    });
    const proc = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: tauriEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      ...(process.platform === 'win32' ? { windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments } : null),
    });

    logOrch(`spawned: node apps/stack/scripts/tauri_dev.mjs (pid=${proc.pid})`);
    const tauriIdx = paneIndexById.get('tauri');
    const tauriPane = panes[tauriIdx];
    const write = (chunk) => {
      const s = String(chunk ?? '');
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        pushLine(tauriPane, line);
      }
      scheduleRender();
    };

    proc.stdout?.on('data', write);
    proc.stderr?.on('data', write);
    proc.on('exit', (code, sig) => {
      pushLine(tauriPane, `tauri exited (code=${code}, sig=${sig ?? 'null'})`);
      scheduleRender();
    });
    proc.on('error', (error) => {
      pushLine(tauriPane, `tauri error: ${error instanceof Error ? error.message : String(error)}`);
      scheduleRender();
    });

    return recordTuiChildProcessInstance(proc);
  };

  const spawnTauriChild = async () => {
    if (!withTauri || !shouldStartTauriPane(rawForwardedArgs)) {
      return null;
    }

    const tauriIdx = paneIndexById.get('tauri');
    const tauriPane = panes[tauriIdx];
    const launchState = { cancelled: false };
    tauriLaunchState = launchState;

    if (!stackName) {
      tauriChild = spawnTauriProcess();
      return tauriChild;
    }

    pushLine(tauriPane, '[tauri-dev] waiting for the TUI-managed Expo dev server...');
    scheduleRender();

    const expoReady = await waitForTauriPaneExpoReady({
      stackName,
      env: childEnv,
      isCancelled: () => launchState.cancelled,
    });
    if (launchState.cancelled || tauriLaunchState !== launchState) {
      return null;
    }
    if (!expoReady.ok) {
      const detail =
        expoReady.reason === 'timeout'
          ? 'timed out waiting for the TUI-managed Expo dev server; Tauri was not started.'
          : expoReady.reason === 'cancelled'
            ? 'launch cancelled before Expo became ready.'
            : 'could not resolve the TUI-managed Expo dev server; Tauri was not started.';
      pushLine(tauriPane, `[tauri-dev] ${detail}`);
      scheduleRender();
      return null;
    }

    tauriChild = spawnTauriProcess({
      expoPort: expoReady.port,
      skipExpoWait: true,
    });
    return tauriChild;
  };

  child = spawnForwardedChild();
  let tauriChild = null;
  void spawnTauriChild();

  async function refreshSummary() {
    await refreshBorrowedExpoLogFollower();
    if (stackName) {
      const runtime = await readStackRuntimeStateFile(getStackRuntimeStatePath(stackName)).catch(() => null);
      observedRuntimeOwner = runtime
        ? { ownerPid: runtime.ownerPid, startedAt: runtime.startedAt }
        : null;
      const replacementCandidate = restartOperation?.isReplacementRuntimeOwner?.(observedRuntimeOwner) === true;
      const ownershipAdmitted = runtimeOwnershipTracker.observe({
        runtimeOwner: observedRuntimeOwner,
        childActive: Boolean(child && child.exitCode == null && child.signalCode == null),
        launchRequested: detachedBackgroundOwner,
        runtimeRunnerLogPath: runtime?.logs?.runner,
        replacementCandidate,
      });
      if (replacementCandidate && ownershipAdmitted) {
        restartOperation?.observeRuntimeOwner?.(observedRuntimeOwner);
      }
      refreshRuntimeLogFollowers(runtime);
    }
    const idx = paneIndexById.get('summary');
    try {
      const lines = await buildStackSummaryLines({ rootDir, stackName });
      panes[idx].lines = lines;
    } catch (e) {
      panes[idx].lines = [`summary error: ${e instanceof Error ? e.message : String(e)}`];
    }

    const fabricIdx = paneIndexById.get('fabric');
    if (fabricIdx != null && executionFabricSummaryReader) {
      try {
        const summary = await executionFabricSummaryReader.read();
        panes[fabricIdx].lines = formatExecutionFabricSummaryLines(summary);
      } catch (error) {
        panes[fabricIdx].lines = [
          `execution fabric unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ];
      }
    }

    // Daemon pane (best-effort): show sign-in guidance when credentials are missing,
    // and clear stale guidance once either the local or target-hosted daemon starts.
    try {
      const daemonIdx = paneIndexById.get('daemon');
      if (stackName) {
        const runtimePath = getStackRuntimeStatePath(stackName);
        const runtime = await readStackRuntimeStateFile(runtimePath);

        const { baseDir } = resolveStackEnvPath(stackName);
        const serverPort = Number(runtime?.ports?.server);
        const internalServerUrl =
          Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '';
        const cliHomeDir = join(baseDir, 'cli');

        const scopedEnv = applyTuiStackAuthScopeEnv({ env: process.env, stackName });
        const authed = internalServerUrl
          ? hasStackCredentials({ cliHomeDir, serverUrl: internalServerUrl, env: scopedEnv })
          : hasStackCredentials({ cliHomeDir, serverUrl: '', env: scopedEnv });
        const observedDaemon = await getObservedStackDaemonAsync({
          cliHomeDir,
          internalServerUrl,
          runtimeDaemonPid: runtime?.processes?.daemonPid ?? null,
          runtimeDaemonPids: runtime?.processes?.daemonPids ?? [],
          env: scopedEnv,
        }, {
          checkDaemonStateImpl: checkDaemonStatePingAware,
        });

        const remoteDaemon = resolveRuntimeRemoteServiceObservation(runtime, 'daemon');
        const startDaemon = parseStartDaemonFlagFromEnv(process.env) && !remoteDaemon.target;
        const daemonRunning = observedDaemon.running || remoteDaemon.running;
        const notice = buildDaemonAuthNotice({
          stackName,
          internalServerUrl,
          daemonPid: observedDaemon.pid,
          daemonRunning,
          authed,
          startDaemon,
        });

        if (notice.show) {
          panes[daemonIdx].visible = true;
          panes[daemonIdx].title = notice.paneTitle || panes[daemonIdx].title;
          panes[daemonIdx].lines = styleDaemonNoticeLines(notice.paneLines || panes[daemonIdx].lines);
          if (!sawDaemonAuthRequired && notice.paneTitle === 'daemon (SIGN-IN REQUIRED)') {
            sawDaemonAuthRequired = true;
            if (focused === paneIndexById.get('local')) {
              focused = daemonIdx;
            }
          }
        } else {
          const reconciled = reconcileDaemonPaneAfterDaemonStarts({
            title: panes[daemonIdx].title,
            lines: panes[daemonIdx].lines,
            daemonPid: observedDaemon.pid,
            daemonRunning,
          });
          panes[daemonIdx].title = reconciled.title;
          panes[daemonIdx].lines = reconciled.lines;
        }
      }
    } catch {
      // ignore
    }

    // QR pane: driven by runtime state (expo port) and rendered independently of logs.
    try {
      const qrIdx = paneIndexById.get('qr');
      const qr = await buildExpoQrPaneLines({ rootDir, stackName });
      // Data-only pane (kept hidden): rendered inside the expo pane.
      panes[qrIdx].visible = false;
      panes[qrIdx].lines = qr.lines;
    } catch {
      const qrIdx = paneIndexById.get('qr');
      panes[qrIdx].visible = false;
      panes[qrIdx].lines = [];
    }
    scheduleRender();
  }

  let summaryTimer = null;
  const startSummaryTimer = () => {
    if (summaryTimer) clearInterval(summaryTimer);
    borrowedExpoLogFollower?.close();
    summaryTimer = setInterval(() => {
      if (!paused) {
        ensureTuiStdinMode(process.stdin);
        void refreshSummary();
      }
    }, 1000);
  };
  startSummaryTimer();

  async function runAuthLoginFromTui({ force = false } = {}) {
    if (!stackName) {
      logOrch('auth: no stack context; use `hstack stack auth <name> login`');
      scheduleRender();
      return;
    }

    const authArgs = buildTuiAuthArgs({ happysBin, stackName, force });

    if (summaryTimer) clearInterval(summaryTimer);
    paused = true;
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');

    // In TUI-driven dev/start flows, the stack server is usually still starting when users press "a".
    // Waiting here avoids triggering auth's "start the stack in background" prompt, which would
    // try to start a second stack instance and confuse users.
    const runtimePath = getStackRuntimeStatePath(stackName);
    const waitTimeoutRaw = (process.env.HAPPIER_STACK_TUI_AUTH_WAIT_TIMEOUT_MS ?? '').toString().trim();
    const waitTimeoutMs = waitTimeoutRaw ? Number(waitTimeoutRaw) : 45_000;
    const deadline = Date.now() + (Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0 ? waitTimeoutMs : 45_000);
    let internalServerUrl = '';
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const runtime = await readStackRuntimeStateFile(runtimePath);
      const port = Number(runtime?.ports?.server);
      if (Number.isFinite(port) && port > 0) {
        internalServerUrl = `http://127.0.0.1:${port}`;
        break;
      }
      process.stdout.write('.');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }
    process.stdout.write('\n');
    if (!internalServerUrl) {
      logOrch(
        `auth: waiting for the stack server timed out (${Math.round((Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : 45_000) / 1000)}s); check local/server, then press a again`,
      );
      paused = false;
      startSummaryTimer();
      await refreshSummary();
      scheduleRender();
      return;
    }

    process.stdout.write('[auth] waiting for server health');
    const healthOk = await waitForHappierHealthOk(internalServerUrl, { timeoutMs: 45_000, intervalMs: 300 });
    process.stdout.write(healthOk ? ' ✓\n' : ' (timeout)\n');
    if (!healthOk) {
      logOrch('auth: server did not become healthy in time; check local/server, then press a again');
      paused = false;
      startSummaryTimer();
      await refreshSummary();
      scheduleRender();
      return;
    }

    let authResult;
    try {
      authResult = await runWithTuiStdinHandoff({
        stdin: process.stdin,
        onData,
        run: () => new Promise((resolvePromise) => {
          const proc = spawn(process.execPath, authArgs, { cwd: rootDir, env: process.env, stdio: 'inherit' });
          proc.on('exit', (code, signal) => resolvePromise({ code, signal }));
          proc.on('error', () => resolvePromise({ code: 1, signal: null }));
        }),
      });
    } catch (error) {
      authResult = { code: 1, signal: null };
      logOrch(`auth: failed to start (${error instanceof Error ? error.message : String(error)})`);
    }

    paused = false;
    const authExitNotice = buildTuiAuthExitNotice(authResult);
    if (authExitNotice) logOrch(authExitNotice);

    // Restart summary refresh.
    startSummaryTimer();

    await refreshSummary();
    scheduleRender();
  }

  function restartStackFromTui() {
    if (!stackName || !isTuiRestartableForwardedArgs(forwarded)) {
      logOrch('restart: only supported for dev/start commands with an active stack context');
      scheduleRender();
      return;
    }

    const restartChildArgs = buildTuiRestartChildArgs({ childArgs: childForwarded, stackName });
    const result = beginTuiRestartOperation({
      currentOperation: restartOperation,
      previousChild: child,
      previousRuntimeOwner: observedRuntimeOwner,
      restartArgs: restartChildArgs,
      backgroundOwner: restartChildArgs.includes('--background') || restartChildArgs.includes('--bg'),
      spawnChild: spawnForwardedChild,
      trackChild: (nextChild) => {
        child = nextChild;
      },
      log: logOrch,
      refresh: () => {
        void refreshSummary();
        scheduleRender();
      },
    });
    restartOperation = result.operation;
    if (result.started) {
      // The incumbent runner log cannot authorize the replacement. Wait for the new canonical
      // background wrapper to announce the runner path it recorded in runtime state.
      runtimeOwnershipTracker.clearDetachedRunnerLogPath();
      logOrch(`restart: delegated to canonical stack owner (${restartChildArgs.join(' ')})`);
    }
  }

  function scheduleRender() {
    if (paused) return;
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      try {
        render();
      } catch (error) {
        void shutdownAfterUnexpectedTuiFailure(error);
      }
    }, 16);
  }

  function visiblePaneIndexes() {
    return panes
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => p.visible)
      .map(({ idx }) => idx);
  }

  function focusNext(delta) {
    const visible = visiblePaneIndexes();
    if (!visible.length) return;
    const pos = Math.max(0, visible.indexOf(focused));
    const next = (pos + delta + visible.length) % visible.length;
    focused = visible[next];
    scheduleRender();
  }

  function scrollFocused(delta) {
    const pane = panes[focused];
    pane.scroll = Math.max(0, pane.scroll + delta);
    scheduleRender();
  }

  function clearFocused() {
    const pane = panes[focused];
    if (pane.kind === 'summary') return;
    pane.lines = [];
    pane.scroll = 0;
    scheduleRender();
  }

  function cycleLayout() {
    layout = layout === 'single' ? 'split' : layout === 'split' ? 'columns' : 'single';
    scheduleRender();
  }

  function toggleFocusedVisibility() {
    if (layout !== 'columns') return;
    const pane = panes[focused];
    if (pane.id === 'orch') return; // always visible
    pane.visible = !pane.visible;
    if (!pane.visible) {
      // Move focus to next visible pane.
      focusNext(+1);
    }
    scheduleRender();
  }

  function render() {
    if (paused) return;
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 40;
    process.stdout.write('\x1b[?25l');
    process.stdout.write('\x1b[2J\x1b[H');

    const focusPane = panes[focused];
    const focusLabel = focusPane ? `${focusPane.id} (${focusPane.title})` : String(focused);
    const header = `hstack tui | ${forwarded.join(' ')}${withTauri ? ' +tauri' : ''} | layout=${layout} | focus=${focusLabel}`;
    process.stdout.write(padRight(header, cols) + '\n');

    const bodyY = 1;
    const bodyH = rows - 2;
    const footerY = rows - 1;

    const drawWrites = [];

    const contentY = bodyY;
    let contentH = bodyH;

    if (layout === 'single') {
      const pane = panes[focused];
      const box = drawBox({
        x: 0,
        y: contentY,
        w: cols,
        h: contentH,
        title: pane.title,
        lines: pane.lines,
        scroll: pane.scroll,
        active: true,
        allowAnsi: pane.id === 'summary' || pane.id === 'daemon',
      });
      pane.scroll = clamp(pane.scroll, 0, box.maxScroll);
      drawWrites.push(...box.out);
    } else if (layout === 'split') {
      const leftW = Math.floor(cols / 2);
      const rightW = cols - leftW;

      const leftPane = panes[paneIndexById.get('orch')];
      const rightPane = panes[focused === paneIndexById.get('orch') ? paneIndexById.get('local') : focused];

      const leftBox = drawBox({
        x: 0,
        y: contentY,
        w: leftW,
        h: contentH,
        title: leftPane.title,
        lines: leftPane.lines,
        scroll: leftPane.scroll,
        active: focused === paneIndexById.get('orch'),
        allowAnsi: leftPane.id === 'summary' || leftPane.id === 'daemon',
      });
      leftPane.scroll = clamp(leftPane.scroll, 0, leftBox.maxScroll);
      drawWrites.push(...leftBox.out);

      const rightBox = drawBox({
        x: leftW,
        y: contentY,
        w: rightW,
        h: contentH,
        title: rightPane.title,
        lines: rightPane.lines,
        scroll: rightPane.scroll,
        active: focused === (paneIndexById.get(rightPane.id) ?? focused),
        allowAnsi: rightPane.id === 'summary' || rightPane.id === 'daemon',
      });
      rightPane.scroll = clamp(rightPane.scroll, 0, rightBox.maxScroll);
      drawWrites.push(...rightBox.out);
    } else {
      // columns: render a compact top row (orch + summary), then render QR alongside Expo logs.
      const orchIdx = paneIndexById.get('orch');
      const summaryIdx = paneIndexById.get('summary');
      const qrIdx = paneIndexById.get('qr');
      const qrPane = panes[qrIdx];
      const qrVisible = Boolean(qrPane?.visible && qrPane.lines?.length);

      const topPanes = [panes[orchIdx], panes[summaryIdx]];
      const topCount = topPanes.length;
      const topH = getPaneHeightForLines(panes[summaryIdx].lines, { min: 6, max: 14 });

      const topY = contentY;
      const belowY = contentY + topH;
      const belowH = Math.max(0, contentH - topH);

      const colW = Math.floor(cols / topCount);
      for (let i = 0; i < topCount; i++) {
        const pane = topPanes[i];
        const x = i === topCount - 1 ? colW * i : colW * i;
        const w = i === topCount - 1 ? cols - colW * i : colW;
        const box = drawBox({
          x,
          y: topY,
          w,
          h: topH,
          title: pane.title,
          lines: pane.lines,
          scroll: pane.scroll,
          active: paneIndexById.get(pane.id) === focused,
          allowAnsi: pane.id === 'summary' || pane.id === 'daemon',
        });
        pane.scroll = clamp(pane.scroll, 0, box.maxScroll);
        drawWrites.push(...box.out);
      }

      // Remaining panes: exclude the top-row panes. QR is rendered inside the expo pane.
      const visibleAll = visiblePaneIndexes()
        .filter((idx) => idx !== orchIdx && idx !== summaryIdx && idx !== qrIdx)
        .map((idx) => panes[idx]);
      const leftW = Math.floor(cols / 2);
      const rightW = cols - leftW;

      const leftPanes = [];
      const rightPanes = [];
      const expoPane = panes[paneIndexById.get('expo')];
      const visible = visibleAll.filter((p) => p !== expoPane);
      for (let i = 0; i < visible.length; i++) {
        (i % 2 === 0 ? leftPanes : rightPanes).push(visible[i]);
      }
      if (expoPane?.visible) {
        rightPanes.unshift(expoPane);
      }

      const layoutColumn = (colX, colW, colPanes) => {
        if (!colPanes.length) return;
        const n = colPanes.length;
        const base = Math.max(3, Math.floor(belowH / n));
        let y = belowY;
        for (let i = 0; i < n; i++) {
          const pane = colPanes[i];
          const remaining = belowY + belowH - y;
          let h = i === n - 1 ? remaining : Math.min(base, remaining);
          if (h < 3) break;
          if (pane.id === 'expo') {
            const qrLines = Array.isArray(qrPane?.lines) ? qrPane.lines : [];
            const qrHas = Boolean(qrLines.length);
            const qrMinH = qrHas ? Math.max(6, qrLines.length + 2) : 0; // +2 borders
            if (qrMinH && h < qrMinH) {
              h = Math.min(remaining, qrMinH);
              if (h < 3) break;
            }

            if (qrHas) {
              // Split the expo pane horizontally:
              // left = expo logs, right = QR. This uses width instead of extra height.
              const maxLineLen = qrLines.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0);
              const minLogW = 24;
              const minQrW = 22;
              const maxQrW = Math.max(0, Math.min(80, colW - minLogW));
              const fixedQrWRaw = (process.env.HAPPIER_STACK_TUI_QR_WIDTH ?? '').toString().trim();
              const fixedQrW = fixedQrWRaw ? Number(fixedQrWRaw) : 44;
              const qrW = clamp(Number.isFinite(fixedQrW) && fixedQrW > 0 ? fixedQrW : maxLineLen + 2, minQrW, maxQrW);
              const canSplit = qrW >= minQrW && colW - qrW >= minLogW;

              if (canSplit) {
                const logW = colW - qrW;
                const logBox = drawBox({
                  x: colX,
                  y,
                  w: logW,
                  h,
                  title: pane.title,
                  lines: pane.lines,
                  scroll: pane.scroll,
                  active: paneIndexById.get(pane.id) === focused,
                  allowAnsi: pane.id === 'summary' || pane.id === 'daemon',
                });
                pane.scroll = clamp(pane.scroll, 0, logBox.maxScroll);
                drawWrites.push(...logBox.out);

                const qrBox = drawBox({
                  x: colX + logW,
                  y,
                  w: qrW,
                  h,
                  title: qrPane.title,
                  lines: qrLines,
                  scroll: 0,
                  active: paneIndexById.get(pane.id) === focused,
                  allowAnsi: false,
                });
                drawWrites.push(...qrBox.out);
              } else {
                // Too narrow to split cleanly: fallback to single expo log box.
                const box = drawBox({
                  x: colX,
                  y,
                  w: colW,
                  h,
                  title: pane.title,
                  lines: pane.lines,
                  scroll: pane.scroll,
                  active: paneIndexById.get(pane.id) === focused,
                  allowAnsi: pane.id === 'summary' || pane.id === 'daemon',
                });
                pane.scroll = clamp(pane.scroll, 0, box.maxScroll);
                drawWrites.push(...box.out);
              }
            } else {
              const box = drawBox({
                x: colX,
                y,
                w: colW,
                h,
                title: pane.title,
                lines: pane.lines,
                scroll: pane.scroll,
                active: paneIndexById.get(pane.id) === focused,
                allowAnsi: pane.id === 'summary' || pane.id === 'daemon',
              });
              pane.scroll = clamp(pane.scroll, 0, box.maxScroll);
              drawWrites.push(...box.out);
            }
          } else {
            const box = drawBox({
              x: colX,
              y,
              w: colW,
              h,
              title: pane.title,
              lines: pane.lines,
              scroll: pane.scroll,
              active: paneIndexById.get(pane.id) === focused,
              allowAnsi: pane.id === 'summary' || pane.id === 'daemon',
            });
            pane.scroll = clamp(pane.scroll, 0, box.maxScroll);
            drawWrites.push(...box.out);
          }
          y += h;
        }
      };

      layoutColumn(0, leftW, leftPanes);
      layoutColumn(leftW, rightW, rightPanes);
    }

    for (const w of drawWrites) {
      process.stdout.write(`\x1b[${w.row + 1};${w.col + 1}H${w.text}`);
    }

    const footerParts = [
      'tab:next',
      'shift+tab:prev',
      '1..9:jump',
      'v:layout',
      'm:toggle-pane',
      'c:clear',
      'p:pause',
      'arrows:scroll',
      stackName ? 'a/A:auth' : null,
      stackName && isTuiRestartableForwardedArgs(forwarded) ? 'r:restart' : null,
      'q/Ctrl+C:quit',
    ].filter(Boolean);
    const footer = footerParts.join('  ');
    process.stdout.write(`\x1b[${footerY + 1};1H` + padRight(footer, cols));
    process.stdout.write('\x1b[?25h');
  }

  let exiting = false;
  async function shutdownAndExit(code = 0, exitPolicy = resolveTuiExitPolicy({ explicit: true })) {
    if (exiting) return;
    exiting = true;

    if (summaryTimer) clearInterval(summaryTimer);
    try {
      process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
    try {
      process.stdin.pause();
    } catch {
      // ignore
    }
    cancelPendingTauriLaunch();
    borrowedExpoLogFollower?.close();
    closeRuntimeLogFollowers();
    let cleanupError = null;
    await applyTuiExitPolicy({
      exitPolicy,
      terminateChildren: async () => {
        const shutdownChildren = resolveTuiShutdownChildren({ trackedChild: child, restartOperation });
        for (const shutdownChild of shutdownChildren) {
          const childPid = Number(shutdownChild?.pid);
          if (shutdownChild.exitCode != null || shutdownChild.signalCode != null || !Number.isFinite(childPid) || childPid <= 1) {
            continue;
          }
          // Ensure the child is actually gone before stack infra cleanup, otherwise a still-running
          // watch process can immediately respawn server/daemon and re-lock the DB.
          await terminateTuiChildProcessTree(shutdownChild, {
            stackName,
            envPath: stackEnvPath,
            cliHomeDir: stackCliHomeDir,
          });
        }
      },
      terminateTauri: async () => {
        const tauriPid = Number(tauriChild?.pid);
        if (!tauriChild || tauriChild.exitCode != null || !Number.isFinite(tauriPid) || tauriPid <= 1) return;
        await terminateTuiChildProcessTree(tauriChild, {
          stackName,
          envPath: stackEnvPath,
          cliHomeDir: stackCliHomeDir,
        });
      },
      // Explicit TUI quit stops only the runtime owner that this TUI admitted. The launch command
      // may already have exited because the persistent dev/start owner runs in the background.
      stopRuntime: async () => {
        if (!stackName || !isTuiStartLikeForwardedArgs(forwarded)) return;
        const expectedRuntimeOwner = runtimeOwnershipTracker.getExpectedOwner();
        if (!expectedRuntimeOwner) {
          logOrch('stop skipped: this TUI did not admit a runtime owner');
          return;
        }
        try {
          await stopStackForTuiExit({
            rootDir,
            stackName,
            json: false,
            noDocker: false,
            expectedRuntimeOwner,
          });
        } catch (e) {
          cleanupError = e;
          logOrch(`stop failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
    if (cleanupError) {
      // eslint-disable-next-line no-console
      console.error(`[tui] cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    process.exit(code);
  }

  function shutdown() {
    shutdownAndExit(0, resolveTuiExitPolicy({ explicit: true })).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[tui] shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  }

  function detach() {
    shutdownAndExit(0, resolveTuiExitPolicy()).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[tui] detach error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  }

  async function shutdownAfterUnexpectedTuiFailure(error) {
    // A renderer/terminal failure must detach from the persistent Stack owner just like an
    // external terminal signal; the Tauri pane remains TUI-owned and is cleaned up.
    // eslint-disable-next-line no-console
    console.error(`[tui] failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await shutdownAndExit(1, resolveTuiExitPolicy());
    } catch (shutdownError) {
      // eslint-disable-next-line no-console
      console.error(`[tui] unexpected detach error: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`);
      process.exit(1);
    }
  }

  // Keyboard quit is handled in raw mode below. External terminal/process termination detaches
  // from the stack's persistent owner instead of turning an unexpected TUI failure into a stop.
  process.on('SIGINT', detach);
  process.on('SIGTERM', detach);
  process.on('SIGHUP', detach);

  ensureTuiStdinMode(process.stdin);
  const onData = (d) => {
    const s = d.toString('utf-8');
    if (s === '\u0003' || s === 'q') {
      shutdown();
      return;
    }
    if (s === 'a') {
      void runAuthLoginFromTui({ force: false });
      return;
    }
    if (s === 'A') {
      void runAuthLoginFromTui({ force: true });
      return;
    }
    if (s === 'r') {
      void restartStackFromTui();
      return;
    }
    if (s === '\t') return focusNext(+1);
    if (s === '\x1b[Z') return focusNext(-1);
    if (s >= '1' && s <= '9') {
      const idx = Number(s) - 1;
      if (idx >= 0 && idx < panes.length) {
        if (panes[idx].visible) {
          focused = idx;
          scheduleRender();
        }
      }
      return;
    }
    if (s === 'v') return cycleLayout();
    if (s === 'm') return toggleFocusedVisibility();
    if (s === 'c') return clearFocused();
    if (s === 'p') {
      paused = !paused;
      if (!paused) {
        void refreshSummary();
        scheduleRender();
      }
      return;
    }

    if (s === '\x1b[A') return scrollFocused(+1);
    if (s === '\x1b[B') return scrollFocused(-1);
    if (s === '\x1b[5~') return scrollFocused(+10);
    if (s === '\x1b[6~') return scrollFocused(-10);
    if (s === '\x1b[H') {
      panes[focused].scroll = 1000000;
      scheduleRender();
      return;
    }
    if (s === '\x1b[F') {
      panes[focused].scroll = 0;
      scheduleRender();
      return;
    }
  };
  process.stdin.on('data', onData);

  try {
    await refreshSummary();
    render();
    await new Promise(() => {});
  } catch (error) {
    await shutdownAfterUnexpectedTuiFailure(error);
  }
}

main().catch((err) => {
  console.error('[tui] failed:', err);
  process.exit(1);
});
