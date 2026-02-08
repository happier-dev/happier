import './utils/env/env.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir, getSystemdUnitInfo, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { getInternalServerUrl, getPublicServerUrlEnvOverride } from './utils/server/urls.mjs';
import { ensureMacAutostartDisabled, ensureMacAutostartEnabled } from './utils/service/autostart_darwin.mjs';
import { getCanonicalHomeDir } from './utils/env/config.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readLastLines } from './utils/fs/tail.mjs';
import { banner, bullets, cmd as cmdFmt, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import {
  findExistingStackCredentialPath,
  resolvePreferredStackDaemonStatePaths,
  resolveStackCredentialPaths,
} from './utils/auth/credentials_paths.mjs';

/**
 * Manage the autostart service installed by `hstack bootstrap -- --autostart`.
 *
 * - macOS: launchd LaunchAgents
 * - Linux: systemd user services (default) or system services (--mode=system)
 *
 * Commands:
 * - install | uninstall
 * - status
 * - start | stop | restart
 * - enable | disable (same as start/stop but explicitly persistent)
 * - logs (print last N lines)
 * - tail (follow logs)
 */

function getUid() {
  // Prefer env var if present; otherwise fall back.
  // (LaunchAgents run in a user context so this is fine.)
  const n = Number(process.env.UID);
  return Number.isFinite(n) ? n : null;
}

function getAutostartEnv({ rootDir, mode }) {
  // IMPORTANT:
  // LaunchAgents should NOT bake the entire config into the plist, because that would require
  // reinstalling the service for any config change (server flavor, worktrees, ports, etc).
  //
  // Instead, persist only the env file path; `scripts/utils/env.mjs` will load it on every start.
  //
  // Stack installs:
  // - `hstack stack service <name> ...` runs under a stack env already, so we persist that pointer.
  //
  // Main installs:
  // - default to the main stack env (outside the repo): ~/.happier/stacks/main/env

  const stacksEnvFile = process.env.HAPPIER_STACK_ENV_FILE?.trim() ? process.env.HAPPIER_STACK_ENV_FILE.trim() : '';
  const envFileRaw = stacksEnvFile || resolveStackEnvPath('main').envPath;

  // For system services, prefer a dynamic %h-based default when no explicit env file is set.
  // This avoids accidentally pinning root's stack env when the service will run as another user.
  const envFile =
    mode === 'system' && !stacksEnvFile
      ? '%h/.happier/stacks/main/env'
      : envFileRaw;

  return {
    HAPPIER_STACK_ENV_FILE: envFile,
  };
}

function resolveServiceMode(argv) {
  if (argv.includes('--system')) return 'system';
  if (argv.includes('--user')) return 'user';
  const raw = argv.find((a) => a.startsWith('--mode=')) ?? '';
  const v = raw ? raw.slice('--mode='.length).trim().toLowerCase() : '';
  return v === 'system' ? 'system' : 'user';
}

function resolveSystemUser(argv) {
  const raw = argv.find((a) => a.startsWith('--system-user=')) ?? '';
  const v = raw ? raw.slice('--system-user='.length).trim() : '';
  return v || null;
}

async function resolveHomeDirForUser(user) {
  const u = String(user ?? '').trim();
  if (!u) return null;
  try {
    const out = await runCapture('getent', ['passwd', u]);
    const line = out.trim().split('\n')[0] ?? '';
    const parts = line.split(':');
    const home = parts[5] ? parts[5].trim() : '';
    return home || null;
  } catch {
    // best-effort fallback
    return `/home/${u}`;
  }
}

function ensureLinuxSystemModeSupported({ mode }) {
  if (mode !== 'system') return;
  if (process.platform !== 'linux') {
    throw new Error(`[local] --mode=system is only supported on Linux.`);
  }
}

export async function installService({ mode = 'user', systemUser = null } = {}) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    throw new Error(
      '[local] service install is disabled in sandbox mode.\n' +
        'Reason: services are global OS state (launchd/systemd) and can affect your real installation.\n' +
        'If you really want this, set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1'
    );
  }
  ensureLinuxSystemModeSupported({ mode });
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('[local] service install is only supported on macOS (launchd) and Linux (systemd).');
  }
  const rootDir = getRootDir(import.meta.url);
  const { label } = getDefaultAutostartPaths();
  const env = getAutostartEnv({ rootDir, mode });
  // Ensure the env file exists so the service never points at a missing path.
  try {
    const envFile = env.HAPPIER_STACK_ENV_FILE;
    // systemd specifier paths like %h/... are resolved at runtime; don't try to create them here.
    if (!envFile.includes('%')) {
      await mkdir(dirname(envFile), { recursive: true });
      if (!existsSync(envFile)) {
        await writeFile(envFile, '', { flag: 'a' });
      }
    }
  } catch {
    // ignore
  }
  if (process.platform === 'darwin') {
    await ensureMacAutostartEnabled({ rootDir, label, env });
    console.log(`${green('✓')} service installed ${dim('(macOS launchd)')}`);
    return;
  }
  if (mode === 'system') {
    await ensureSystemdSystemServiceEnabled({ rootDir, label, env, systemUser });
    console.log(`${green('✓')} service installed ${dim('(Linux systemd system)')}`);
    return;
  }
  await ensureSystemdUserServiceEnabled({ rootDir, label, env });
  console.log(`${green('✓')} service installed ${dim('(Linux systemd --user)')}`);
}

