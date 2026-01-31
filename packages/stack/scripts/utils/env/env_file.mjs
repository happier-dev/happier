import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathExists } from '../fs/fs.mjs';

export async function ensureEnvFileUpdated({ envPath, updates }) {
  if (!updates.length) {
    return;
  }
  await mkdir(dirname(envPath), { recursive: true });
  const existing = await readText(envPath);
  const next = applyEnvUpdates(existing, updates);
  await writeFileIfChanged(existing, next, envPath);
}

export async function ensureEnvFilePruned({ envPath, removeKeys }) {
  const keys = Array.from(new Set((removeKeys ?? []).map((k) => String(k).trim()).filter(Boolean)));
  if (!keys.length) {
    return;
  }
  await mkdir(dirname(envPath), { recursive: true });
  const existing = await readText(envPath);
  const next = pruneEnvKeys(existing, keys);
  await writeFileIfChanged(existing, next, envPath);
}

async function readText(path) {
  try {
    return (await pathExists(path)) ? await readFile(path, 'utf-8') : '';
  } catch {
    return '';
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
  await writeFile(path, normalizedNext, 'utf-8');
}

