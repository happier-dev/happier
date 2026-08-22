import { spawn } from 'node:child_process';

const RESCUE_CONTROL_NICE = -5;

async function runPrivilegedRenice({ pid, nice }) {
  return await new Promise((resolve, reject) => {
    const child = spawn('sudo', ['renice', '-n', String(nice), '-p', String(pid)], {
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      reject(new Error(
        `Could not enable TUI rescue priority (sudo renice exited code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      ));
    });
  });
}

export async function enableTuiRescuePriority(
  { pid = process.pid, platform = process.platform } = {},
  { runPrivilegedReniceImpl = runPrivilegedRenice } = {},
) {
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`TUI rescue priority is not supported on ${platform}`);
  }
  const normalizedPid = Number(pid);
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 1) {
    throw new Error(`TUI rescue priority requires a valid process id (received ${pid})`);
  }
  await runPrivilegedReniceImpl({ pid: normalizedPid, nice: RESCUE_CONTROL_NICE });
  return { nice: RESCUE_CONTROL_NICE, platform };
}
