import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  parseCodexRolloutSessionIdFromFilename,
  readCodexSessionMetaFromRollout,
} from './indexData.js';
import {
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';

export type CodexRolloutFile = Readonly<{
  filePath: string;
  fileRelPath: string;
  sortMs: number;
  mtimeMs: number;
  /** Source metadata retained by the root-family inventory for transcript semantics. */
  sessionId?: string;
  rootSessionId?: string;
}>;

type CodexRolloutMembership = 'exact_thread' | 'root_session_family';

export type CodexSessionRolloutResourceIdentity = Readonly<{
  sourceGeneration: readonly string[];
  streams: readonly Readonly<{
    fileRelPath: string;
    physicalGeneration: string;
  }>[];
}>;

export type CodexRootSessionRolloutInventory = Readonly<{
  sourceGeneration: readonly string[];
  requested: readonly Readonly<{
    remoteSessionId: string;
    files: readonly CodexRolloutFile[];
  }>[];
}>;

type CodexPhysicalFileMetadata = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
}>;

function formatPhysicalGeneration(metadata: CodexPhysicalFileMetadata): string {
  return [
    String(metadata.dev),
    String(metadata.ino),
    String(Math.trunc(metadata.birthtimeMs)),
  ].join(':');
}

function readNonEmptySessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

async function readPathGenerationAsync(path: string): Promise<string> {
  try {
    return formatPhysicalGeneration(await stat(path));
  } catch {
    return 'missing';
  }
}

export function resolveCodexHomeFromRolloutFilePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const markers = ['/sessions/', '/archived_sessions/'];
  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index > 0) {
      return normalized.slice(0, index);
    }
  }
  return null;
}

