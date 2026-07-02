import type { ExternalSessionCandidateV1 } from '@happier-dev/protocol';

import { deriveExternalSessionActivityFromTimestamp } from '../../../../api/session/external/activity/deriveExternalSessionActivityFromTimestamp';
import { mapWithConcurrency } from '../../../../api/session/external/discovery/mapWithConcurrency';

import {
  type CodexRolloutCandidateEntry,
  type CodexRolloutCandidateGroup,
  filterCodexRolloutCandidatesBySearchTerm,
  resolveCodexRolloutSearchBuildConcurrency,
  selectCodexRolloutCandidateEntries,
} from '@happier-dev/plugins-codex/agent/rollout/discovery/candidates';
import {
  readCodexSessionMetaFromRollout,
} from '@happier-dev/plugins-codex/agent/rollout/discovery/indexData';
import { withCodexRolloutSessionStore } from './codexRolloutSessionStoreRegistry';

async function buildRolloutCandidate(params: Readonly<{
  activeServerDir: string;
  remoteSessionId: string;
  group: CodexRolloutCandidateGroup;
  env: NodeJS.ProcessEnv;
  source: CodexRolloutCandidateEntry['source'];
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

async function buildRolloutCandidateFromKnownRolloutFiles(params: Readonly<{
  remoteSessionId: string;
  group: CodexRolloutCandidateGroup;
  env: NodeJS.ProcessEnv;
  source: CodexRolloutCandidateEntry['source'];
}>): Promise<ExternalSessionCandidateV1> {
  const [latestMeta, earliestMeta] = await Promise.all([
    readCodexSessionMetaFromRollout(params.group.latestFilePath),
    readCodexSessionMetaFromRollout(params.group.earliestFilePath),
  ]);
  const canonicalRemoteSessionId = [
    latestMeta?.id,
    earliestMeta?.id,
    params.remoteSessionId,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? params.remoteSessionId;
  const cwd = latestMeta && typeof latestMeta.cwd === 'string' ? latestMeta.cwd : undefined;
  const createdAtMs = (() => {
    const ts = earliestMeta && typeof earliestMeta.timestamp === 'string' ? Date.parse(earliestMeta.timestamp) : NaN;
    if (Number.isFinite(ts) && ts >= 0) return Math.trunc(ts);
    return Math.trunc(params.group.earliestMtimeMs);
  })();
  const updatedAtMs = Math.trunc(params.group.updatedAtMs);

  return {
    remoteSessionId: canonicalRemoteSessionId,
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

export async function rolloutCandidates(params: Readonly<{
  source: CodexRolloutCandidateEntry['source'];
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  offset?: number;
  limit?: number;
  searchTerm?: string;
  searchMode?: 'fast' | 'full';
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; totalCount: number; searchIncomplete?: boolean }>> {
  const env = params.env ?? process.env;
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const requestedLimit = Math.max(1, Math.trunc(params.limit ?? 1));
  const selection = await selectCodexRolloutCandidateEntries({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
    offset,
    limit: requestedLimit,
    searchTerm: params.searchTerm,
    searchMode: params.searchMode,
  });

  async function buildCandidates(entries: ReadonlyArray<CodexRolloutCandidateEntry>): Promise<ExternalSessionCandidateV1[]> {
    return mapWithConcurrency(entries, resolveCodexRolloutSearchBuildConcurrency(env), ({ remoteSessionId, group, source }) =>
      buildRolloutCandidate({
        activeServerDir: params.activeServerDir,
        remoteSessionId,
        group,
        env,
        source,
      }),
    );
  }

  async function buildCandidatesFromKnownFiles(entries: ReadonlyArray<CodexRolloutCandidateEntry>): Promise<ExternalSessionCandidateV1[]> {
    return mapWithConcurrency(entries, resolveCodexRolloutSearchBuildConcurrency(env), ({ remoteSessionId, group, source }) =>
      buildRolloutCandidateFromKnownRolloutFiles({
        remoteSessionId,
        group,
        env,
        source,
      }),
    );
  }

  if (selection.kind === 'direct') {
    const candidates = selection.buildMode === 'knownRolloutFiles'
      ? await buildCandidatesFromKnownFiles(selection.entries)
      : await buildCandidates(selection.entries);
    return {
      candidates,
      totalCount: selection.totalCount,
      ...(selection.searchIncomplete ? { searchIncomplete: true } : {}),
    };
  }

  const allCandidates = await buildCandidates(selection.entries);
  const filtered = filterCodexRolloutCandidatesBySearchTerm({
    candidates: allCandidates,
    searchTerm: params.searchTerm ?? '',
  });

  return {
    candidates: filtered.slice(offset, offset + requestedLimit),
    totalCount: filtered.length,
    ...(selection.searchIncomplete ? { searchIncomplete: true } : {}),
  };
}
