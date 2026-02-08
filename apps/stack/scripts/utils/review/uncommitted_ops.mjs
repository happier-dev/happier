import { runCapture } from '../proc/proc.mjs';
import { normalize } from 'node:path';

function normalizePath(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

function parseNameStatusZ(buf) {
  const raw = String(buf ?? '');
  if (!raw) return [];
  const parts = raw.split('\0').filter((x) => x.length);
  const entries = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    const code = status[0] ?? '';
    if (!code) break;
    if (code === 'R' || code === 'C') {
      const from = parts[i++] ?? '';
      const to = parts[i++] ?? '';
      entries.push({ code, status, from, to });
      continue;
    }
    const path = parts[i++] ?? '';
    entries.push({ code, status, path });
  }
  return entries;
}

function parsePathsZ(buf) {
  const raw = String(buf ?? '');
  if (!raw) return [];
  return raw.split('\0').filter((x) => x.length);
}

export function assertSafeRelativeRepoPath(rel) {
  const raw = String(rel ?? '').trim();
  if (!raw) {
    throw new Error('[review] unsafe path: empty path');
  }
  if (raw.includes('\0')) {
    throw new Error(`[review] unsafe path: ${raw}`);
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error(`[review] unsafe path (absolute): ${raw}`);
  }
  const normalized = normalize(raw).replaceAll('\\', '/');
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/'))
  {
    throw new Error(`[review] unsafe path traversal: ${raw}`);
  }
  return normalized.replace(/^\.\/+/, '');
}

export async function getUncommittedOps({ cwd, env = process.env } = {}) {
  const checkout = new Set();
  const remove = new Set();

  let entries = [];
  try {
    const out = await runCapture('git', ['diff', '--name-status', '--find-renames', '-z', 'HEAD'], { cwd, env });
    entries = parseNameStatusZ(out);
  } catch (error) {
    const details = `${String(error?.message ?? '')}\n${String(error?.err ?? '')}`.toLowerCase();
    const isMissingHead =
      details.includes("bad revision 'head'") ||
      details.includes("ambiguous argument 'head'") ||
      details.includes("unknown revision or path not in the working tree");
    if (!isMissingHead) throw error;
  }

  for (const e of entries) {
    if (e.code === 'A' || e.code === 'M' || e.code === 'T') {
      checkout.add(assertSafeRelativeRepoPath(normalizePath(e.path)));
      continue;
    }
    if (e.code === 'D') {
      remove.add(assertSafeRelativeRepoPath(normalizePath(e.path)));
      continue;
    }
    if (e.code === 'R' || e.code === 'C') {
      if (e.code === 'R' && e.from) remove.add(assertSafeRelativeRepoPath(normalizePath(e.from)));
      if (e.to) checkout.add(assertSafeRelativeRepoPath(normalizePath(e.to)));
      continue;
    }
  }

  const untrackedOut = await runCapture('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, env });
  for (const p of parsePathsZ(untrackedOut)) {
    checkout.add(assertSafeRelativeRepoPath(normalizePath(p)));
  }

  const all = new Set([...checkout, ...remove]);
  return { checkout, remove, all };
}
