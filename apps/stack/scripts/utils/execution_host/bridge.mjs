import { spawn } from 'node:child_process';
import { dirname, isAbsolute, posix, resolve } from 'node:path';

import { shouldDelegateToActiveExecutionHost } from './controller.mjs';
import { mapHostCwdToGuest, resolveHostWorkspaceMapping, runDelegatedHstackCommand } from './delegation.mjs';
import { runForegroundChild } from './foreground_child.mjs';

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

export async function runNativeExecutionHostBridge({
  profile, launcher, argv, cwd, env, platform = process.platform,
  prepare, boundary = defaultBoundary(),
}) {
  if (!isAbsolute(launcher) || /[\0\r\n]/.test(launcher)) {
    throw new Error('[execution-host] native launcher must be an absolute path');
  }
  // Delegate the launcher, not the payload's command vocabulary. The guest's
  // native dispatcher retains placement, admission, flags and script ownership.
  if (!shouldDelegateToActiveExecutionHost({ profile, argv: ['dev-targets'], platform, env })) {
    return await runForegroundChild({
      command: '/bin/sh', args: [launcher, ...argv],
      options: { cwd, env: { ...env, HAPPIER_STACK_EXECUTION_HOST_REENTRY: '1' }, stdio: 'inherit', shell: false },
      boundary,
    });
  }
  const repoRoot = resolve(dirname(launcher), '../../..');
  const guestRoot = profile.version === 2
    ? resolveHostWorkspaceMapping(profile, repoRoot).workspace.guestDir
    : mapHostCwdToGuest(profile, repoRoot);
  const guestArgv = [...argv];
  if (String(guestArgv[0] ?? '').startsWith('--repo=')) {
    guestArgv[0] = `--repo=${mapHostCwdToGuest(profile, guestArgv[0].slice('--repo='.length))}`;
  } else if (guestArgv[0] === '--repo') {
    guestArgv[1] = mapHostCwdToGuest(profile, guestArgv[1]);
  }
  return await runDelegatedHstackCommand({
    profile, argv: [], cwd, env, prepare, boundary,
    guestInvocation: {
      command: '/bin/sh',
      args: [posix.join(guestRoot, 'apps/stack/bin/hstack-exec'), ...guestArgv],
    },
  });
}

export async function runExecutionHostBridge({
  profile,
  workspaceId,
  localEntrypoint,
  argv,
  cwd,
  env,
  platform = process.platform,
  prepare,
  boundary = defaultBoundary(),
}) {
  const entrypoint = String(localEntrypoint ?? '').trim();
  if (!isAbsolute(entrypoint) || /[\0\r\n]/.test(entrypoint)) {
    throw new Error('[execution-host] local repo entrypoint must be an absolute path');
  }
  const shouldDelegate = shouldDelegateToActiveExecutionHost({ profile, argv, platform, env });
  if (!shouldDelegate) {
    const outcome = await runForegroundChild({
      command: process.execPath,
      args: [entrypoint, ...argv],
      options: {
        cwd,
        env: { ...env, HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY: '1' },
        stdio: 'inherit',
        shell: false,
      },
      boundary,
    });
    return { ...outcome, delegated: false };
  }

  const mapping = resolveHostWorkspaceMapping(profile, cwd);
  if (mapping.workspace.id !== workspaceId) {
    throw new Error(`[execution-host] host cwd does not belong to workspace ${workspaceId}`);
  }
  const guestEntrypoint = posix.join(
    mapping.workspace.guestDir,
    'apps', 'stack', 'scripts', 'repo_local.mjs',
  );
  const outcome = await runDelegatedHstackCommand({
    profile,
    argv,
    cwd,
    env,
    prepare,
    boundary,
    guestInvocation: { command: 'node', args: [guestEntrypoint] },
  });
  return { ...outcome, delegated: true };
}
