import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { deriveDirectSessionActivityFromTimestamp } from '@/api/directSessions/activity/deriveDirectSessionActivityFromTimestamp';
import { mapWithConcurrency } from '@/api/directSessions/discovery/mapWithConcurrency';

import { readClaudeSessionTitle } from './readClaudeSessionTitle';
import { resolveClaudeConfigDirForDirectSessions } from './resolveClaudeConfigDir';

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

function resolveClaudeSessionDiscoveryConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env.HAPPIER_DIRECT_SESSIONS_CLAUDE_DISCOVERY_CONCURRENCY ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 64;
  return Math.max(1, Math.min(512, configured));
}

export async function listClaudeSessionCandidates(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null }>> {
  const env = params.env ?? process.env;
  const configDir = resolveClaudeConfigDirForDirectSessions({ source: params.source, env });
  const projectsDir = join(configDir, 'projects');
  const discoveryConcurrency = resolveClaudeSessionDiscoveryConcurrency(env);

  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  type DiscoveredSession = {
    remoteSessionId: string;
    projectId: string;
    fullPath: string;
    updatedAtMs: number;
  };

  let projectEntries: any[];
  try {
    projectEntries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    projectEntries = [];
  }

  const discoveredSessions = (
    await mapWithConcurrency(projectEntries, discoveryConcurrency, async (projectEntry): Promise<DiscoveredSession[]> => {
      if (!projectEntry.isDirectory()) return [];
      if (projectEntry.isSymbolicLink()) return [];

      const projectId = typeof projectEntry.name === 'string' ? projectEntry.name : String(projectEntry.name);
      const projectPath = join(projectsDir, projectId);

      let sessionEntries: any[];
      try {
        sessionEntries = await readdir(projectPath, { withFileTypes: true });
      } catch {
        return [];
      }

      const sessions = await mapWithConcurrency(sessionEntries, discoveryConcurrency, async (entry): Promise<DiscoveredSession | null> => {
        if (!entry.isFile()) return null;
        if (entry.isSymbolicLink()) return null;
        const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
        if (!name.endsWith('.jsonl')) return null;
        const remoteSessionId = name.slice(0, -'.jsonl'.length);
        if (!remoteSessionId) return null;
        if (remoteSessionId.includes('/') || remoteSessionId.includes('\\')) return null;

        if (searchTerm) {
          const haystack = `${remoteSessionId} ${projectId}`.toLowerCase();
          if (!haystack.includes(searchTerm)) return null;
        }

        const full = join(projectPath, name);
        try {
          const s = await stat(full);
          return {
            remoteSessionId,
            projectId,
            fullPath: full,
            updatedAtMs: Math.trunc(s.mtimeMs),
          } satisfies DiscoveredSession;
        } catch {
          return null;
        }
      });

      return sessions.filter((session): session is DiscoveredSession => session !== null);
    })
  ).flat();

  const limit = Math.max(1, Math.trunc(params.limit));
  const offset = decodeIndexCursor(params.cursor);
  const sortedSessions = discoveredSessions
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)));
  const pageSessions = sortedSessions.slice(offset, offset + limit);
  const page = await Promise.all(
    pageSessions.map(async (session): Promise<DirectSessionCandidateV1> => {
      let title: string | null = null;
      try {
        title = await readClaudeSessionTitle(session.fullPath);
      } catch {
        title = null;
      }

      return {
        remoteSessionId: session.remoteSessionId,
        ...(title ? { title } : {}),
        updatedAtMs: session.updatedAtMs,
        activity: deriveDirectSessionActivityFromTimestamp({ updatedAtMs: session.updatedAtMs, env }),
        details: { projectId: session.projectId },
      };
    }),
  );
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < sortedSessions.length ? encodeIndexCursor(nextOffset) : null;
  return { candidates: page, nextCursor };
}
