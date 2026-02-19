import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { printResult } from './utils/cli/cli.mjs';
import { readEnvObjectFromFile } from './utils/env/read.mjs';
import { getComponentDir, getRepoDir, getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { getStackRuntimeStatePath, readStackRuntimeStateFile } from './utils/stack/runtime_state.mjs';
import { getEnvValueAny } from './utils/env/values.mjs';
import { padRight, parsePrefixedLabel, stripAnsi } from './utils/ui/text.mjs';
import { formatBoxLine } from './utils/ui/box_line.mjs';
import { commandExists } from './utils/proc/commands.mjs';
import { renderQrAscii } from './utils/ui/qr.mjs';
import { resolveMobileQrPayload } from './utils/mobile/dev_client_links.mjs';
import { worktreeSpecFromDir } from './utils/git/worktrees.mjs';
import { stopStackForTuiExit } from './utils/tui/cleanup.mjs';
import {
  inferTuiStackName,
  isTuiHelpRequest,
  isTuiRestartableForwardedArgs,
  isTuiStartLikeForwardedArgs,
  normalizeTuiForwardedArgs,
} from './utils/tui/args.mjs';
import { terminateProcessGroup } from './utils/proc/terminate.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { mergeEnvForTuiSummary } from './utils/tui/summary_env.mjs';
import { hasStackCredentials } from './utils/auth/daemon_gate.mjs';
import { applyTuiStackAuthScopeEnv } from './utils/tui/stack_scope_env.mjs';
import { buildDaemonAuthNotice, parseStartDaemonFlagFromEnv } from './utils/tui/daemon_auth_notice.mjs';
import { detachTuiStdinForChild, waitForEnter } from './utils/tui/stdin_handoff.mjs';
import { waitForHappierHealthOk } from './utils/server/server.mjs';
import { buildTuiAuthArgs, buildTuiDaemonStartArgs, shouldHoldAfterAuthExit } from './utils/tui/actions.mjs';
import { shouldAttemptTuiDaemonAutostart } from './utils/tui/daemon_autostart.mjs';

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
    const proc = spawn('yarn', ['--version'], {
      env,
      cwd: baseDir,
      // Non-tty stdio: Corepack typically won't prompt; if it does, we still provide "y\n".
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false,
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

  const serverComponent =
    getEnvValueAny(env, ['HAPPIER_STACK_SERVER_COMPONENT']) || 'happier-server-light';

  const ports = runtime?.ports && typeof runtime.ports === 'object' ? runtime.ports : {};
  const expo = runtime?.expo && typeof runtime.expo === 'object' ? runtime.expo : {};
  const expoPort = expo?.port ?? expo?.webPort ?? expo?.mobilePort ?? null;
  const expoDevClientEnabled = Boolean(expo?.devClientEnabled);
  const processes = runtime?.processes && typeof runtime.processes === 'object' ? runtime.processes : {};

  const serverPort = Number(ports?.server);
  const internalServerUrl =
    Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '';
  const cliHomeDir = join(baseDir, 'cli');
  const authed = internalServerUrl
    ? hasStackCredentials({ cliHomeDir, serverUrl: internalServerUrl, env: authScopeEnv })
    : hasStackCredentials({ cliHomeDir, serverUrl: '', env: authScopeEnv });
  const startDaemon = parseStartDaemonFlagFromEnv(env);

  const lines = [];
  lines.push(`stack: ${stackName}`);
  lines.push(`server: ${serverComponent}`);
  lines.push(`baseDir: ${baseDir}`);
  lines.push(`env: ${envPath}`);
  lines.push(`runtime: ${runtimePath}${runtime ? '' : ' (missing)'}`);
  if (runtime?.startedAt) lines.push(`startedAt: ${runtime.startedAt}`);
  if (runtime?.updatedAt) lines.push(`updatedAt: ${runtime.updatedAt}`);
  if (runtime?.ownerPid) lines.push(`ownerPid: ${runtime.ownerPid}`);

  // Make daemon auth issues obvious even if the user never focuses the daemon pane.
  const notice = buildDaemonAuthNotice({
    stackName,
    internalServerUrl,
    daemonPid: processes?.daemonPid ?? null,
    authed,
    startDaemon,
  });
  if (notice.show) {
    lines.push('');
    for (const l of styleDaemonNoticeLines(notice.summaryLines)) lines.push(l);
  }

  lines.push('');
  lines.push('ports:');
  lines.push(`  server: ${ports?.server ?? '(unknown)'}`);
  if (expoPort) lines.push(`  expo: ${expoPort}`);
  if (ports?.backend) lines.push(`  backend: ${ports.backend}`);

  if (expoPort && expoDevClientEnabled) {
    const payload = resolveMobileQrPayload({ env: process.env, port: Number(expoPort) });
    lines.push('');
    lines.push('expo dev-client links:');
    if (payload.metroUrl) lines.push(`  metro: ${payload.metroUrl}`);
    if (payload.scheme && payload.deepLink) lines.push(`  link:  ${payload.deepLink}`);
  }

  lines.push('');
  lines.push('pids:');
  if (processes?.serverPid) lines.push(`  serverPid: ${processes.serverPid}`);
  if (processes?.expoPid) lines.push(`  expoPid: ${processes.expoPid}`);
  if (processes?.daemonPid) lines.push(`  daemonPid: ${processes.daemonPid}`);
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

async function buildExpoQrPaneLines({ stackName }) {
  if (!stackName) {
    return { visible: false, lines: [] };
  }
  const runtimePath = getStackRuntimeStatePath(stackName);
  const runtime = await readStackRuntimeStateFile(runtimePath);
  const expo = runtime?.expo && typeof runtime.expo === 'object' ? runtime.expo : {};
  const port = Number(expo?.port ?? expo?.mobilePort ?? expo?.webPort);
  const enabled = Boolean(expo?.devClientEnabled);
  if (!enabled || !Number.isFinite(port) || port <= 0) {
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
  const argv = normalizeTuiForwardedArgs(argvRaw);

  if (isTuiHelpRequest(argvRaw)) {
    printResult({
      json: false,
      data: { usage: 'hstack tui [<hstack args...>]', json: false, defaultCommand: 'dev' },
      text: [
        '[tui] usage:',
        '  hstack tui [<hstack args...>]',
        '',
        'defaults:',
        '  hstack tui                 => hstack tui dev',
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
        '  q / Ctrl+C      : quit (sends SIGINT to child)',
        '',
        'panes (default):',
        '  orchestration | summary | local | server | expo | daemon | stack logs',
      ].join('\n'),
    });
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('[tui] requires a TTY (interactive terminal)');
  }

  const rootDir = getRootDir(import.meta.url);
  const happysBin = join(rootDir, 'bin', 'hstack.mjs');
  const forwarded = argv;

  const stackName = inferTuiStackName(forwarded, process.env);
  const stackEnvPath = stackName ? resolveStackEnvPath(stackName).envPath : null;
  const summaryTitle = stackName ? `stack summary (${stackName})` : 'session summary (stackless)';

  const panes = [
    mkPane('orch', 'orchestration', { visible: true, kind: 'log' }),
    mkPane('summary', summaryTitle, { visible: true, kind: 'summary' }),
    // Data-only pane: we render QR inside the Expo pane (no separate box).
    mkPane('qr', 'expo QR', { visible: false, kind: 'qr' }),
    mkPane('local', 'local', { visible: true, kind: 'log' }),
    mkPane('server', 'server', { visible: false, kind: 'log' }),
    mkPane('expo', 'expo', { visible: false, kind: 'log' }),
    mkPane('daemon', 'daemon', { visible: false, kind: 'log' }),
    mkPane('stacklog', 'stack logs', { visible: false, kind: 'log' }),
  ];

  const paneIndexById = new Map(panes.map((p, i) => [p.id, i]));

  const routeLine = (line) => {
    const label = parsePrefixedLabel(line);
    const normalized = label ? label.toLowerCase() : '';

    let paneId = 'local';
    if (normalized.includes('server')) paneId = 'server';
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

  // Preflight Yarn/Corepack for this stack before spawning the pty child.
  // This prevents Corepack "download yarn? [Y/n]" prompts from deadlocking the TUI.
  await preflightCorepackYarnForStack({ envPath: stackEnvPath });

  let layout = 'columns'; // single | split | columns
  let focused = paneIndexById.get('local'); // default focus
  let paused = false;
  let renderScheduled = false;
  let sawDaemonAuthRequired = false;
  let daemonAutostartInProgress = false;
  let daemonAutostartLastAttemptAtMs = 0;

  const wantsPty = process.platform !== 'win32' && (await commandExists('script', { cwd: rootDir }));
  // In TUI mode, we intentionally do not forward keyboard input to the child process (stdin is ignored),
  // so any interactive prompts inside the child would deadlock.
  // Mark the child env so dependency installers can auto-approve safe prompts (Corepack yarn downloads).
  const childEnv = {
    ...process.env,
    HAPPIER_STACK_TUI: '1',
    // Avoid Corepack mutating package.json automatically.
    COREPACK_ENABLE_AUTO_PIN: '0',
  };
  let child = null;

  const spawnForwardedChild = () => {
    const proc = wantsPty
      ? // Use a pseudo-terminal so tools like Expo print QR/status output that they hide in non-TTY mode.
        // `script` is available by default on macOS (and common on Linux).
        spawn('script', ['-q', '/dev/null', process.execPath, happysBin, ...forwarded], {
          cwd: rootDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        })
      : spawn(process.execPath, [happysBin, ...forwarded], {
          cwd: rootDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });

    logOrch(
      `spawned: ${wantsPty ? 'script -q /dev/null ' : ''}node ${happysBin} ${forwarded.join(' ')} (pid=${proc.pid})`
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
      logOrch(`child exited (code=${code}, sig=${sig ?? 'null'})`);
      scheduleRender();
    });

    return proc;
  };

  child = spawnForwardedChild();

  async function refreshSummary() {
    const idx = paneIndexById.get('summary');
    try {
      const lines = await buildStackSummaryLines({ rootDir, stackName });
      panes[idx].lines = lines;
    } catch (e) {
      panes[idx].lines = [`summary error: ${e instanceof Error ? e.message : String(e)}`];
    }

    // Daemon pane (best-effort): if daemon isn't running because credentials are missing, show guidance.
    try {
      const daemonIdx = paneIndexById.get('daemon');
      if (stackName) {
        const runtimePath = getStackRuntimeStatePath(stackName);
        const runtime = await readStackRuntimeStateFile(runtimePath);
        const daemonPid = Number(runtime?.processes?.daemonPid);
        if (!Number.isFinite(daemonPid) || daemonPid <= 1) {
          const { baseDir } = resolveStackEnvPath(stackName);
          const serverPort = Number(runtime?.ports?.server);
          const internalServerUrl =
            Number.isFinite(serverPort) && serverPort > 0 ? `http://127.0.0.1:${serverPort}` : '';
          const cliHomeDir = join(baseDir, 'cli');
          const authed = internalServerUrl
            ? hasStackCredentials({
                cliHomeDir,
                serverUrl: internalServerUrl,
                env: applyTuiStackAuthScopeEnv({ env: process.env, stackName }),
              })
            : hasStackCredentials({ cliHomeDir, serverUrl: '', env: applyTuiStackAuthScopeEnv({ env: process.env, stackName }) });

          const startDaemon = parseStartDaemonFlagFromEnv(process.env);
          const notice = buildDaemonAuthNotice({
            stackName,
            internalServerUrl,
            daemonPid: null,
            authed,
            startDaemon,
          });
          if (notice.show) {
            panes[daemonIdx].visible = true;
            panes[daemonIdx].title = notice.paneTitle || panes[daemonIdx].title;
            const preserve =
              daemonAutostartInProgress ||
              (daemonAutostartLastAttemptAtMs > 0 && Date.now() - daemonAutostartLastAttemptAtMs < 6_000);
            if (!preserve || panes[daemonIdx].lines.length === 0) {
              panes[daemonIdx].lines = styleDaemonNoticeLines(notice.paneLines || panes[daemonIdx].lines);
            }
            if (!sawDaemonAuthRequired && notice.paneTitle === 'daemon (SIGN-IN REQUIRED)') {
              sawDaemonAuthRequired = true;
              // One-shot nudge: focus the daemon pane so users see the message before opening the UI.
              if (focused === paneIndexById.get('local')) {
                focused = daemonIdx;
              }
            }
          }

          const isStartLike = isTuiStartLikeForwardedArgs(forwarded);
          const minIntervalRaw = (process.env.HAPPIER_STACK_TUI_DAEMON_AUTOSTART_MIN_INTERVAL_MS ?? '').toString().trim();
          const minIntervalMs = minIntervalRaw ? Number(minIntervalRaw) : 12_000;
          const shouldAutostart = shouldAttemptTuiDaemonAutostart({
            stackName,
            isStartLike,
            startDaemon,
            internalServerUrl,
            authed,
            daemonPid: null,
            inProgress: daemonAutostartInProgress,
            lastAttemptAtMs: daemonAutostartLastAttemptAtMs,
            nowMs: Date.now(),
            minIntervalMs,
          });

          if (shouldAutostart) {
            daemonAutostartInProgress = true;
            daemonAutostartLastAttemptAtMs = Date.now();
            panes[daemonIdx].visible = true;
            panes[daemonIdx].title = 'daemon (STARTING)';
            pushLine(panes[daemonIdx], 'starting daemon...');
            scheduleRender();

	            void (async () => {
	              try {
	                // Best-effort: only start daemon once server is responding.
	                await waitForHappierHealthOk(internalServerUrl, { timeoutMs: 10_000, intervalMs: 250 });

	                const daemonArgs = buildTuiDaemonStartArgs({ happysBin, stackName });
	                const attemptLines = [];
	                await new Promise((resolvePromise) => {
	                  const proc = spawn(process.execPath, daemonArgs, {
	                    cwd: rootDir,
	                    env: { ...process.env, HAPPIER_STACK_TUI: '1' },
	                    stdio: ['ignore', 'pipe', 'pipe'],
	                  });

	                  const write = (chunk) => {
	                    const s = String(chunk ?? '');
	                    for (const line of s.split(/\r?\n/)) {
	                      if (!line.trim()) continue;
	                      attemptLines.push(line);
	                      pushLine(panes[daemonIdx], line);
	                    }
	                    scheduleRender();
	                  };

	                  proc.stdout?.on('data', write);
	                  proc.stderr?.on('data', write);
	                  proc.on('exit', () => resolvePromise());
	                  proc.on('error', () => resolvePromise());
	                });

	                const combined = attemptLines.join('\n').toLowerCase();
	                if (combined.includes('already running')) {
	                  panes[daemonIdx].title = 'daemon (ALREADY RUNNING)';
	                  pushLine(panes[daemonIdx], 'daemon already running; no action needed');
	                } else {
	                  panes[daemonIdx].title = 'daemon (STARTED)';
	                  pushLine(panes[daemonIdx], 'daemon start completed');
	                }
	                scheduleRender();
	              } finally {
	                daemonAutostartInProgress = false;
	                try {
	                  await refreshSummary();
                } catch {
                  // ignore
                }
              }
            })();
          }
        }
      }
    } catch {
      // ignore
    }

    // QR pane: driven by runtime state (expo port) and rendered independently of logs.
    try {
      const qrIdx = paneIndexById.get('qr');
      const qr = await buildExpoQrPaneLines({ stackName });
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
    summaryTimer = setInterval(() => {
      if (!paused) {
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
      process.stdout.write(
        `[auth] waiting for the stack server timed out (${Math.round((Number.isFinite(waitTimeoutMs) ? waitTimeoutMs : 45_000) / 1000)}s).\n` +
          `[auth] The stack may still be starting. Check the "local" / "server" panes, then press "a" again.\n\n` +
          `Press Enter to return to TUI...`
      );
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      try {
        process.stdin.resume();
      } catch {
        // ignore
      }
      await waitForEnter({ stdin: process.stdin, timeoutMs: 120_000 });
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
      process.stdout.write(
        `[auth] server did not become healthy in time.\n` +
          `[auth] Check the "local" / "server" panes, then press "a" again.\n\n` +
          `Press Enter to return to TUI...`
      );
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      try {
        process.stdin.resume();
      } catch {
        // ignore
      }
      await waitForEnter({ stdin: process.stdin, timeoutMs: 120_000 });
      paused = false;
      startSummaryTimer();
      await refreshSummary();
      scheduleRender();
      return;
    }

    const handoff = detachTuiStdinForChild({ stdin: process.stdin, onData });

    const authResult = await new Promise((resolvePromise) => {
      const proc = spawn(process.execPath, authArgs, { cwd: rootDir, env: process.env, stdio: 'inherit' });
      proc.on('exit', (code, signal) => resolvePromise({ code, signal }));
      proc.on('error', () => resolvePromise({ code: 1, signal: null }));
    });

    let hold = shouldHoldAfterAuthExit(authResult);

    // If auth succeeded and daemon is expected, start it automatically so the UI immediately shows a machine.
    if (!hold) {
      try {
        const { envPath } = resolveStackEnvPath(stackName);
        const envFromFile = await readEnvObject(envPath).catch(() => ({}));
        const startDaemon = parseStartDaemonFlagFromEnv({ ...process.env, ...envFromFile });

        if (startDaemon) {
          const runtime = await readStackRuntimeStateFile(runtimePath);
          const daemonPid = Number(runtime?.processes?.daemonPid);
          const daemonRunning = Number.isFinite(daemonPid) && daemonPid > 1;
          if (!daemonRunning) {
            process.stdout.write(`\n[daemon] starting...\n`);
            const daemonArgs = buildTuiDaemonStartArgs({ happysBin, stackName });
            const daemonRes = await new Promise((resolvePromise) => {
              const proc = spawn(process.execPath, daemonArgs, { cwd: rootDir, env: process.env, stdio: 'inherit' });
              proc.on('exit', (code, signal) => resolvePromise({ code, signal }));
              proc.on('error', () => resolvePromise({ code: 1, signal: null }));
            });
            hold = hold || shouldHoldAfterAuthExit(daemonRes);
          }
        }
      } catch {
        // ignore
      }
    }

    if (hold) {
      try {
        process.stdout.write(
          `\n[auth] finished (code=${authResult?.code ?? 'null'}, sig=${authResult?.signal ?? 'null'}). Press Enter to return to TUI...`
        );
        // Re-enable stdin reads (in cooked mode) for the one-line prompt.
        try {
          process.stdin.setRawMode(false);
        } catch {
          // ignore
        }
        try {
          process.stdin.resume();
        } catch {
          // ignore
        }
        await waitForEnter({ stdin: process.stdin, timeoutMs: 120_000 });
      } catch {
        // ignore
      }
    }

    paused = false;
    handoff.restoreForTui();

    // Restart summary refresh.
    startSummaryTimer();

    await refreshSummary();
    scheduleRender();
  }

  async function restartStackFromTui() {
    if (!stackName || !isTuiRestartableForwardedArgs(forwarded)) {
      logOrch('restart: only supported for dev/start commands with an active stack context');
      scheduleRender();
      return;
    }

    if (summaryTimer) clearInterval(summaryTimer);
    paused = true;
    const handoff = detachTuiStdinForChild({ stdin: process.stdin, onData });
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
    process.stdout.write(`[restart] stopping stack processes...\n`);

    const childPid = Number(child?.pid);
    if (child && child.exitCode == null && Number.isFinite(childPid) && childPid > 1) {
      await terminateProcessGroup(childPid, { graceMs: 900 });
    }

    try {
      await stopStackForTuiExit({ rootDir, stackName, json: false, noDocker: false });
    } catch (e) {
      process.stdout.write(`[restart] stop failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.stdout.write(`Press Enter to return to TUI...`);
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      try {
        process.stdin.resume();
      } catch {
        // ignore
      }
      await waitForEnter({ stdin: process.stdin, timeoutMs: 120_000 });
      handoff.restoreForTui();
      paused = false;
      startSummaryTimer();
      await refreshSummary();
      scheduleRender();
      return;
    }

    // Clear log panes so old output doesn't get mixed with the new run.
    for (const p of panes) {
      if (p.kind === 'summary') continue;
      if (p.id === 'orch') continue;
      p.lines = [];
      p.scroll = 0;
    }

    process.stdout.write(`[restart] starting stack...\n\n`);
    child = spawnForwardedChild();

    paused = false;
    handoff.restoreForTui();
    startSummaryTimer();
    await refreshSummary();
    scheduleRender();
  }

  function scheduleRender() {
    if (paused) return;
    if (renderScheduled) return;
    renderScheduled = true;
    setTimeout(() => {
      renderScheduled = false;
      render();
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
    const header = `hstack tui | ${forwarded.join(' ')} | layout=${layout} | focus=${focusLabel}`;
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
  async function shutdownAndExit(code = 0) {
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
    const childPid = Number(child?.pid);
    if (child.exitCode == null && Number.isFinite(childPid) && childPid > 1) {
      // Ensure the child is actually gone before stack infra cleanup, otherwise a still-running
      // watch process can immediately respawn server/daemon and re-lock the DB.
      await terminateProcessGroup(childPid, { graceMs: 900 });
    }

    // Best-effort cleanup: when the TUI runs a long-lived `dev/start` command, ensure all
    // stack-owned infra processes are stopped (server/expo/daemon) even if the child exits early.
    let cleanupError = null;
    if (stackName && isTuiStartLikeForwardedArgs(forwarded)) {
      try {
        await stopStackForTuiExit({ rootDir, stackName, json: false, noDocker: false });
      } catch (e) {
        cleanupError = e;
        logOrch(`stop failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
    if (cleanupError) {
      // eslint-disable-next-line no-console
      console.error(`[tui] cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    process.exit(code);
  }

  function shutdown() {
    shutdownAndExit(0).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[tui] shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  }

  // Ensure we still clean up if the process receives an actual signal (e.g. watch reload / external stop).
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.stdin.setRawMode(true);
  process.stdin.resume();
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

  await refreshSummary();
  render();
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[tui] failed:', err);
  process.exit(1);
});
