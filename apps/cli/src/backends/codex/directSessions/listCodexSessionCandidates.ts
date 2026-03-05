import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { readCodexSessionMetaFromRollout } from '../localControl/rolloutDiscovery';
import { resolveCodexHomesForDirectSessionsSource } from './resolveCodexHomesForDirectSessionsSource';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return 0;
    if (parsed.v !== 1 || parsed.kind !== 'index') return 0;
    const offset = typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) ? Math.trunc(parsed.offset) : 0;
    return Math.max(0, offset);
  } catch {
    return 0;
  }
}

function parseResumeIdFromRolloutFilename(filePath: string): string | null {
  const name = basename(filePath);
  const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return match ? match[1] : null;
}

async function collectRolloutFiles(params: Readonly<{ rootDir: string; maxDepth: number; archived: boolean }>): Promise<Array<{ filePath: string; mtimeMs: number; archived: boolean }>> {
  const out: Array<{ filePath: string; mtimeMs: number; archived: boolean }> = [];
  const maxDepth = Math.max(0, Math.trunc(params.maxDepth));

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: any[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
      const full = join(dir, name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      try {
        const s = await stat(full);
        out.push({ filePath: full, mtimeMs: s.mtimeMs, archived: params.archived });
      } catch {
        // ignore unreadable
      }
    }
  }

  await walk(params.rootDir, 0);
  return out;
}

export async function listCodexSessionCandidates(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null }>> {
  const env = params.env ?? process.env;
  const homes = await resolveCodexHomesForDirectSessionsSource({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  const grouped = new Map<string, { updatedAtMs: number; archived: boolean; latestFilePath: string }>();
  for (const home of homes) {
    const sessionsDir = join(home, 'sessions');
    const archivedDir = join(home, 'archived_sessions');
    const files = [
      ...(await collectRolloutFiles({ rootDir: sessionsDir, maxDepth: 10, archived: false })),
      ...(await collectRolloutFiles({ rootDir: archivedDir, maxDepth: 10, archived: true })),
    ];

    for (const entry of files) {
      const resumeId = parseResumeIdFromRolloutFilename(entry.filePath);
      if (!resumeId) continue;
      const existing = grouped.get(resumeId);
      if (!existing) {
        grouped.set(resumeId, { updatedAtMs: entry.mtimeMs, archived: entry.archived, latestFilePath: entry.filePath });
        continue;
      }
      const nextUpdated = Math.max(existing.updatedAtMs, entry.mtimeMs);
      const archived = existing.archived && entry.archived;
      const latestFilePath = entry.mtimeMs >= existing.updatedAtMs ? entry.filePath : existing.latestFilePath;
      grouped.set(resumeId, { updatedAtMs: nextUpdated, archived, latestFilePath });
    }
  }

  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';

  const candidates: DirectSessionCandidateV1[] = [];
  for (const [remoteSessionId, group] of grouped.entries()) {
    const meta = await readCodexSessionMetaFromRollout(group.latestFilePath);
    const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : undefined;
    const createdAtMs = (() => {
      const ts = meta && typeof meta.timestamp === 'string' ? Date.parse(meta.timestamp) : NaN;
      return Number.isFinite(ts) && ts >= 0 ? Math.trunc(ts) : Math.trunc(group.updatedAtMs);
    })();

    const details = cwd ? { cwd } : undefined;
    if (searchTerm) {
      const haystack = `${remoteSessionId}${cwd ? ` ${cwd}` : ''}`.toLowerCase();
      if (!haystack.includes(searchTerm)) continue;
    }

    candidates.push({
      remoteSessionId,
      updatedAtMs: Math.trunc(group.updatedAtMs),
      createdAtMs,
      archived: group.archived,
      ...(details ? { details } : {}),
    });
  }

  candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)));

  const limit = Math.max(1, Math.trunc(params.limit));
  const offset = decodeIndexCursor(params.cursor);
  const page = candidates.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < candidates.length ? encodeIndexCursor(nextOffset) : null;

  return { candidates: page, nextCursor };
}
