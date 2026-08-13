import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';

function envFileLockPath(envPath) {
  return `${envPath}.owner.lock`;
}

async function withEnvFileLock(envPath, fn) {
  return await withJsonOwnerFileLock(fn, {
    lockPath: envFileLockPath(envPath),
    timeoutMs: 30_000,
    pollIntervalMs: 50,
    staleAfterMs: 60_000,
    errorLabel: 'stack env file update',
  });
}

export async function ensureEnvFileUpdated({ envPath, updates }) {
  if (!updates.length) {
    return;
  }
  await withEnvFileLock(envPath, async () => {
    await mkdir(dirname(envPath), { recursive: true });
    const existing = await readText(envPath);
    const next = applyEnvUpdates(existing, updates);
    await writeFileIfChanged(existing, next, envPath);
  });
}

export async function ensureEnvFileMutated({ envPath, updates = [], removeKeys = [] }) {
  const keys = Array.from(new Set(removeKeys.map((key) => String(key).trim()).filter(Boolean)));
  if (!updates.length && !keys.length) return;
  await withEnvFileLock(envPath, async () => {
    await mkdir(dirname(envPath), { recursive: true });
    const existing = await readText(envPath);
    const pruned = keys.length ? pruneEnvKeys(existing, keys) : existing;
    const next = updates.length ? applyEnvUpdates(pruned, updates) : pruned;
    await writeFileIfChanged(existing, next, envPath);
  });
}

export async function ensureEnvFilePruned({ envPath, removeKeys }) {
  const keys = Array.from(new Set((removeKeys ?? []).map((k) => String(k).trim()).filter(Boolean)));
  if (!keys.length) {
    return;
  }
  await withEnvFileLock(envPath, async () => {
    await mkdir(dirname(envPath), { recursive: true });
    const existing = await readText(envPath);
    const next = pruneEnvKeys(existing, keys);
    await writeFileIfChanged(existing, next, envPath);
  });
}

export async function compareAndSetEnvFileValue({ envPath, key, expectedValue = null, nextValue = null }) {
  const normalizedKey = String(key ?? '').trim();
  if (!normalizedKey) throw new Error('compareAndSetEnvFileValue requires a key');
  return await withEnvFileLock(envPath, async () => {
    await mkdir(dirname(envPath), { recursive: true });
    const existing = await readText(envPath);
    const line = existing.split('\n').find((candidate) => candidate.trim().startsWith(`${normalizedKey}=`));
    const currentValue = line ? line.slice(line.indexOf('=') + 1) : null;
    if (currentValue !== expectedValue) return false;
    const next = nextValue == null
      ? pruneEnvKeys(existing, [normalizedKey])
      : applyEnvUpdates(existing, [{ key: normalizedKey, value: String(nextValue) }]);
    await writeFileIfChanged(existing, next, envPath);
    return true;
  });
}

export async function createEnvFileExclusive({ envPath, content }) {
  return await withEnvFileLock(envPath, async () => {
    await mkdir(dirname(envPath), { recursive: true });
    const next = String(content ?? '');
    const normalizedNext = next.endsWith('\n') ? next : `${next}\n`;
    try {
      await writeFile(envPath, normalizedNext, { encoding: 'utf-8', flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  });
}

export async function replaceEnvFile({ envPath, content }) {
  return await withEnvFileLock(envPath, async () => {
    await mkdir(dirname(envPath), { recursive: true });
    const existing = await readText(envPath);
    await writeFileIfChanged(existing, String(content ?? ''), envPath);
  });
}

async function readText(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function applyEnvUpdates(existing, updates) {
  const lines = existing ? existing.split('\n') : [];
  const next = [...lines];

  const upsert = (key, value) => {
    const line = `${key}=${value}`;
    const idx = next.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx >= 0) {
      next[idx] = line;
    } else {
      if (next.length && next[next.length - 1].trim() !== '') {
        next.push('');
      }
      next.push(line);
    }
  };

  for (const { key, value } of updates) {
    upsert(key, value);
  }

  return next.join('\n');
}

function pruneEnvKeys(existing, removeKeys) {
  const keys = new Set(removeKeys);
  const lines = (existing ?? '').split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }
    // Remove any "KEY=..." line for keys in removeKeys.
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      kept.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (keys.has(key)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

async function writeFileIfChanged(existingContent, nextContent, path) {
  const normalizedNext = nextContent.endsWith('\n') ? nextContent : nextContent + '\n';
  const normalizedExisting = existingContent.endsWith('\n') ? existingContent : existingContent + (existingContent ? '\n' : '');
  if (normalizedExisting === normalizedNext) {
    return;
  }
  try {
    const dir = dirname(path);
    // if dir doesn't exist, writeFile will throw; that's fine (we only target known files).
    void dir;
  } catch {
    // ignore
  }
  const tmp = join(dirname(path), `.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}.env`);
  await writeFile(tmp, normalizedNext, 'utf-8');
  await rename(tmp, path);
}
