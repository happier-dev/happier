import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, posix } from 'node:path';

import { createManagedLimaHostExecutor } from '../managed_lima/host_executor.mjs';
import { startManagedLimaInstance } from '../managed_lima/lifecycle.mjs';
import { doctorManagedLimaInstance } from '../managed_lima/manager.mjs';

function defaultBoundary() {
  return {
    spawn(command, args, options) {
      return spawn(command, args, options);
    },
    onSignal(handler) {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of signals) process.on(signal, handler);
      return () => {
        for (const signal of signals) process.off(signal, handler);
      };
    },
  };
}

export function mapHostCwdToGuest(profile, hostCwd) {
  const mirror = resolve(profile.mirrorWorkspaceDir);
  const cwd = resolve(String(hostCwd ?? ''));
  const suffix = relative(mirror, cwd);
  const insideMirror = suffix === '' || (!suffix.startsWith(`..${posix.sep}`) && suffix !== '..' && !isAbsolute(suffix));
  return insideMirror
    ? posix.join(profile.guestWorkspaceDir, ...suffix.split('/').filter(Boolean))
    : profile.guestWorkspaceDir;
}

async function prepareManagedHost(profile) {
  const executor = createManagedLimaHostExecutor(
    { kind: 'local' },
    undefined,
    process.env,
    { hostEnvironment: { LIMA_HOME: profile.limaHome } },
  );
  await startManagedLimaInstance({ executor, instance: profile.instance });
  const diagnosis = await doctorManagedLimaInstance({
    executor,
    instance: profile.instance,
    profileName: profile.profile,
  });
  if (diagnosis.ok !== true) {
    throw new Error('[execution-host] managed Lima doctor reported drift; run `hstack host doctor` before execution');
  }
}

export async function runDelegatedHstackCommand({
  profile,
  argv,
  cwd = process.cwd(),
  env = process.env,
  prepare = prepareManagedHost,
  boundary = defaultBoundary(),
}) {
  await prepare(profile);
  const guestCwd = mapHostCwdToGuest(profile, cwd);
  const child = boundary.spawn('limactl', [
    'shell', '--workdir', guestCwd, profile.instance, '--',
    'env',
    'HAPPIER_STACK_EXECUTION_HOST_REENTRY=1',
    `HAPPIER_STACK_INVOKED_CWD=${guestCwd}`,
    'hstack', ...argv,
  ], {
    cwd,
    env: { ...env, LIMA_HOME: profile.limaHome },
    stdio: 'inherit',
    shell: false,
  });
  const removeSignalHandlers = boundary.onSignal((signal) => {
    try {
      child.kill(signal);
    } catch {
      // The delegated process may already have reached its terminal state.
    }
  });
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', (exitCode, signal) => resolvePromise({ exitCode, signal }));
    });
  } finally {
    removeSignalHandlers();
  }
}
