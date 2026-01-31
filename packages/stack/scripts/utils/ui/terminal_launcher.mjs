import { commandExists } from '../proc/commands.mjs';
import { run } from '../proc/proc.mjs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function hasGuiSession(env = process.env) {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'linux') {
    const display = String(env.DISPLAY ?? '').trim();
    const wayland = String(env.WAYLAND_DISPLAY ?? '').trim();
    return Boolean(display || wayland);
  }
  return false;
}

async function pickLinuxTerminalCmd() {
  // Best-effort: pick the first terminal emulator we can find.
  const candidates = [
    'x-terminal-emulator', // Debian/Ubuntu alternatives
    'gnome-terminal',
    'konsole',
    'xfce4-terminal',
    'kitty',
    'wezterm',
    'alacritty',
    'xterm',
  ];
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await commandExists(c)) return c;
  }
  return '';
}

function linuxTerminalArgs(cmd, scriptPath) {
  // Keep this conservative and use `bash` explicitly.
  switch (cmd) {
    case 'gnome-terminal':
      return ['--', 'bash', scriptPath];
    case 'konsole':
      return ['-e', 'bash', scriptPath];
    case 'xfce4-terminal':
      return ['--disable-server', '--command', `bash "${scriptPath.replace(/"/g, '\\"')}"`];
    case 'wezterm':
      return ['start', '--', 'bash', scriptPath];
    case 'alacritty':
      return ['-e', 'bash', scriptPath];
    case 'kitty':
      return ['bash', scriptPath];
    case 'xterm':
      return ['-e', 'bash', scriptPath];
    case 'x-terminal-emulator':
      return ['-e', 'bash', scriptPath];
    default:
      return ['-e', 'bash', scriptPath];
  }
}

function escapeAppleScriptString(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

export async function canLaunchNewTerminal({ env } = {}) {
  const e = env ?? process.env;
  if (!hasGuiSession(e)) return { ok: false, reason: 'no GUI session detected' };
  if (process.platform === 'darwin') {
    const hasOsascript = await commandExists('osascript', { env: e });
    if (!hasOsascript) return { ok: false, reason: 'osascript not found' };
    return { ok: true, kind: 'darwin-terminal' };
  }
  if (process.platform === 'linux') {
    const term = await pickLinuxTerminalCmd();
    if (!term) return { ok: false, reason: 'no terminal emulator found' };
    return { ok: true, kind: 'linux-terminal', terminalCmd: term };
  }
  return { ok: false, reason: `unsupported platform: ${process.platform}` };
}

export async function launchScriptInNewTerminal({ scriptText, title, env } = {}) {
  const e = env ?? process.env;
  const support = await canLaunchNewTerminal({ env: e });
  if (!support.ok) return { ok: false, reason: support.reason };

  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-llm-'));
  const scriptPath = join(dir, 'run.sh');
  const text = [
    String(scriptText ?? '').trimEnd(),
    '',
    // Self-cleanup best-effort.
    'rm -f "$0" >/dev/null 2>&1 || true',
    'rmdir "$(dirname "$0")" >/dev/null 2>&1 || true',
    '',
  ].join('\n');

  await writeFile(scriptPath, text, 'utf-8');
  await chmod(scriptPath, 0o755);

  try {
    if (support.kind === 'darwin-terminal') {
      const banner = title ? `echo ${JSON.stringify(String(title))}; echo; ` : '';
      const cmd = `${banner}bash "${scriptPath}"`;
      const as = [
        'tell application "Terminal"',
        'activate',
        `do script "${escapeAppleScriptString(cmd)}"`,
        'end tell',
      ].join('\n');
      await run('osascript', ['-e', as], { env: e });
      return { ok: true, launched: true };
    }

    if (support.kind === 'linux-terminal') {
      const args = linuxTerminalArgs(support.terminalCmd, scriptPath);
      await run(support.terminalCmd, args, { env: e });
      return { ok: true, launched: true, terminalCmd: support.terminalCmd };
    }

    return { ok: false, reason: 'unknown terminal kind' };
  } catch (err) {
    // Cleanup, since the script didn't launch.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: String(err?.message ?? err ?? 'launch failed') };
  }
}

