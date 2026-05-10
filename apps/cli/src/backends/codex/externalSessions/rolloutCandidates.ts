import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { ExternalSessionCandidateV1 } from '@happier-dev/protocol';

import { deriveExternalSessionActivityFromTimestamp } from '../../../api/session/external/activity/deriveExternalSessionActivityFromTimestamp';

import { readCodexSessionMetaFromRollout } from '../rollout/discovery/rolloutDiscovery';
import { parseCodexRolloutSessionIdFromFilename } from '../rollout/discovery/parseCodexRolloutSessionIdFromFilename';
import { withCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';
import type { CodexExternalSessionHomeEntry } from './homeEntries';
import { homeEntries as resolveHomeEntries } from './homeEntries';

type RolloutCandidateGroup = Readonly<{
  updatedAtMs: number;
  archived: boolean;
  latestFilePath: string;
  earliestFilePath: string;
  earliestMtimeMs: number;
  latestSortMs: number;
  earliestSortMs: number;
}>;

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

function parseRolloutTimestampMs(filePath: string): number {
  const name = basename(filePath);
  const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/i.exec(name);
  if (!match) return Number.NEGATIVE_INFINITY;
  const iso = `${match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3')}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

async function buildRolloutCandidate(params: Readonly<{
  activeServerDir: string;
  remoteSessionId: string;
  group: RolloutCandidateGroup;
  env: NodeJS.ProcessEnv;
  source: CodexExternalSessionHomeEntry['source'];
}>): Promise<ExternalSessionCandidateV1> {
  const [latestMeta, earliestMeta, storeMetadata] = await Promise.all([
    readCodexSessionMetaFromRollout(params.group.latestFilePath),
    readCodexSessionMetaFromRollout(params.group.earliestFilePath),
    withCodexRolloutSessionStore(
      {
        activeServerDir: params.activeServerDir,
        env: params.env,
        key: {
          providerId: 'codex',
          source: params.source,
          remoteSessionId: params.remoteSessionId,
        },
      },
      async (store) => {
        const [title, cwd, activity] = await Promise.all([
          store.getTitle(),
          store.getWorkingDirectory(),
          store.getActivity(),
        ]);
        const typedActivity = activity as Readonly<{ lastActivityAtMs: number | null }> | null;
        return {
          title,
          cwd,
          lastActivityAtMs: typedActivity?.lastActivityAtMs ?? null,
        };
      },
    ),
  ]);
  const canonicalRemoteSessionId = [
    latestMeta?.id,
    earliestMeta?.id,
    params.remoteSessionId,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? params.remoteSessionId;
  const cwd = storeMetadata.cwd ?? (latestMeta && typeof latestMeta.cwd === 'string' ? latestMeta.cwd : undefined);
  const createdAtMs = (() => {
    const ts = earliestMeta && typeof earliestMeta.timestamp === 'string' ? Date.parse(earliestMeta.timestamp) : NaN;
    if (Number.isFinite(ts) && ts >= 0) return Math.trunc(ts);
    return Math.trunc(params.group.earliestMtimeMs);
  })();
  const updatedAtMs = storeMetadata.lastActivityAtMs ?? Math.trunc(params.group.updatedAtMs);

  return {
    remoteSessionId: canonicalRemoteSessionId,
    ...(storeMetadata.title ? { title: storeMetadata.title } : {}),
    createdAtMs,
    updatedAtMs,
    archived: params.group.archived,
    activity: deriveExternalSessionActivityFromTimestamp({ updatedAtMs, env: params.env }),
    details: {
      ...(cwd ? { cwd } : {}),
      source: params.source,
    },
  };
}

async function resolveRolloutCandidateSessionId(filePath: string): Promise<string | null> {
  const fromFilename = parseCodexRolloutSessionIdFromFilename(filePath);
  if (fromFilename) {
    return fromFilename;
  }
  const sessionMeta = await readCodexSessionMetaFromRollout(filePath);
  const sessionId = typeof sessionMeta?.id === 'string' ? sessionMeta.id.trim() : '';
  return sessionId || null;
}

export async function rolloutCandidates(params: Readonly<{
  source: CodexExternalSessionHomeEntry['source'];
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  offset?: number;
  limit?: number;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; totalCount: number }>> {
  const env = params.env ?? process.env;
  const homeEntries = await resolveHomeEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  const grouped = new Map<string, { group: RolloutCandidateGroup; source: CodexExternalSessionHomeEntry['source'] }>();
  for (const homeEntry of homeEntries) {
    const files = [
      ...(await collectRolloutFiles({ rootDir: join(homeEntry.codexHome, 'sessions'), maxDepth: 10, archived: false })),
      ...(await collectRolloutFiles({ rootDir: join(homeEntry.codexHome, 'archived_sessions'), maxDepth: 10, archived: true })),
    ];
    for (const entry of files) {
      const resumeId = await resolveRolloutCandidateSessionId(entry.filePath);
      if (!resumeId) continue;
      const existing = grouped.get(resumeId);
      if (!existing) {
        grouped.set(resumeId, {
          source: homeEntry.source,
          group: {
            updatedAtMs: entry.mtimeMs,
            archived: entry.archived,
            latestFilePath: entry.filePath,
            earliestFilePath: entry.filePath,
            earliestMtimeMs: entry.mtimeMs,
            latestSortMs: parseRolloutTimestampMs(entry.filePath),
            earliestSortMs: parseRolloutTimestampMs(entry.filePath),
          },
        });
        continue;
      }
      const entrySortMs = parseRolloutTimestampMs(entry.filePath);
      grouped.set(resumeId, {
        source: entrySortMs >= existing.group.latestSortMs ? homeEntry.source : existing.source,
        group: {
          updatedAtMs: Math.max(existing.group.updatedAtMs, entry.mtimeMs),
          archived: existing.group.archived && entry.archived,
          latestFilePath: entrySortMs >= existing.group.latestSortMs ? entry.filePath : existing.group.latestFilePath,
          earliestFilePath: entrySortMs <= existing.group.earliestSortMs ? entry.filePath : existing.group.earliestFilePath,
          earliestMtimeMs: Math.min(existing.group.earliestMtimeMs, entry.mtimeMs),
          latestSortMs: Math.max(existing.group.latestSortMs, entrySortMs),
          earliestSortMs: Math.min(existing.group.earliestSortMs, entrySortMs),
        },
      });
    }
  }

  const groupedCandidates = Array.from(grouped.entries())
    .map(([remoteSessionId, entry]) => ({ remoteSessionId, entry }))
    .sort((a, b) => b.entry.group.updatedAtMs - a.entry.group.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)));

  const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const limit = Math.max(1, Math.trunc(params.limit ?? groupedCandidates.length ?? 1));

  if (!searchTerm) {
    const pageEntries = groupedCandidates.slice(offset, offset + limit);
    const candidates = await Promise.all(pageEntries.map(({ remoteSessionId, entry }) =>
      buildRolloutCandidate({
        activeServerDir: params.activeServerDir,
        remoteSessionId,
        group: entry.group,
        env,
        source: entry.source,
      }),
    ));
    return { candidates, totalCount: groupedCandidates.length };
  }

  const allCandidates = await Promise.all(groupedCandidates.map(({ remoteSessionId, entry }) =>
    buildRolloutCandidate({
      activeServerDir: params.activeServerDir,
      remoteSessionId,
      group: entry.group,
      env,
      source: entry.source,
    }),
  ));
  const filtered = allCandidates
    .filter((candidate) => {
      const cwd = candidate.details?.cwd;
      const title = candidate.title;
      const haystack = `${candidate.remoteSessionId}${title ? ` ${title}` : ''}${cwd ? ` ${cwd}` : ''}`.toLowerCase();
      return haystack.includes(searchTerm);
    });
  return {
    candidates: filtered.slice(offset, offset + limit),
    totalCount: filtered.length,
  };
}
