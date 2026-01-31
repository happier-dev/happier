import { runCapture } from './proc.mjs';
import { killPid } from '../expo/expo.mjs';

export async function getPsEnvLine(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  try {
    const out = await runCapture('ps', ['eww', '-p', String(n)]);
    // Output usually includes a header line and then a single process line.
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) return lines[1];
    if (lines.length === 1) return lines[0];
    return null;
  } catch {
    return null;
  }
}

export async function listPidsWithEnvNeedle(needle) {
  const n = String(needle ?? '').trim();
  if (!n) return [];
  if (process.platform === 'win32') return [];
  try {
    // Include environment variables (eww) so we can match on HAPPY_STACKS_ENV_FILE=/.../env safely.
    const out = await runCapture('ps', ['eww', '-ax', '-o', 'pid=,command=']);
    const pids = [];
    for (const line of out.split('\n')) {
      if (!line.includes(n)) continue;
      const m = line.trim().match(/^(\d+)\s+/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (Number.isFinite(pid) && pid > 1) {
        pids.push(pid);
      }
    }
    return Array.from(new Set(pids));
  } catch {
    return [];
  }
}

export async function getProcessGroupId(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  try {
    const out = await runCapture('ps', ['-o', 'pgid=', '-p', String(n)]);
    const raw = out.trim();
    const pgid = raw ? Number(raw) : NaN;
    return Number.isFinite(pgid) && pgid > 1 ? pgid : null;
  } catch {
    return null;
  }
}

export async function isPidOwnedByStack(pid, { stackName, envPath, cliHomeDir } = {}) {
  const line = await getPsEnvLine(pid);
  if (!line) return false;
  const sn = String(stackName ?? '').trim();
  const ep = String(envPath ?? '').trim();
  const ch = String(cliHomeDir ?? '').trim();

  // Require at least one stack identifier.
  const hasStack =
    (sn && (line.includes(`HAPPY_STACKS_STACK=${sn}`) || line.includes(`HAPPY_LOCAL_STACK=${sn}`))) ||
    (!sn && (line.includes('HAPPY_STACKS_STACK=') || line.includes('HAPPY_LOCAL_STACK=')));
  if (!hasStack) return false;

  // Prefer env-file binding (strongest).
  if (ep) {
    if (line.includes(`HAPPY_STACKS_ENV_FILE=${ep}`) || line.includes(`HAPPY_LOCAL_ENV_FILE=${ep}`)) {
      return true;
    }
  }

  // Fallback: CLI home dir binding (useful for daemon-related processes).
  if (ch) {
    if (line.includes(`HAPPY_HOME_DIR=${ch}`) || line.includes(`HAPPY_STACKS_CLI_HOME_DIR=${ch}`) || line.includes(`HAPPY_LOCAL_CLI_HOME_DIR=${ch}`)) {
      return true;
    }
  }

  return false;
}

export async function killPidOwnedByStack(pid, { stackName, envPath, cliHomeDir, label = 'process', json = false } = {}) {
  const ok = await isPidOwnedByStack(pid, { stackName, envPath, cliHomeDir });
  if (!ok) {
    if (!json) {
      // eslint-disable-next-line no-console
      console.warn(`[stack] refusing to kill ${label} pid=${pid} (cannot prove it belongs to stack ${stackName ?? ''})`);
    }
    return { killed: false, reason: 'not_owned' };
  }
  await killPid(pid);
  return { killed: true, reason: 'killed' };
}

export async function killProcessGroupOwnedByStack(
  pid,
  { stackName, envPath, cliHomeDir, label = 'process-group', json = false, signal = 'SIGTERM' } = {}
) {
  const ok = await isPidOwnedByStack(pid, { stackName, envPath, cliHomeDir });
  if (!ok) {
    if (!json) {
      // eslint-disable-next-line no-console
      console.warn(`[stack] refusing to kill ${label} pid=${pid} (cannot prove it belongs to stack ${stackName ?? ''})`);
    }
    return { killed: false, reason: 'not_owned' };
  }
  const pgid = await getProcessGroupId(pid);
  if (!pgid) {
    await killPid(pid);
    return { killed: true, reason: 'killed_pid_only' };
  }
  try {
    process.kill(-pgid, signal);
  } catch {
    // ignore
  }
  // Escalate if still alive.
  try {
    process.kill(pid, 0);
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // ignore
    }
  } catch {
    // exited
  }
  return { killed: true, reason: 'killed_pgid', pgid };
}

