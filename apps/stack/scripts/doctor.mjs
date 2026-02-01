import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { runCapture } from './utils/proc/proc.mjs';
import { resolveCommandPath } from './utils/proc/commands.mjs';
import { getComponentDir, getDefaultAutostartPaths, getHappyStacksHomeDir, getRootDir, getWorkspaceDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { killPortListeners } from './utils/net/ports.mjs';
import { getServerComponentName } from './utils/server/server.mjs';
import { fetchHappyHealth } from './utils/server/server.mjs';
import { daemonStatusSummary } from './daemon.mjs';
import { tailscaleServeStatus } from './tailscale.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { assertServerComponentDirMatches } from './utils/server/validate.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { readJsonIfExists } from './utils/fs/json.mjs';
import { readPackageJsonVersion } from './utils/fs/package_json.mjs';
import { banner, bullets, cmd, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, red, yellow } from './utils/ui/ansi.mjs';
import { detectSwiftbarPluginInstalled } from './utils/menubar/swiftbar.mjs';

/**
 * Doctor script for common happy-stacks failure modes.
 *
 * Checks:
 * - server port in use / server health
 * - UI build directory existence
 * - daemon status
 * - tailscale serve status (if available)
 * - launch agent status (macOS)
 *
 * Flags:
 * - --fix : best-effort fixes (kill server port listener)
 */

async function fetchHealth(url) {
  const tryGet = async (path) => {
    try {
      const res = await fetch(`${url}${path}`, { method: 'GET' });
      const body = await res.text();
      return { ok: res.ok, status: res.status, body: body.trim() };
    } catch {
      return { ok: false, status: null, body: null };
    }
  };

  // Prefer /health when available, but fall back to / (matches waitForServerReady).
  const healthRaw = await fetchHappyHealth(url);
  const health = { ok: healthRaw.ok, status: healthRaw.status, body: healthRaw.text ? healthRaw.text.trim() : null };
  if (health.ok) {
    return health;
  }
  const root = await tryGet('/');
  if (root.ok && root.body?.includes('Welcome to Happier Server!')) {
    return root;
  }
  return health.ok ? health : root;
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv: argsKv } = parseArgs(argv);
  const fix = flags.has('--fix');
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--fix', '--server=happy-server|happy-server-light'], json: true },
      text: [
        '',
        banner('doctor', { subtitle: 'Diagnose common local setup failure modes.' }),
        '',
        sectionTitle('Usage'),
        bullets([
          `${dim('recommended:')} ${cmd('hstack doctor')} ${dim('[--fix] [--json]')}`,
          `${dim('direct:')} ${cmd('node scripts/doctor.mjs')} ${dim('[--fix] [--server=happy-server|happy-server-light] [--json]')}`,
        ]),
        '',
        sectionTitle('Notes'),
        bullets([
          `${dim('--fix:')} best-effort fixes (non-stack mode only; refuses to kill unknown port listeners in stack mode)`,
        ]),
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const homeDir = getHappyStacksHomeDir();
  const runtimeDir = getRuntimeDir();
  const workspaceDir = getWorkspaceDir(rootDir);
  const updateCachePath = join(homeDir, 'cache', 'update.json');
  const runtimePkgJson = join(runtimeDir, 'node_modules', '@happier-dev', 'stack', 'package.json');
  const runtimeVersion = await readPackageJsonVersion(runtimePkgJson);
  const updateCache = await readJsonIfExists(updateCachePath, { defaultValue: null });

  const autostart = getDefaultAutostartPaths();
  const stackCtx = resolveStackContext({ env: process.env, autostart });
  const stackMode = stackCtx.stackMode;

  const serverPort = resolveServerPortFromEnv({ defaultPort: 3005 });
  const resolvedUrls = await resolveServerUrls({ serverPort, allowEnable: false });
  const internalServerUrl = resolvedUrls.internalServerUrl;
  const publicServerUrl = resolvedUrls.publicServerUrl;

  const cliHomeDir = process.env.HAPPIER_STACK_CLI_HOME_DIR?.trim()
    ? process.env.HAPPIER_STACK_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(autostart.baseDir, 'cli');

  const serveUi = (process.env.HAPPIER_STACK_SERVE_UI ?? '1') !== '0';
  const uiBuildDir = process.env.HAPPIER_STACK_UI_BUILD_DIR?.trim()
    ? process.env.HAPPIER_STACK_UI_BUILD_DIR.trim()
    : join(autostart.baseDir, 'ui');

  const serverComponentName = getServerComponentName({ kv: argsKv });
  if (serverComponentName === 'both') {
    throw new Error(`[doctor] --server=both is not supported (pick one: happy-server-light or happy-server)`);
  }

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });

  const report = {
    paths: {
      rootDir,
      homeDir,
      runtimeDir,
      workspaceDir,
      updateCachePath,
    },
    runtime: {
      installed: Boolean(runtimeVersion),
      version: runtimeVersion,
      packageJson: runtimePkgJson,
      updateCache,
    },
    env: {
      homeEnv: join(homeDir, '.env'),
      homeLocal: join(homeDir, 'env.local'),
      mainStackEnv: resolveStackEnvPath('main').envPath,
      activeEnv: process.env.HAPPIER_STACK_ENV_FILE?.trim() || null,
    },
    internalServerUrl,
    publicServerUrl,
    serverComponentName,
    uiBuildDir,
    cliHomeDir,
    checks: {},
  };
  if (!json) {
    console.log('');
    console.log(banner('hstack doctor', { subtitle: 'Diagnose common local setup failure modes.' }));
    console.log('');
    console.log(sectionTitle('Details'));
    console.log(bullets([
      kv('internal:', cyan(internalServerUrl)),
      kv('public:', publicServerUrl ? cyan(publicServerUrl) : dim('(none)')),
      kv('server:', cyan(serverComponentName)),
      kv('uiBuild:', uiBuildDir),
      kv('cliHome:', cliHomeDir),
      kv('home:', homeDir),
      kv('runtime:', runtimeVersion ? `${runtimeDir} (${runtimeVersion})` : `${runtimeDir} (${yellow('not installed')})`),
      kv('workspace:', workspaceDir),
    ]));
    console.log('');
    console.log(sectionTitle('Checks'));
  }

  if (!(await pathExists(serverDir))) {
    report.checks.serverDir = { ok: false, missing: serverDir };
    if (!json) console.log(`${red('x')} missing component: ${serverDir}`);
  }
  if (!(await pathExists(cliDir))) {
    report.checks.cliDir = { ok: false, missing: cliDir };
    if (!json) console.log(`${red('x')} missing component: ${cliDir}`);
  }

  // Server health / port conflicts
  const health = await fetchHealth(internalServerUrl);
  if (health.ok) {
    report.checks.serverHealth = { ok: true, status: health.status, body: health.body };
    if (!json) console.log(`${green('✓')} server health: ${health.status} ${health.body}`);
  } else {
    report.checks.serverHealth = { ok: false };
    if (!json) console.log(`${red('x')} server health: unreachable (${internalServerUrl})`);
    if (fix) {
      if (stackMode) {
        if (!json) {
          console.log(`${yellow('!')} fix skipped: refusing to kill unknown port listeners in stack mode.`);
          console.log(
            `${dim('Tip:')} use stack-safe controls instead: ${cmd(`hstack stack stop ${(process.env.HAPPIER_STACK_STACK ?? 'main').toString()} --aggressive`)}`
          );
        }
      } else {
        if (!json) console.log(`${yellow('!')} attempting fix: freeing tcp:${serverPort}`);
        await killPortListeners(serverPort, { label: 'doctor' });
      }
    }
  }

  // UI build dir check
  if (serveUi) {
    if (await pathExists(uiBuildDir)) {
      report.checks.uiBuildDir = { ok: true, path: uiBuildDir };
      if (!json) console.log(`${green('✓')} ui build dir present`);
    } else {
      report.checks.uiBuildDir = { ok: false, missing: uiBuildDir };
      if (!json) console.log(`${red('x')} ui build dir missing (${uiBuildDir}) → run: ${cmd('hstack build')}`);
    }
  } else {
    report.checks.uiServing = { ok: false, reason: 'disabled (HAPPIER_STACK_SERVE_UI=0)' };
    if (!json) console.log(`${dim('ℹ')} ui serving disabled (HAPPIER_STACK_SERVE_UI=0)`);
  }

  // Daemon status
  try {
    const out = await daemonStatusSummary({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
    });
    const line = out.split('\n').find((l) => l.includes('Daemon is running'))?.trim();
    report.checks.daemon = { ok: true, line: line || null };
    if (!json) console.log(`${green('✓')} daemon: ${line ? line : 'status ok'}`);
  } catch (e) {
    const accessKeyPath = join(cliHomeDir, 'access.key');
    const hasAccessKey = existsSync(accessKeyPath);
    report.checks.daemon = { ok: false, hasAccessKey, accessKeyPath };
    if (!json) {
      console.log(`${red('x')} daemon: not running / status failed`);
      if (!hasAccessKey) {
        const stackName = (process.env.HAPPIER_STACK_STACK ?? '').trim() || 'main';
        console.log(`  ${dim('↪ likely cause:')} missing credentials at ${accessKeyPath}`);
        console.log(`  ${dim('↪ fix:')} authenticate for this stack:`);
        console.log(`    ${cmd(stackName === 'main' ? 'hstack auth login' : `hstack stack auth ${stackName} login`)}`);
      }
    }
  }

  // Tailscale Serve status (best-effort)
  try {
    const status = await tailscaleServeStatus();
    const httpsLine = status.split('\n').find((l) => l.toLowerCase().includes('https://'))?.trim();
    report.checks.tailscaleServe = { ok: true, httpsLine: httpsLine || null };
    if (!json) console.log(`${green('✓')} tailscale serve: ${httpsLine ? httpsLine : 'configured'}`);
  } catch {
    report.checks.tailscaleServe = { ok: false };
    if (!json) console.log(`${dim('ℹ')} tailscale serve: unavailable (tailscale not installed / not running)`);
  }

  // macOS LaunchAgent status
  if (process.platform === 'darwin') {
    try {
      const list = await runCapture('launchctl', ['list']);
      const { label } = getDefaultAutostartPaths();
      const line = list.split('\n').find((l) => l.includes(label))?.trim() || null;
      report.checks.launchd = { ok: true, line: line || null };
      if (!json) console.log(`${green('✓')} launchd: ${line ? line : 'not loaded'}`);
    } catch {
      report.checks.launchd = { ok: false };
      if (!json) console.log(`${dim('ℹ')} launchd: unable to query`);
    }
  }

  // SwiftBar plugin status (macOS)
  if (process.platform === 'darwin') {
    const swift = await detectSwiftbarPluginInstalled();
    report.checks.swiftbar = { ok: true, pluginsDir: swift.pluginsDir, pluginInstalled: swift.installed };
    if (!json) {
      console.log(`${green('✓')} swiftbar: ${swift.installed ? 'plugin installed' : 'not installed'}`);
    }
  }

  // happy wrapper (CLI binary)
  try {
    const happyPath = await resolveCommandPath('happy');
    if (happyPath) {
      report.checks.happyOnPath = { ok: true, path: happyPath };
      if (!json) console.log(`${green('✓')} happy on PATH: ${happyPath}`);
    }
  } catch {
    report.checks.happyOnPath = { ok: false };
    if (!json) console.log(`${dim('ℹ')} happy on PATH: not found (run: ${cmd('hstack init --install-path')})`);
  }

  // hstack on PATH
  try {
    const happysPath = await resolveCommandPath('hstack');
    if (happysPath) {
      report.checks.happysOnPath = { ok: true, path: happysPath };
      if (!json) console.log(`${green('✓')} hstack on PATH: ${happysPath}`);
    }
  } catch {
    report.checks.happysOnPath = { ok: false };
    if (!json) console.log(`${dim('ℹ')} hstack on PATH: not found (run: ${cmd('hstack init --install-path')})`);
  }

  if (!json) {
    if (!runtimeVersion) {
      console.log('');
      console.log(sectionTitle('Tips'));
      console.log(`- ${cmd('hstack self update')} ${dim('(install a stable runtime; recommended for SwiftBar/services)')}`);
    }
    if (!report.checks.happysOnPath?.ok) {
      console.log(`- Add shims to PATH: ${cmd(`export PATH="${join(getHappyStacksHomeDir(), 'bin')}:$PATH"`)} ${dim(`(or: ${cmd('hstack init --install-path')})`)}`);
    }
    console.log('');
  }

  if (json) {
    printResult({ json, data: report });
  }
}

main().catch((err) => {
  console.error('[doctor] failed:', err);
  process.exit(1);
});
