import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join } from 'node:path';

import {
  decodeIndexCursor,
  encodeIndexCursor,
  scanJsonlSessionFile,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import type {
  ExternalSessionActivityV1,
  ExternalSessionCandidateV1,
  ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/sessions';

import { listOhMyPiSessionRoots } from './files.js';
import { resolveOhMyPiAgentDir } from './source.js';

type DiscoveredSession = Readonly<{
  remoteSessionId: string;
  updatedAtMs: number;
  createdAtMs: number | null;
  title: string | null;
  workingDirectory: string | null;
}>;

function resolveRecentActivityWindowMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15_000;
  return Math.max(1000, Math.min(60 * 60 * 1000, configured));
}

function deriveActivity(updatedAtMs: number | null | undefined, env: NodeJS.ProcessEnv): ExternalSessionActivityV1 {
  const normalized = typeof updatedAtMs === 'number' && Number.isFinite(updatedAtMs)
    ? Math.trunc(updatedAtMs)
    : null;
  if (normalized == null || normalized < 0) return 'unknown';

  const ageMs = Date.now() - normalized;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';
  return ageMs <= resolveRecentActivityWindowMs(env) ? 'active_recently' : 'idle';
}

async function discoverSessionsInRoot(params: Readonly<{
  sessionRoot: string;
  searchTerm: string;
  env: NodeJS.ProcessEnv;
}>): Promise<DiscoveredSession[]> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(params.sessionRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: DiscoveredSession[] = [];
  for (const entry of entries.filter((value) => value.isFile() && !value.isSymbolicLink() && value.name.endsWith('.jsonl'))) {
    const filePath = join(params.sessionRoot, entry.name);
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;
      const scanned = await scanJsonlSessionFile(filePath);
      if (!scanned) continue;
      const haystack = `${scanned.sessionId} ${scanned.title ?? ''} ${scanned.cwd ?? ''} ${basename(params.sessionRoot)}`.toLowerCase();
      if (params.searchTerm && !haystack.includes(params.searchTerm)) continue;
      discovered.push({
        remoteSessionId: scanned.sessionId,
        updatedAtMs: scanned.lastActivityAtMs || Math.trunc(fileStat.mtimeMs),
        createdAtMs: scanned.createdAtMs,
        title: scanned.title,
        workingDirectory: scanned.cwd,
      });
    } catch {
      continue;
    }
  }
  return discovered;
}

export async function listOhMyPiSessionCandidates(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; nextCursor: string | null }>> {
  const env = params.env ?? process.env;
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env });
  const sessionRoots = await listOhMyPiSessionRoots({ source: params.source, env });
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';

  const discovered = (await Promise.all(
    sessionRoots.map((sessionRoot) => discoverSessionsInRoot({ sessionRoot, searchTerm, env })),
  )).flat();

  const limit = Math.max(1, Math.trunc(params.limit));
  const offset = decodeIndexCursor(params.cursor) ?? 0;
  const sorted = discovered.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.remoteSessionId.localeCompare(b.remoteSessionId));
  const page = sorted.slice(offset, offset + limit);
  const candidates = page.map((session) => ({
    remoteSessionId: session.remoteSessionId,
    ...(session.title ? { title: session.title } : {}),
    updatedAtMs: session.updatedAtMs,
    ...(typeof session.createdAtMs === 'number' ? { createdAtMs: session.createdAtMs } : {}),
    activity: deriveActivity(session.updatedAtMs, env),
    details: {
      workingDirectory: session.workingDirectory,
      agentDir,
    },
  } satisfies ExternalSessionCandidateV1));
  const nextOffset = offset + candidates.length;
  return {
    candidates,
    nextCursor: nextOffset < sorted.length ? encodeIndexCursor(nextOffset) : null,
  };
}
