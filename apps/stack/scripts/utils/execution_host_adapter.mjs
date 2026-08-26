import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const defaultFileOps = { existsSync, readFileSync };

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

export function resolveExecutionHostController({
  env = process.env,
  platform = process.platform,
  fileOps = defaultFileOps,
} = {}) {
  if (platform !== 'darwin' || String(env.HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY ?? '').trim() === '1') {
    return null;
  }
  const stackHome = String(env.HAPPIER_STACK_HOME_DIR ?? '').trim() || join(homedir(), '.happier-stack');
  const profilePath = join(stackHome, 'execution-host.json');
  if (!fileOps.existsSync(profilePath)) return null;
  try {
    const profile = JSON.parse(fileOps.readFileSync(profilePath, 'utf8'));
    const controller = String(profile?.controllerEntrypoint ?? '').trim();
    if (!controller) return null;
    if (profile?.version !== 2 || !isAbsolute(controller) || /[\0\r\n]/.test(controller)) {
      throw new Error('invalid controllerEntrypoint');
    }
    return controller;
  } catch (error) {
    throw new Error(`[repo-local] failed to read execution-host controller: ${String(error?.message ?? error)}`);
  }
}

export async function runExecutionHostAdapter({
  controllerEntrypoint,
  localEntrypoint,
  argv,
  cwd,
  env,
  boundary = defaultBoundary(),
}) {
  const child = boundary.spawn(process.execPath, [
    controllerEntrypoint,
    '--workspace-id=0.2',
    `--local-entrypoint=${localEntrypoint}`,
    '--',
    ...argv,
  ], {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
  });
  const removeSignalHandlers = boundary.onSignal((signal) => {
    try {
      child.kill(signal);
    } catch {
      // The controller may already have reached its terminal state.
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
