import { spawn } from 'node:child_process';
import { isAbsolute, posix } from 'node:path';

import { shouldDelegateToActiveExecutionHost } from './controller.mjs';
import { resolveHostWorkspaceMapping, runDelegatedHstackCommand } from './delegation.mjs';
import { startGhopsCredentialBroker } from './ghops_credential_broker.mjs';

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

async function waitForChild(child, boundary) {
  const removeSignalHandlers = boundary.onSignal((signal) => {
    try {
      child.kill(signal);
    } catch {
      // The bridged process may already have reached its terminal state.
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
  startCredentialBroker = startGhopsCredentialBroker,
}) {
  const entrypoint = String(localEntrypoint ?? '').trim();
  if (!isAbsolute(entrypoint) || /[\0\r\n]/.test(entrypoint)) {
    throw new Error('[execution-host] local repo entrypoint must be an absolute path');
  }
  const shouldDelegate = shouldDelegateToActiveExecutionHost({ profile, argv, platform, env });
  if (!shouldDelegate) {
    const child = boundary.spawn(process.execPath, [entrypoint, ...argv], {
      cwd,
      env: { ...env, HAPPIER_STACK_EXECUTION_HOST_ADAPTER_REENTRY: '1' },
      stdio: 'inherit',
      shell: false,
    });
    return { ...(await waitForChild(child, boundary)), delegated: false };
  }

  const mapping = resolveHostWorkspaceMapping(profile, cwd);
  if (mapping.workspace.id !== workspaceId) {
    throw new Error(`[execution-host] host cwd does not belong to workspace ${workspaceId}`);
  }
  const guestEntrypoint = posix.join(
    mapping.workspace.guestDir,
    'apps', 'stack', 'scripts', 'repo_local.mjs',
  );
  const credentialBroker = await startCredentialBroker();
  try {
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
  } finally {
    await credentialBroker.close();
  }
}