function parseRolloutTimestampFromFilename(filePath: string): number | null {
  const name = filePath.split(/[/\\\\]/).pop() ?? '';
  const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(name);
  if (!match) return null;
  const compact = match[1];
  const isoLike = compact.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const ms = Date.parse(`${isoLike}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function parseRemoteSessionTimestampMs(remoteSessionId: string): number | null {
  const normalized = String(remoteSessionId ?? '').replace(/-/g, '').trim().toLowerCase();
  if (!/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(normalized)) {
    return null;
  }
  try {
    const ms = Number.parseInt(normalized.slice(0, 12), 16);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    if (year < 2020 || year > 2100) return null;
    return ms;
  } catch {
    return null;
  }
}

const ROOT_SESSION_FAMILY_CLOCK_SKEW_MS = 2_000;
const ROOT_SESSION_FAMILY_FILENAME_TIMEZONE_WINDOW_MS = 24 * 60 * 60 * 1_000;

function readTargetedDayScanLimitDays(env?: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(String(env?.HAPPIER_CODEX_EXTERNAL_SESSIONS_MAX_DAY_SCAN_DAYS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 365;
  return Math.max(1, Math.min(3_650, configured));
}

function toDayDirParts(date: Date): readonly [string, string, string] {
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ];
}

function buildLikelyRolloutDayDirs(params: Readonly<{ codexHome: string; remoteSessionId: string; env?: NodeJS.ProcessEnv }>): string[] {
  const remoteSessionTimestampMs = parseRemoteSessionTimestampMs(params.remoteSessionId);
  if (remoteSessionTimestampMs === null) return [];

  const maxDayScanDays = readTargetedDayScanLimitDays(params.env);
  const startDayMs = Date.UTC(
    new Date(remoteSessionTimestampMs).getUTCFullYear(),
    new Date(remoteSessionTimestampMs).getUTCMonth(),
    new Date(remoteSessionTimestampMs).getUTCDate(),
  );
  const currentDay = new Date();
  const currentDayMs = Date.UTC(currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate());
  const elapsedDays = Math.max(0, Math.trunc((currentDayMs - startDayMs) / 86_400_000));
  if (elapsedDays > maxDayScanDays) return [];

  const results: string[] = [];
  const seen = new Set<string>();
  for (let offsetDays = -1; offsetDays <= elapsedDays + 1; offsetDays++) {
    const dayMs = startDayMs + offsetDays * 86_400_000;
    const parts = toDayDirParts(new Date(dayMs));
    const sessionDir = join(params.codexHome, 'sessions', ...parts);
    const archivedDir = join(params.codexHome, 'archived_sessions', ...parts);
    if (!seen.has(sessionDir)) {
      seen.add(sessionDir);
      results.push(sessionDir);
    }
    if (!seen.has(archivedDir)) {
      seen.add(archivedDir);
      results.push(archivedDir);
    }
  }
  return results;
}

async function collectRolloutMatchesFromFlatDir(params: Readonly<{
  codexHome: string;
  dir: string;
  remoteSessionIds: ReadonlySet<string>;
  membership: CodexRolloutMembership;
}> & CodexExternalSessionInvocationBounds): Promise<Map<string, CodexRolloutFile[]>> {
  throwIfCodexExternalSessionInvocationStopped(params);
  let entries: any[];
  try {
    entries = await readdir(params.dir, { withFileTypes: true });
  } catch {
    throwIfCodexExternalSessionInvocationStopped(params);
    return new Map();
  }
  throwIfCodexExternalSessionInvocationStopped(params);

  const matchesBySessionId = new Map<string, CodexRolloutFile[]>();
  for (const entry of entries) {
    throwIfCodexExternalSessionInvocationStopped(params);
    if (!entry.isFile()) continue;
    const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;

    const filePath = join(params.dir, name);
    const sessionMeta = await readCodexSessionMetaFromRollout(filePath, params);
    throwIfCodexExternalSessionInvocationStopped(params);
    const sessionId = readNonEmptySessionId(sessionMeta?.id);
    const rootSessionId = readNonEmptySessionId(sessionMeta?.session_id);
    const matchingSessionIds = new Set<string>();
    const filenameSessionId = parseCodexRolloutSessionIdFromFilename(filePath);
    for (const candidate of [
      filenameSessionId,
      sessionMeta?.id,
      ...(params.membership === 'root_session_family'
        ? [sessionMeta?.session_id]
        : []),
    ]) {
      const normalized = typeof candidate === 'string' ? candidate.trim() : '';
      if (normalized && params.remoteSessionIds.has(normalized)) {
        matchingSessionIds.add(normalized);
      }
    }
    if (matchingSessionIds.size === 0) continue;

    const match = await describeRolloutFile({
      codexHome: params.codexHome,
      filePath,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    });
    throwIfCodexExternalSessionInvocationStopped(params);
    if (!match) continue;
    const member = {
      ...match,
      ...(sessionId ? { sessionId } : {}),
      ...(rootSessionId ? { rootSessionId } : {}),
    };
    for (const remoteSessionId of matchingSessionIds) {
      const matches = matchesBySessionId.get(remoteSessionId);
      if (matches) {
        matches.push(member);
      } else {
        matchesBySessionId.set(remoteSessionId, [member]);
      }
    }
  }

  return matchesBySessionId;
}

async function collectTargetedRolloutMatches(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  membership: CodexRolloutMembership;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutFile[] | null> {
  const likelyDayDirs = buildLikelyRolloutDayDirs({
    codexHome: params.codexHome,
    remoteSessionId: params.remoteSessionId,
    env: process.env,
  });
  if (likelyDayDirs.length === 0) return null;

  throwIfCodexExternalSessionInvocationStopped(params);
  const matches = (
    await Promise.all(
      likelyDayDirs.map((dir) => collectRolloutMatchesFromFlatDir({
        codexHome: params.codexHome,
        dir,
        remoteSessionIds: new Set([params.remoteSessionId]),
        membership: params.membership,
        signal: params.signal,
        deadlineAtMs: params.deadlineAtMs,
      })),
    )
  ).flatMap(
    (matchesBySessionId) =>
      matchesBySessionId.get(params.remoteSessionId) ?? [],
  );
  throwIfCodexExternalSessionInvocationStopped(params);
  matches.sort((a, b) => a.sortMs - b.sortMs || a.mtimeMs - b.mtimeMs);
  return matches;
}

async function collectTargetedRootSessionRolloutMatches(params: Readonly<{
  codexHome: string;
  remoteSessionIds: ReadonlySet<string>;
  signal: AbortSignal;
}> & CodexExternalSessionInvocationBounds): Promise<Map<string, CodexRolloutFile[]>> {
  const requestedIdsByDayDir = new Map<string, Set<string>>();
  for (const remoteSessionId of params.remoteSessionIds) {
    for (const dir of buildLikelyRolloutDayDirs({
      codexHome: params.codexHome,
      remoteSessionId,
      env: process.env,
    })) {
      const requestedIds = requestedIdsByDayDir.get(dir);
      if (requestedIds) {
        requestedIds.add(remoteSessionId);
      } else {
        requestedIdsByDayDir.set(dir, new Set([remoteSessionId]));
      }
    }
  }

  throwIfCodexExternalSessionInvocationStopped(params);
  const batches = await Promise.all(
    [...requestedIdsByDayDir].map(
      async ([dir, remoteSessionIds]) =>
        await collectRolloutMatchesFromFlatDir({
          codexHome: params.codexHome,
          dir,
          remoteSessionIds,
          membership: 'root_session_family',
          signal: params.signal,
          deadlineAtMs: params.deadlineAtMs,
        }),
    ),
  );
  throwIfCodexExternalSessionInvocationStopped(params);

  const matchesBySessionId = new Map<string, CodexRolloutFile[]>();
  for (const batch of batches) {
    for (const [remoteSessionId, matches] of batch) {
      const current = matchesBySessionId.get(remoteSessionId);
      if (current) {
        current.push(...matches);
      } else {
        matchesBySessionId.set(remoteSessionId, [...matches]);
      }
    }
  }
  for (const matches of matchesBySessionId.values()) {
    matches.sort((a, b) => a.sortMs - b.sortMs || a.mtimeMs - b.mtimeMs);
  }
  return matchesBySessionId;
}

async function describeRolloutFile(params: Readonly<{
  codexHome: string;
  filePath: string;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutFile | null> {
  throwIfCodexExternalSessionInvocationStopped(params);
  try {
    const s = await stat(params.filePath);
    throwIfCodexExternalSessionInvocationStopped(params);
    const fromName = parseRolloutTimestampFromFilename(params.filePath);
    const fromBirth = Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0
      ? s.birthtimeMs
      : null;
    return {
      filePath: params.filePath,
      fileRelPath: relative(params.codexHome, params.filePath),
      sortMs: Math.max(fromName ?? 0, fromBirth ?? 0, s.mtimeMs),
      mtimeMs: s.mtimeMs,
    };
  } catch {
    throwIfCodexExternalSessionInvocationStopped(params);
    return null;
  }
}

async function resolveMatchingRolloutFile(params: Readonly<{
  codexHome: string;
  filePath: string;
  remoteSessionId: string;
  membership: CodexRolloutMembership;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutFile | null> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const matchesByName = parseCodexRolloutSessionIdFromFilename(params.filePath) === params.remoteSessionId;
  if (!matchesByName) {
    const sessionMeta = await readCodexSessionMetaFromRollout(params.filePath, params);
    throwIfCodexExternalSessionInvocationStopped(params);
    if (
      sessionMeta?.id !== params.remoteSessionId
      && (
        params.membership !== 'root_session_family'
        || sessionMeta?.session_id !== params.remoteSessionId
      )
    ) {
      return null;
    }
  }

  return await describeRolloutFile(params);
}

export async function describeCodexRolloutFileSetResourceIdentity(
  params: Readonly<{
    codexHome: string;
    files: readonly Pick<CodexRolloutFile, 'filePath' | 'fileRelPath'>[];
  }> & CodexExternalSessionInvocationBounds,
): Promise<CodexSessionRolloutResourceIdentity> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const [codexHomeGeneration, sessionsGeneration, archivedSessionsGeneration, streams] =
    await Promise.all([
      readPathGenerationAsync(params.codexHome),
      readPathGenerationAsync(join(params.codexHome, 'sessions')),
      readPathGenerationAsync(join(params.codexHome, 'archived_sessions')),
      Promise.all(params.files.map(async (file) => ({
        fileRelPath: file.fileRelPath,
        physicalGeneration: await readPathGenerationAsync(file.filePath),
      }))),
    ]);
  throwIfCodexExternalSessionInvocationStopped(params);
  return {
    sourceGeneration: [
      codexHomeGeneration,
      sessionsGeneration,
      archivedSessionsGeneration,
    ],
    streams: streams.sort((left, right) =>
      left.fileRelPath.localeCompare(right.fileRelPath),
    ),
  };
}

async function collectCodexRolloutFilesByMembership(params: Readonly<{
  codexHome: string;
  remoteSessionId: string;
  membership: CodexRolloutMembership;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutFile[]> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const targetedMatches = await collectTargetedRolloutMatches(params);
  throwIfCodexExternalSessionInvocationStopped(params);
  if (targetedMatches && targetedMatches.length > 0) {
    return targetedMatches;
  }

  const matches: CodexRolloutFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    throwIfCodexExternalSessionInvocationStopped(params);
    if (depth > 10) return;
    let entries: any[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      throwIfCodexExternalSessionInvocationStopped(params);
      return;
    }
    throwIfCodexExternalSessionInvocationStopped(params);
    for (const entry of entries) {
      throwIfCodexExternalSessionInvocationStopped(params);
      if (entry.isSymbolicLink()) continue;
      const name = typeof entry.name === 'string' ? entry.name : String(entry.name);
      const full = join(dir, name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const match = await resolveMatchingRolloutFile({
        codexHome: params.codexHome,
        filePath: full,
        remoteSessionId: params.remoteSessionId,
        membership: params.membership,
        signal: params.signal,
        deadlineAtMs: params.deadlineAtMs,
      });
      throwIfCodexExternalSessionInvocationStopped(params);
      if (match) {
        matches.push(match);
      }
    }
  };

  await walk(join(params.codexHome, 'sessions'), 0);
  await walk(join(params.codexHome, 'archived_sessions'), 0);

  matches.sort((a, b) => a.sortMs - b.sortMs || a.mtimeMs - b.mtimeMs);
  return matches;
}

export async function inventoryCodexRootSessionRolloutFiles(params: Readonly<{
  codexHome: string;
  remoteSessionIds: readonly string[];
  signal: AbortSignal;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRootSessionRolloutInventory> {
  throwIfCodexExternalSessionInvocationStopped(params);
  const requestedIds = new Set(params.remoteSessionIds);
  const filesByRootSessionId = new Map<string, CodexRolloutFile[]>();
  for (const remoteSessionId of requestedIds) {
    filesByRootSessionId.set(remoteSessionId, []);
  }

  const sourceGeneration = [
    await readPathGenerationAsync(params.codexHome),
  ];
  throwIfCodexExternalSessionInvocationStopped(params);
  sourceGeneration.push(
    await readPathGenerationAsync(join(params.codexHome, 'sessions')),
  );
  throwIfCodexExternalSessionInvocationStopped(params);
  sourceGeneration.push(
    await readPathGenerationAsync(join(params.codexHome, 'archived_sessions')),
  );
  throwIfCodexExternalSessionInvocationStopped(params);

  const knownFilePaths = new Set<string>();
  const targetedMatchesBySessionId =
    await collectTargetedRootSessionRolloutMatches({
      codexHome: params.codexHome,
      remoteSessionIds: requestedIds,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    });
  for (const [remoteSessionId, targetedMatches] of targetedMatchesBySessionId) {
    if (targetedMatches.length > 0) {
      filesByRootSessionId.set(remoteSessionId, targetedMatches);
      for (const file of targetedMatches) {
        knownFilePaths.add(file.filePath);
      }
    }
  }
  const requestedStartTimes = [...requestedIds].map(
    parseRemoteSessionTimestampMs,
  );
  const earliestRequestedStartMs = requestedStartTimes.some(
    (timestampMs) => timestampMs === null,
  )
    ? null
    : Math.min(...requestedStartTimes as number[]);

  const visitedDirectories = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    throwIfCodexExternalSessionInvocationStopped(params);
    if (depth > 10) return;
    if (visitedDirectories.has(dir)) return;
    visitedDirectories.add(dir);
    let entries: any[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throwIfCodexExternalSessionInvocationStopped(params);
      return;
    }
    for (const entry of entries) {
      throwIfCodexExternalSessionInvocationStopped(params);
      if (entry.isSymbolicLink()) continue;
      const name = typeof entry.name === 'string'
        ? entry.name
        : String(entry.name);
      const full = join(dir, name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (
        !entry.isFile()
        || !name.startsWith('rollout-')
        || !name.endsWith('.jsonl')
        || knownFilePaths.has(full)
      ) {
        continue;
      }

      let metadata: Awaited<ReturnType<typeof stat>> | null = null;
      if (earliestRequestedStartMs !== null) {
        const fromName = parseRolloutTimestampFromFilename(full);
        if (
          fromName !== null
          && fromName
            < earliestRequestedStartMs
              - ROOT_SESSION_FAMILY_FILENAME_TIMEZONE_WINDOW_MS
        ) {
          continue;
        }
        if (fromName === null) {
          try {
            metadata = await stat(full);
          } catch (error) {
            throwIfCodexExternalSessionInvocationStopped(params);
            continue;
          }
          const createdAtMs = (
            Number.isFinite(metadata.birthtimeMs)
            && metadata.birthtimeMs > 0
          )
            ? metadata.birthtimeMs
            : metadata.mtimeMs;
          if (
            createdAtMs
              < earliestRequestedStartMs - ROOT_SESSION_FAMILY_CLOCK_SKEW_MS
          ) {
            continue;
          }
        }
      }

      const sessionMeta = await readCodexSessionMetaFromRollout(full, params);
      throwIfCodexExternalSessionInvocationStopped(params);
      const sessionId = readNonEmptySessionId(sessionMeta?.id);
      const metadataRootSessionId = readNonEmptySessionId(sessionMeta?.session_id);
      const discoveredRootSessionId = (
        metadataRootSessionId
        ?? sessionId
        ?? parseCodexRolloutSessionIdFromFilename(full)
      );
      if (!discoveredRootSessionId || !requestedIds.has(discoveredRootSessionId)) continue;

      try {
        metadata ??= await stat(full);
        throwIfCodexExternalSessionInvocationStopped(params);
        const fromName = parseRolloutTimestampFromFilename(full);
        const fromBirth = (
          Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs > 0
        )
          ? metadata.birthtimeMs
          : null;
        filesByRootSessionId.get(discoveredRootSessionId)?.push({
          filePath: full,
          fileRelPath: relative(params.codexHome, full),
          sortMs: Math.max(
            fromName ?? 0,
            fromBirth ?? 0,
            metadata.mtimeMs,
          ),
          mtimeMs: metadata.mtimeMs,
          ...(sessionId ? { sessionId } : {}),
          ...(metadataRootSessionId ? { rootSessionId: metadataRootSessionId } : {}),
        });
        knownFilePaths.add(full);
      } catch (error) {
        throwIfCodexExternalSessionInvocationStopped(params);
      }
    }
  };

  if (requestedIds.size > 0) {
    await walk(join(params.codexHome, 'sessions'), 0);
    await walk(join(params.codexHome, 'archived_sessions'), 0);
  }
  throwIfCodexExternalSessionInvocationStopped(params);

  return {
    sourceGeneration,
    requested: params.remoteSessionIds.map((remoteSessionId) => ({
      remoteSessionId,
      files: (filesByRootSessionId.get(remoteSessionId) ?? []).sort(
        (left, right) =>
          left.sortMs - right.sortMs
          || left.mtimeMs - right.mtimeMs
          || left.fileRelPath.localeCompare(right.fileRelPath),
      ),
    })),
  };
}

export async function collectCodexSessionRolloutFiles(
  params: Readonly<{ codexHome: string; remoteSessionId: string }> & CodexExternalSessionInvocationBounds,
): Promise<CodexRolloutFile[]> {
  return await collectCodexRolloutFilesByMembership({
    ...params,
    membership: 'exact_thread',
  });
}

export async function collectCodexRootSessionRolloutFiles(
  params: Readonly<{ codexHome: string; remoteSessionId: string }> & CodexExternalSessionInvocationBounds,
): Promise<CodexRolloutFile[]> {
  return await collectCodexRolloutFilesByMembership({
    ...params,
    membership: 'root_session_family',
  });
}
