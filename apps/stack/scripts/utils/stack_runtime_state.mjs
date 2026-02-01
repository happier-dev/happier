import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveStackEnvPath } from './paths/paths.mjs';

export function getStackRuntimeStatePath(stackName) {
  const { baseDir } = resolveStackEnvPath(stackName);
  return join(baseDir, 'stack.runtime.json');
}

export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readStackRuntimeStateFile(statePath) {
  try {
    if (!statePath || !existsSync(statePath)) return null;
    const raw = await readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeStackRuntimeStateFile(statePath, state) {
  if (!statePath) {
    throw new Error('[stack] missing runtime state path');
  }
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const tmp = join(dir, `.stack.runtime.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  await rename(tmp, statePath);
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

export async function recordStackRuntimeStart(statePath, { stackName, script, ephemeral, ownerPid, ports } = {}) {
  const now = new Date().toISOString();
  const existing = (await readStackRuntimeStateFile(statePath)) ?? {};
  const startedAt = typeof existing.startedAt === 'string' && existing.startedAt.trim() ? existing.startedAt : now;
  const next = deepMerge(existing, {
    version: 1,
    stackName,
    script,
    ephemeral: Boolean(ephemeral),
    ownerPid,
    ports: ports ?? {},
    startedAt,
    updatedAt: now,
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

export async function deleteStackRuntimeStateFile(statePath) {
  try {
    if (!statePath || !existsSync(statePath)) return;
    await unlink(statePath);
  } catch {
    // ignore
  }
}

