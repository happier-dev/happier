import { spawn } from 'node:child_process';

function toSpawnEnv(env, { sanitizeEnv = true } = {}) {
  if (!sanitizeEnv) return env;
  const cleanEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value == null) continue;
    cleanEnv[key] = String(value);
  }
  return cleanEnv;
}

export function runCommandCapture(command, args, { cwd, env = process.env, stdio = ['ignore', 'pipe', 'pipe'], sanitizeEnv = true } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: toSpawnEnv(env, { sanitizeEnv }), stdio });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += String(d)));
    proc.stderr?.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

export function runNodeCapture(args, options = {}) {
  return runCommandCapture(process.execPath, args, options);
}
