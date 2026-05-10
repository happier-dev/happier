import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ExternalSessionCandidateV1, ExternalSessionsSource } from '@happier-dev/protocol';

import { deriveExternalSessionActivityFromTimestamp } from '@/api/session/external/activity/deriveExternalSessionActivityFromTimestamp';
import { mapWithConcurrency } from '@/api/session/external/discovery/mapWithConcurrency';

import { resolveOhMyPiAgentDir } from './resolveOhMyPiAgentDir';
import { readOhMyPiSessionSnapshot } from '../transcripts/projection/readOhMyPiSessionSnapshot';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as IndexCursorV1;
    if (parsed.v !== 1 || parsed.kind !== 'index') return 0;
    return Math.max(0, Math.trunc(parsed.offset));
  } catch {
    return 0;
  }
}

function resolveDiscoveryConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_OH_MY_PI_DISCOVERY_CONCURRENCY ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 64;
  return Math.max(1, Math.min(512, configured));
}

type DiscoveredSession = Readonly<{
  remoteSessionId: string;
  filePath: string;
  updatedAtMs: number;
  createdAtMs: number | null;
  title: string | null;
  workingDirectory: string | null;
}>;

export async function listOhMyPiSessionCandidates(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; nextCursor: string | null }>> {
  const env = params.env ?? process.env;
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env });
  const sessionsDir = join(agentDir, 'sessions');
  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const concurrency = resolveDiscoveryConcurrency(env);

  let sessionRoots: string[] = [];
  try {
    sessionRoots = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(sessionsDir, entry.name));
  } catch {
    sessionRoots = [];
  }

  const discovered = (await mapWithConcurrency(sessionRoots, concurrency, async (sessionRoot): Promise<DiscoveredSession[]> => {
    let entries: string[] = [];
    try {
      entries = await readdir(sessionRoot);
    } catch {
      return [];
    }

    const files = entries.filter((entry) => entry.endsWith('.jsonl'));
    const sessions = await mapWithConcurrency(files, concurrency, async (entry): Promise<DiscoveredSession | null> => {
      const match = entry.match(/_(.+)\.jsonl$/);
      const remoteSessionId = match?.[1]?.trim();
      if (!remoteSessionId) return null;
      const filePath = join(sessionRoot, entry);
      try {
        const fileStat = await stat(filePath);
        const snapshot = await readOhMyPiSessionSnapshot({
          sessionFilePath: filePath,
          sessionId: remoteSessionId,
        });
        const haystack = `${remoteSessionId} ${snapshot.title ?? ''} ${snapshot.workingDirectory ?? ''} ${basename(sessionRoot)}`.toLowerCase();
        if (searchTerm && !haystack.includes(searchTerm)) {
          return null;
        }
        return {
          remoteSessionId,
          filePath,
          updatedAtMs: Math.trunc(fileStat.mtimeMs),
          createdAtMs: snapshot.createdAtMs,
          title: snapshot.title,
          workingDirectory: snapshot.workingDirectory,
        };
      } catch {
        return null;
      }
    });

    return sessions.filter((session): session is DiscoveredSession => session !== null);
  })).flat();

  const limit = Math.max(1, Math.trunc(params.limit));
  const offset = decodeIndexCursor(params.cursor);
  const sorted = discovered
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.remoteSessionId.localeCompare(b.remoteSessionId));
  const page = sorted.slice(offset, offset + limit);
  const candidates = page.map((session) => ({
    remoteSessionId: session.remoteSessionId,
    ...(session.title ? { title: session.title } : {}),
    updatedAtMs: session.updatedAtMs,
    ...(typeof session.createdAtMs === 'number' ? { createdAtMs: session.createdAtMs } : {}),
    activity: deriveExternalSessionActivityFromTimestamp({ updatedAtMs: session.updatedAtMs, env }),
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
