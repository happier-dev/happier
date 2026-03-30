import { spawn, spawnSync } from 'node:child_process';

import { sanitizeDefinedEnv } from '../../utils/test/test_env.mjs';

export function runCommandCapture(command, args, {
  cwd,
  env = process.env,
  input,
  stdio = ['ignore', 'pipe', 'pipe'],
  sanitizeEnv = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const usePipeInput = input != null;
    const child = spawn(command, args, {
      cwd,
      env: sanitizeEnv ? sanitizeDefinedEnv(env) : env,
      stdio: [usePipeInput ? 'pipe' : stdio[0], stdio[1], stdio[2]],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr,
      });
    });

    if (usePipeInput) {
      child.stdin?.write(String(input));
      child.stdin?.end();
    }
  });
}

export function runNodeCapture(args, options = {}) {
  return runCommandCapture(process.execPath, args, options);
}

export function runCommandCaptureSync(command, args, {
  cwd,
  env = process.env,
  encoding = 'utf-8',
  timeout,
  sanitizeEnv = true,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: sanitizeEnv ? sanitizeDefinedEnv(env) : env,
    encoding,
    timeout,
  });
  if (result.error) throw result.error;
  return result;
}

export function runNodeCaptureSync(args, options = {}) {
  return runCommandCaptureSync(process.execPath, args, options);
}
