import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveStackEnvPath } from '../paths/paths.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { isPidAlive } from '../proc/pids.mjs';

export { isPidAlive };

export function getStackRuntimeStatePath(stackName) {
  const { baseDir } = resolveStackEnvPath(stackName);
  return join(baseDir, 'stack.runtime.json');
}

export async function readStackRuntimeStateFile(statePath) {
  const parsed = await readJsonIfExists(statePath, { defaultValue: null });
  return parsed && typeof parsed === 'object' ? parsed : null;
}

export async function writeStackRuntimeStateFile(statePath, state) {
  if (!statePath) {
    throw new Error('[stack] missing runtime state path');
  }
  await writeJsonAtomic(statePath, state);
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return b;
  }
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (isPlainObject(out[k]) && isPlainObject(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function updateStackRuntimeStateFile(statePath, patch) {
  const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
  const next = deepMerge(existing, patch ?? {});
  await writeStackRuntimeStateFile(statePath, next);
  return next;
}

export async function recordStackRuntimeStart(statePath, { stackName, script, ephemeral, ownerPid, ports, ...rest } = {}) {
  const now = new Date().toISOString();
  const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
  const existingOwnerPid = Number(existing.ownerPid);
  const ownerPidNum = Number(ownerPid);
  const shouldRefreshStartedAt =
    !(
      typeof existing.startedAt === 'string' &&
      existing.startedAt.trim()
    ) ||
    !Number.isFinite(existingOwnerPid) ||
    existingOwnerPid <= 1 ||
    !isPidAlive(existingOwnerPid) ||
    (Number.isFinite(ownerPidNum) && ownerPidNum > 1 && ownerPidNum !== existingOwnerPid);
  const startedAt = shouldRefreshStartedAt ? now : existing.startedAt;
  const next = deepMerge(existing, {
    version: 1,
    stackName,
    script,
    ephemeral: Boolean(ephemeral),
    ownerPid,
    ports: ports ?? {},
    startedAt,
    updatedAt: now,
    stopRequest: null,
    ...(rest ?? {}),
  });
  await writeStackRuntimeStateFile(statePath, next);
  return next;
}

export async function recordStackRuntimeUpdate(statePath, patch = {}) {
  return await updateStackRuntimeStateFile(statePath, {
    ...(patch ?? {}),
    updatedAt: new Date().toISOString(),
  });
}

export async function recordStackRuntimeStopRequest(
  statePath,
  { signal = 'SIGTERM', requestedBy = 'unknown', reason = '' } = {},
) {
  return await updateStackRuntimeStateFile(statePath, {
    stopRequest: {
      signal: String(signal ?? 'SIGTERM'),
      requestedBy: String(requestedBy ?? 'unknown'),
      reason: String(reason ?? ''),
      requestedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteStackRuntimeStateFile(statePath) {
  try {
    if (!statePath || !existsSync(statePath)) return;
    await unlink(statePath);
  } catch {
    // ignore
  }
}
