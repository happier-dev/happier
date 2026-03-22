import { spawnSync } from 'node:child_process';

import { sanitizeDefinedEnv } from './test_env.mjs';

export function buildNodeTestArgs(testFiles, { serial = false } = {}) {
  const args = ['--test'];
  if (serial) args.push('--test-concurrency=1');
  args.push(...testFiles);
  return args;
}

export function runCommandSync(command, args, {
  cwd,
  env = process.env,
  stdio = 'inherit',
  encoding,
  timeout,
  sanitizeEnv = true,
} = {}) {
  return spawnSync(command, args, {
    cwd,
    env: sanitizeEnv ? sanitizeDefinedEnv(env) : env,
    stdio,
    encoding,
    timeout,
  });
}

export function runNodeTestFilesSync(testFiles, {
  cwd,
  env = process.env,
  serial = false,
  stdio = 'inherit',
} = {}) {
  const args = buildNodeTestArgs(testFiles, { serial });
  return runCommandSync(process.execPath, args, { cwd, env, stdio });
}