export async function uninstallService({ mode = 'user' } = {}) {
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    // Sandbox cleanups should be safe and should not touch global services by default.
    return;
  }
  ensureLinuxSystemModeSupported({ mode });
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;

  if (process.platform === 'linux') {
    if (mode === 'system') {
      await ensureSystemdSystemServiceDisabled({ remove: true });
      console.log(`${green('✓')} service uninstalled ${dim('(systemd system unit removed)')}`);
      return;
    }
    await ensureSystemdUserServiceDisabled({ remove: true });
    console.log(`${green('✓')} service uninstalled ${dim('(systemd user unit removed)')}`);
    return;
  }
  const { plistPath, label } = getDefaultAutostartPaths();

  await ensureMacAutostartDisabled({ label });
  try {
    await rm(plistPath, { force: true });
  } catch {
    // ignore
  }
  console.log(`${green('✓')} service uninstalled ${dim('(plist removed)')}`);
}

function systemdUnitName() {
  const { label } = getDefaultAutostartPaths();
  return `${label}.service`;
}

function systemdUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', systemdUnitName());
}

function systemdEnvLines(env) {
  return Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${String(v)}`)
    .join('\n');
}

async function ensureSystemdUserServiceEnabled({ rootDir, label, env }) {
  const unitPath = systemdUnitPath();
  await mkdir(dirname(unitPath), { recursive: true });
  const hstackShim = join(getCanonicalHomeDir(), 'bin', 'hstack');
  const entry = existsSync(hstackShim) ? hstackShim : join(rootDir, 'bin', 'hstack.mjs');
  const exec = existsSync(hstackShim) ? entry : `${process.execPath} ${entry}`;

  const unit = `[Unit]
Description=Happier Stack (${label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
${systemdEnvLines(env)}
ExecStart=${exec} start
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;

  await writeFile(unitPath, unit, 'utf-8');
  await runCapture('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  await run('systemctl', ['--user', 'enable', '--now', systemdUnitName()]);
}

async function ensureSystemdSystemServiceEnabled({ rootDir, label, env, systemUser }) {
  const { unitName, unitPath } = getSystemdUnitInfo({ mode: 'system' });
  let userLine = '';
  let hstackShim = join(getCanonicalHomeDir(), 'bin', 'hstack');
  if (systemUser) {
    const home = await resolveHomeDirForUser(systemUser);
    if (home) {
      hstackShim = join(home, '.happier-stack', 'bin', 'hstack');
    }
    userLine = `User=${systemUser}\n`;
  }

  const entry = existsSync(hstackShim) ? hstackShim : join(rootDir, 'bin', 'hstack.mjs');
  const exec = existsSync(hstackShim) ? entry : `${process.execPath} ${entry}`;

  const unit = `[Unit]
Description=Happier Stack (${label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}WorkingDirectory=%h
${systemdEnvLines(env)}
ExecStart=${exec} start
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

  try {
    await writeFile(unitPath, unit, 'utf-8');
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`[local] --mode=system requires root (run with sudo).`);
    }
    throw e;
  }
  await runCapture('systemctl', ['daemon-reload']).catch(() => {});
  await run('systemctl', ['enable', '--now', unitName]);
}

async function ensureSystemdUserServiceDisabled({ remove } = {}) {
  await runCapture('systemctl', ['--user', 'disable', '--now', systemdUnitName()]).catch(() => {});
  await runCapture('systemctl', ['--user', 'stop', systemdUnitName()]).catch(() => {});
  if (remove) {
    await rm(systemdUnitPath(), { force: true }).catch(() => {});
    await runCapture('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  }
}

async function ensureSystemdSystemServiceDisabled({ remove } = {}) {
  const { unitName, unitPath } = getSystemdUnitInfo({ mode: 'system' });
  await runCapture('systemctl', ['disable', '--now', unitName]).catch(() => {});
  await runCapture('systemctl', ['stop', unitName]).catch(() => {});
  if (remove) {
    await rm(unitPath, { force: true }).catch(() => {});
    await runCapture('systemctl', ['daemon-reload']).catch(() => {});
  }
}

async function systemdStatus() {
  await run('systemctl', ['--user', 'status', systemdUnitName(), '--no-pager']);
}

async function systemdStart({ persistent }) {
  if (persistent) {
    await run('systemctl', ['--user', 'enable', '--now', systemdUnitName()]);
  } else {
    await run('systemctl', ['--user', 'start', systemdUnitName()]);
  }
}

async function systemdStop({ persistent }) {
  if (persistent) {
    await run('systemctl', ['--user', 'disable', '--now', systemdUnitName()]);
  } else {
    await run('systemctl', ['--user', 'stop', systemdUnitName()]);
  }
}

async function systemdRestart() {
  await run('systemctl', ['--user', 'restart', systemdUnitName()]);
}

async function systemdLogs({ lines = 120 } = {}) {
  await run('journalctl', ['--user', '-u', systemdUnitName(), '-n', String(lines), '--no-pager']);
}

async function systemdTail() {
  await run('journalctl', ['--user', '-u', systemdUnitName(), '-f']);
}

async function launchctlTry(args) {
  try {
    await runCapture('launchctl', args);
    return true;
  } catch {
    return false;
  }
}

async function restartLaunchAgentBestEffort() {
  const { plistPath, label } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: hstack service:install (or hstack bootstrap -- --autostart)`);
  }
  const uid = getUid();
  if (uid == null) {
    return false;
  }
  // Prefer kickstart -k to avoid overlapping stop/start windows (which can stop a freshly started daemon).
  return await launchctlTry(['kickstart', '-k', `gui/${uid}/${label}`]);
}

async function startLaunchAgent({ persistent }) {
  const { plistPath } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: hstack service:install (or hstack bootstrap -- --autostart)`);
  }

  const { label } = getDefaultAutostartPaths();

  // Old-style (works on many systems)
  if (persistent) {
    if (await launchctlTry(['load', '-w', plistPath])) {
      return;
    }
  } else {
    if (await launchctlTry(['load', plistPath])) {
      return;
    }
  }

  // Modern fallback (more reliable on newer macOS)
  const uid = getUid();
  if (uid == null) {
    throw new Error('[local] Unable to determine UID for launchctl bootstrap.');
  }

  // bootstrap requires the plist
  await run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  await launchctlTry(['enable', `gui/${uid}/${label}`]);
  await launchctlTry(['kickstart', '-k', `gui/${uid}/${label}`]);
}

async function postStartDiagnostics() {
  const rootDir = getRootDir(import.meta.url);
  const internalUrl = getInternalServerUrl({ env: process.env, defaultPort: 3005 }).internalServerUrl;

  const cliHomeDir = process.env.HAPPIER_STACK_CLI_HOME_DIR?.trim()
    ? expandHome(process.env.HAPPIER_STACK_CLI_HOME_DIR.trim())
    : join(getDefaultAutostartPaths().baseDir, 'cli');

  let port = 3005;
  try {
    port = Number(new URL(internalUrl).port || 0) || 3005;
  } catch {
    port = 3005;
  }
  const { publicServerUrl: publicUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort: port });

  const cliDir = getComponentDir(rootDir, 'happier-cli');
  const cliBin = join(cliDir, 'bin', 'happier.mjs');

  const credentialPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl: internalUrl });
  const existingCredentialPath = findExistingStackCredentialPath({ cliHomeDir, serverUrl: internalUrl });
  const accessKey = existingCredentialPath || credentialPaths.serverScopedPath;
  const daemonPaths = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalUrl });
  const stateFile = daemonPaths.statePath;
  const lockFile = daemonPaths.lockPath;
  const logsDir = join(cliHomeDir, 'logs');

  const latestDaemonLog = async () => {
    try {
      const ls = await runCapture('bash', ['-lc', `ls -1t "${logsDir}"/*-daemon.log 2>/dev/null | head -1 || true`]);
      const p = ls.trim();
      return p || null;
    } catch {
      return null;
    }
  };

  const checkOnce = async () => {
    // If state exists, trust it.
    if (existsSync(stateFile)) {
      try {
        const raw = await readFile(stateFile, 'utf-8');
        const s = JSON.parse(raw);
        const pid = Number(s?.pid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return { ok: true, kind: 'running', pid };
          } catch {
            return { ok: false, kind: 'stale_state', pid };
          }
        }
      } catch {
        return { ok: false, kind: 'bad_state' };
      }
    }

    // No state yet: check lock PID (daemon may be starting or waiting for auth).
    if (existsSync(lockFile)) {
      try {
        const raw = (await readFile(lockFile, 'utf-8')).trim();
        const pid = Number(raw);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            const logPath = await latestDaemonLog();
            const tail = logPath ? await readLastLines(logPath, 120) : null;
            if (tail && (tail.includes('No credentials found') || tail.includes('authentication flow') || tail.includes('Waiting for credentials'))) {
              return { ok: false, kind: 'auth_required', pid, logPath };
            }
            return { ok: false, kind: 'starting', pid, logPath };
          } catch {
            return { ok: false, kind: 'stale_lock', pid };
          }
        }
      } catch {
        // ignore
      }
    }

    return { ok: false, kind: 'stopped' };
  };

  // Wait briefly for the daemon to settle after a restart.
  let res = await checkOnce();
  for (let i = 0; i < 12 && !res.ok; i++) {
    if (res.kind === 'auth_required') {
      break;
    }
    await new Promise((r) => setTimeout(r, 650));
    // eslint-disable-next-line no-await-in-loop
    res = await checkOnce();
    if (res.ok) {
      break;
    }
  }

  const stackName = getDefaultAutostartPaths().stackName;
  console.log('');
  console.log(banner('service', { subtitle: `Post-start diagnostics (${stackName})` }));
  console.log('');

  const authCmd = stackName === 'main' ? 'hstack auth login' : `hstack stack auth ${stackName} login`;

  if (res.ok && res.kind === 'running') {
    console.log(sectionTitle('Daemon'));
    console.log(bullets([`${green('✓')} running ${dim(`(pid=${res.pid})`)}`, kv('server:', internalUrl)]));
    return;
  }

  console.log(sectionTitle('Daemon'));
  if (res.kind === 'starting') {
    console.log(bullets([`${yellow('!')} starting ${dim(`(pid=${res.pid ?? 'unknown'})`)}`]));
  } else if (!existingCredentialPath) {
    console.log(bullets([`${yellow('!')} auth required ${dim(`(missing ${accessKey})`)}`]));
    console.log('');
    console.log(sectionTitle('Authenticate'));
    console.log(bullets([`${dim('run:')} ${cmdFmt(authCmd)}`]));
  } else if (res.kind === 'auth_required') {
    console.log(bullets([`${yellow('!')} waiting for auth ${dim(`(pid=${res.pid ?? 'unknown'})`)}`]));
    console.log('');
    console.log(sectionTitle('Authenticate'));
    console.log(bullets([`${dim('run:')} ${cmdFmt(authCmd)}`]));
  } else {
    console.log(bullets([`${yellow('!')} not running`]));
  }

  const logPath = res.logPath ? res.logPath : await latestDaemonLog();
  console.log('');
  console.log(sectionTitle('Logs'));
  if (logPath) {
    console.log(bullets([kv('latest:', logPath), `${dim('tail:')} ${cmdFmt(`hstack service logs`)}`]));
    const tail = await readLastLines(logPath, 80);
    if (tail) {
      console.log('');
      console.log(dim('--- last 80 daemon log lines ---'));
      console.log(tail);
      console.log(dim('--- end ---'));
    }
  } else {
    console.log(bullets([kv('dir:', logsDir)]));
  }
}

async function stopLaunchAgent({ persistent }) {
  const { plistPath } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    // Service isn't installed for this stack (common for ad-hoc stacks). Treat as a no-op.
    return;
  }

  const { label } = getDefaultAutostartPaths();

  // Old-style
  if (persistent) {
    if (await launchctlTry(['unload', '-w', plistPath])) {
      return;
    }
  } else {
    if (await launchctlTry(['unload', plistPath])) {
      return;
    }
  }

  // Modern fallback
  const uid = getUid();
  if (uid == null) {
    return;
  }
  await launchctlTry(['bootout', `gui/${uid}/${label}`]);
}

async function waitForLaunchAgentStopped({ timeoutMs = 8000 } = {}) {
  const { label } = getDefaultAutostartPaths();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await runCapture('launchctl', ['list']);
      const still = list.split('\n').some((l) => l.includes(`\t${label}`) || l.trim().endsWith(` ${label}`) || l.trim() === label);
      if (!still) {
        return true;
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function showStatus() {
  const { plistPath, stdoutPath, stderrPath, label } = getDefaultAutostartPaths();
  const internalUrl = getInternalServerUrl({ env: process.env, defaultPort: 3005 }).internalServerUrl;

  console.log('');
  console.log(banner('service', { subtitle: 'Autostart (launchd/systemd user).' }));
  console.log('');
  console.log(sectionTitle('LaunchAgent (macOS)'));
  console.log(
    bullets([
      kv('label:', cyan(label)),
      kv('plist:', `${plistPath} ${existsSync(plistPath) ? green('(present)') : yellow('(missing)')}`),
      kv('stdout:', stdoutPath),
      kv('stderr:', stderrPath),
    ])
  );

  try {
    const list = await runCapture('launchctl', ['list']);
    const line = list
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.endsWith(` ${label}`) || l === label || l.includes(`\t${label}`));
    console.log(`${dim('launchctl:')} ${line ? line : dim('(not listed)')}`);
  } catch {
    console.log(`${dim('launchctl:')} ${dim('(unable to query)')}`);
  }

  // Health can briefly be unavailable right after install/restart; retry a bit.
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const res = await fetch(`${internalUrl}/health`, { method: 'GET' });
      const body = await res.text();
      console.log(`${dim('health:')} ${res.ok ? green(String(res.status)) : yellow(String(res.status))} ${dim(body.trim())}`);
      break;
    } catch {
      if (Date.now() >= deadline) {
        console.log(`${dim('health:')} ${yellow('unreachable')} ${dim('(')}${cyan(internalUrl)}${dim(')')}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log('');
  console.log(sectionTitle('Tips'));
  console.log(bullets([`${dim('Show status:')} ${cmdFmt('hstack service status')}`, `${dim('View logs:')} ${cmdFmt('hstack service logs')}`]));
}

async function showLogs(lines = 120) {
  const { stdoutPath, stderrPath } = getDefaultAutostartPaths();
  // Use tail if available.
  await run('tail', ['-n', String(lines), stderrPath, stdoutPath]);
}

async function tailLogs() {
  const { stdoutPath, stderrPath } = getDefaultAutostartPaths();
  const child = spawn('tail', ['-f', stderrPath, stdoutPath], { stdio: 'inherit' });
  await new Promise((resolve) => child.on('exit', resolve));
}

async function main() {
  const argv = process.argv.slice(2);
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const mode = resolveServiceMode(helpScopeArgv);
  const systemUser = resolveSystemUser(helpScopeArgv);
  ensureLinuxSystemModeSupported({ mode });

  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('[local] service commands are only supported on macOS (launchd) and Linux (systemd).');
  }
  const positionals = helpScopeArgv.filter((a) => a && a !== '--' && !a.startsWith('-'));
  const cmd = positionals[0] ?? 'help';
  const json = wantsJson(helpScopeArgv);

  const wantsHelpFlag = wantsHelp(helpScopeArgv);
  const usageByCmd = new Map([
    ['install', 'hstack service install [--json]'],
    ['uninstall', 'hstack service uninstall [--json]'],
    ['status', 'hstack service status [--json]'],
    ['start', 'hstack service start [--json]'],
    ['stop', 'hstack service stop [--json]'],
    ['restart', 'hstack service restart [--json]'],
    ['enable', 'hstack service enable [--json]'],
    ['disable', 'hstack service disable [--json]'],
    ['logs', 'hstack service logs [--json]'],
    ['tail', 'hstack service tail'],
  ]);

  if (wantsHelpFlag && cmd !== 'help') {
    const usage = usageByCmd.get(cmd);
    if (usage) {
      printResult({
        json,
        data: { ok: true, cmd, usage },
        text: [`[service ${cmd}] usage:`, `  ${usage}`, '', 'see also:', '  hstack service --help'].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs', 'tail'] },
      text: [
        banner('service', { subtitle: 'Autostart service management (launchd/systemd).' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack service')} install|uninstall [--mode=system|user] [--system-user=<name>] [--json]`,
        `  ${cyan('hstack service')} status [--mode=system|user] [--json]`,
        `  ${cyan('hstack service')} start|stop|restart [--mode=system|user] [--json]`,
        `  ${cyan('hstack service')} enable|disable [--mode=system|user] [--json]`,
        `  ${cyan('hstack service')} logs [--mode=system|user] [--json]`,
        `  ${cyan('hstack service')} tail`,
        '',
        sectionTitle('legacy aliases:'),
        bullets([
          dim('hstack service:install|uninstall|status|start|stop|restart|enable|disable'),
          dim('hstack logs | hstack logs:tail'),
        ]),
      ].join('\n'),
    });
    return;
  }
  switch (cmd) {
    case 'install':
      await installService({ mode, systemUser });
      if (json) printResult({ json, data: { ok: true, action: 'install' } });
      return;
    case 'uninstall':
      await uninstallService({ mode });
      if (json) printResult({ json, data: { ok: true, action: 'uninstall' } });
      return;
    case 'status':
      if (json) {
        const internalUrl = getInternalServerUrl({ env: process.env, defaultPort: 3005 }).internalServerUrl;
        let health = null;
        try {
          const res = await fetch(`${internalUrl}/health`, { method: 'GET' });
          const body = await res.text();
          health = { ok: res.ok, status: res.status, body: body.trim() };
        } catch {
          health = { ok: false, status: null, body: null };
        }

        if (process.platform === 'darwin') {
          const { plistPath, stdoutPath, stderrPath, label } = getDefaultAutostartPaths();
          let launchctlLine = null;
          try {
            const list = await runCapture('launchctl', ['list']);
            launchctlLine =
              list
                .split('\n')
                .map((l) => l.trim())
                .find((l) => l.endsWith(` ${label}`) || l === label || l.includes(`\t${label}`)) ?? null;
          } catch {
            launchctlLine = null;
          }
          printResult({ json, data: { label, plistPath, stdoutPath, stderrPath, internalUrl, launchctlLine, health } });
        } else {
          const { unitName, unitPath, systemctlArgsPrefix } = getSystemdUnitInfo({ mode });
          let systemctlStatus = null;
          try {
            systemctlStatus = await runCapture('systemctl', [...systemctlArgsPrefix, 'status', unitName, '--no-pager']);
          } catch (e) {
            systemctlStatus = e && typeof e === 'object' && 'out' in e ? e.out : null;
          }
          printResult({ json, data: { mode, unitName, unitPath, internalUrl, systemctlStatus, health } });
        }
      } else {
        if (process.platform === 'darwin') {
          await showStatus();
        } else {
          if (mode === 'system') {
            const { unitName, systemctlArgsPrefix } = getSystemdUnitInfo({ mode });
            await run('systemctl', [...systemctlArgsPrefix, 'status', unitName, '--no-pager']);
          } else {
            await systemdStatus();
          }
        }
      }
      return;
    case 'start':
      if (process.platform === 'darwin') {
        await startLaunchAgent({ persistent: false });
      } else {
        if (mode === 'system') {
          const { unitName } = getSystemdUnitInfo({ mode });
          await run('systemctl', ['start', unitName]);
        } else {
          await systemdStart({ persistent: false });
        }
      }
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'start' } });
      return;
    case 'stop':
      if (process.platform === 'darwin') {
        await stopLaunchAgent({ persistent: false });
      } else {
        if (mode === 'system') {
          const { unitName } = getSystemdUnitInfo({ mode });
          await run('systemctl', ['stop', unitName]);
        } else {
          await systemdStop({ persistent: false });
        }
      }
      if (json) printResult({ json, data: { ok: true, action: 'stop' } });
      return;
    case 'restart':
      if (process.platform === 'darwin') {
        if (!(await restartLaunchAgentBestEffort())) {
          await stopLaunchAgent({ persistent: false });
          await waitForLaunchAgentStopped();
          await startLaunchAgent({ persistent: false });
        }
      } else {
        if (mode === 'system') {
          const { unitName } = getSystemdUnitInfo({ mode });
          await run('systemctl', ['restart', unitName]);
        } else {
          await systemdRestart();
        }
      }
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'restart' } });
      return;
    case 'enable':
      if (process.platform === 'darwin') {
        await startLaunchAgent({ persistent: true });
      } else {
        if (mode === 'system') {
          const { unitName } = getSystemdUnitInfo({ mode });
          await run('systemctl', ['enable', '--now', unitName]);
        } else {
          await systemdStart({ persistent: true });
        }
      }
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'enable' } });
      return;
    case 'disable':
      if (process.platform === 'darwin') {
        await stopLaunchAgent({ persistent: true });
      } else {
        if (mode === 'system') {
          const { unitName } = getSystemdUnitInfo({ mode });
          await run('systemctl', ['disable', '--now', unitName]);
        } else {
          await systemdStop({ persistent: true });
        }
      }
      if (json) printResult({ json, data: { ok: true, action: 'disable' } });
      return;
    case 'logs':
      if (process.platform === 'darwin') {
        await showLogs();
      } else {
        const lines = Number(process.env.HAPPIER_STACK_LOG_LINES ?? 120) || 120;
        if (mode === 'system') {
          const { unitName, journalctlArgsPrefix } = getSystemdUnitInfo({ mode });
          await run('journalctl', [...journalctlArgsPrefix, '-u', unitName, '-n', String(lines), '--no-pager']);
        } else {
          await systemdLogs({ lines });
        }
      }
      return;
    case 'tail':
      if (process.platform === 'darwin') {
        await tailLogs();
      } else {
        if (mode === 'system') {
          const { unitName, journalctlArgsPrefix } = getSystemdUnitInfo({ mode });
          await run('journalctl', [...journalctlArgsPrefix, '-u', unitName, '-f']);
        } else {
          await systemdTail();
        }
      }
      return;
    default:
      throw new Error(`[local] unknown command: ${cmd}`);
  }
}

function isDirectExecution() {
  try {
    const selfPath = resolve(fileURLToPath(import.meta.url));
    const argvPath = process.argv[1] ? resolve(process.argv[1]) : '';
    return selfPath === argvPath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('[local] failed:', err);
    process.exit(1);
  });
}
