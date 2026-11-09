import { spawnSync } from 'node:child_process';

import { sanitizeDefinedEnv } from './test_env.mjs';
import { runManagedChildCommand } from '../../../../../scripts/testing/process/managedChildLifecycle.mjs';
import { resolveWorkspaceBuildAdmissionInvocation } from '../proc/workspace_build_admission.mjs';

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

export async function runNodeTestFiles(testFiles, {
  cwd,
  env = process.env,
  serial = false,
  stdio = 'inherit',
  admission,
} = {}) {
  const payload = { command: process.execPath, args: buildNodeTestArgs(testFiles, { serial }) };
  const invocation = admission
    ? resolveWorkspaceBuildAdmissionInvocation({ ...admission, ...payload, env })
    : payload;
  return await runManagedChildCommand({
    ...invocation,
    // Remain in the test lane's group so remote custody can also cover abrupt
    // controller death. The managed child owner handles ordinary cancellation.
    spawnOptions: { cwd, env: sanitizeDefinedEnv(env), stdio, detached: false },
  });
}

export async function runStackTestFiles(testFiles, { admission, ...options } = {}) {
  return await runNodeTestFiles(testFiles, {
    ...options,
    serial: true,
    // Both complete Stack suites execute real server/daemon source bundles.
    // Reserve their existing source-bundle resource contract before the reader;
    // nested source builders can then reuse it even under contention.
    admission: { ...admission, admissionClass: 'source-bundle' },
  });
}
