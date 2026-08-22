import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { isJsonOwnerFileLockActive, withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';

function lockScopeHash({ internalServerUrl = '', stackName = '' } = {}) {
  return createHash('sha256')
    .update(String(stackName ?? '').trim())
    .update('\n')
    .update(String(internalServerUrl ?? '').trim())
    .digest('hex')
    .slice(0, 16);
}

export function resolveStackDaemonLifecycleLockPath({ cliHomeDir, internalServerUrl = '', stackName = '' } = {}) {
  const home = String(cliHomeDir ?? '').trim();
  if (!home) {
    throw new Error('resolveStackDaemonLifecycleLockPath requires cliHomeDir');
  }
  return join(home, 'locks', `stack-daemon-orchestration-${lockScopeHash({ internalServerUrl, stackName })}.lock`);
}

export function isStackDaemonLifecycleLockActive(lockPath, options = {}) {
  return isJsonOwnerFileLockActive(lockPath, {
    staleAfterMs: options.staleAfterMs ?? 60_000,
    nowMs: options.nowMs ?? Date.now(),
  });
}

export async function withStackDaemonLifecycleLock(scope, fn, options = {}) {
  const lockPath = options.lockPath ?? resolveStackDaemonLifecycleLockPath(scope);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 125;
  const staleAfterMs = options.staleAfterMs ?? (
    Number.isFinite(timeoutMs) ? Math.max(60_000, timeoutMs) : 180_000
  );

  return withJsonOwnerFileLock(
    ({ waited }) => fn({ waited, lockPath }),
    {
      lockPath,
      timeoutMs,
      pollIntervalMs,
      staleAfterMs,
      errorLabel: 'daemon lifecycle lock',
      onWait: options.onWait,
    },
  );
}
