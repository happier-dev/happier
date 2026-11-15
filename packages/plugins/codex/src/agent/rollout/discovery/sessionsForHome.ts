import { readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import {
  parseCodexRolloutFilename,
  isMatchingCodexRolloutIdentity,
  readCodexSessionMetaFromRollout,
  type CodexSessionMetaCache,
  type CodexSessionMetaPayload,
} from './indexData.js';
import {
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';
import { readExactCodexProviderSessionId } from '../../../protocol/runtimeDescriptorV1.js';

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
  // Codex recorded this id in session_meta; keep its exact bytes.
  return readExactCodexProviderSessionId(value) ?? undefined;
}

function matchingRolloutSessionIds(filePath: string, sessionMeta: Readonly<{ id?: string; session_id?: string }> | null,
  requestedIds: ReadonlySet<string>, membership: CodexRolloutMembership,
  filename = parseCodexRolloutFilename(filePath)): string[] {
  const candidates = [filename?.threadId ?? filename?.sessionId, sessionMeta?.id,
    ...(membership === 'root_session_family' ? [sessionMeta?.session_id] : [])];
  return [...requestedIds].filter(requestedId => candidates.some(candidate => {
    const recordedId = readExactCodexProviderSessionId(candidate);
    return recordedId !== null && isMatchingCodexRolloutIdentity(recordedId, requestedId);
  }));
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
  let entries: Pick<Dirent, 'name' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>[];
  try {
    entries = params.preparation ? await params.preparation.readDirectory(params.dir) : await readdir(params.dir, { withFileTypes: true });
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
    const matchingSessionIds = matchingRolloutSessionIds(filePath, sessionMeta, params.remoteSessionIds, params.membership);
    if (matchingSessionIds.length === 0) continue;

    const match = await describeRolloutFile({
      codexHome: params.codexHome,
      filePath,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
      onProgress: params.onProgress,
      preparation: params.preparation,
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
        onProgress: params.onProgress,
        preparation: params.preparation,
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

async function describeRolloutFile(params: Readonly<{
  codexHome: string;
  filePath: string;
}> & CodexExternalSessionInvocationBounds): Promise<CodexRolloutFile | null> {
  throwIfCodexExternalSessionInvocationStopped(params);
  try {
    const s = params.preparation ? await params.preparation.readMetadata(params.filePath) : await stat(params.filePath);
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
  const filename = parseCodexRolloutFilename(params.filePath);
  const matchesByName = isMatchingCodexRolloutIdentity(filename?.threadId ?? filename?.sessionId, params.remoteSessionId);
  if (!matchesByName) {
    const sessionMeta = await readCodexSessionMetaFromRollout(params.filePath, params);
    throwIfCodexExternalSessionInvocationStopped(params);
    if (
      !isMatchingCodexRolloutIdentity(sessionMeta?.id, params.remoteSessionId)
      && (
        params.membership !== 'root_session_family'
        || !isMatchingCodexRolloutIdentity(sessionMeta?.session_id, params.remoteSessionId)
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
    let entries: Pick<Dirent, 'name' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>[];
    try {
      entries = params.preparation ? await params.preparation.readDirectory(dir) : await readdir(dir, { withFileTypes: true });
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
        onProgress: params.onProgress,
        preparation: params.preparation,
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

type RolloutInventoryEntry = Readonly<{
  kind: 'directory' | 'file' | 'other';
  filePath: string;
  fileRelPath: string;
  nativeRelPath: string;
}> & {
  fromName?: number | null;
  filename?: ReturnType<typeof parseCodexRolloutFilename>;
  facts?: Readonly<{ sessionMeta: CodexSessionMetaPayload; metadata: Stats }>;
  matches?: Readonly<{ requested: string; ids: readonly string[]; file?: CodexRolloutFile }>;
};

async function readRolloutInventoryDirectory(codexHome: string, dir: string): Promise<RolloutInventoryEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) => String(left.name) < String(right.name) ? -1 : String(left.name) > String(right.name) ? 1 : 0);
  return entries.filter(entry => !entry.isSymbolicLink()).map(entry => {
    const name = String(entry.name);
    const filePath = join(dir, name);
    const nativeRelPath = relative(codexHome, filePath);
    return { kind: entry.isDirectory() ? 'directory' : entry.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl') ? 'file' : 'other',
      filePath, nativeRelPath, fileRelPath: nativeRelPath.split(sep).join('/') };
  });
}

/** Contribution-lifetime native directory facts, with no matching or transcript
 * authority. Both observation and resumable callers use the inventory below. */
export class CodexRolloutObservationInventory {
  private readonly directories = new Map<string, Readonly<{ signature: string; physicalPath: string; entries: RolloutInventoryEntry[] }>>();
  readonly sessionMetaCache: CodexSessionMetaCache = new Map();

  clear(): void { this.directories.clear(); this.sessionMetaCache.clear(); }

  invalidate(changedFiles?: readonly string[]): void {
    const changed = changedFiles === undefined ? null : new Set(changedFiles);
    if (changed?.size === 0) return;
    for (const directory of this.directories.values()) for (const entry of directory.entries) {
      if (!changed || changed.has(entry.filePath) || changed.has(join(directory.physicalPath, basename(entry.filePath)))) {
        entry.facts = undefined; entry.matches = undefined;
      }
    }
  }

  async readDirectory(codexHome: string, dir: string): Promise<RolloutInventoryEntry[]> {
    const metadata = await stat(dir, { bigint: true });
    const signature = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
    const remembered = this.directories.get(dir);
    if (remembered?.signature === signature) return remembered.entries;
    const entries = await readRolloutInventoryDirectory(codexHome, dir);
    // Directory mtime changes on sibling creation, not on filename mutation.
    // Preserve lexical facts for surviving paths instead of reparsing every
    // sibling when a new rollout joins today's directory.
    const prior = new Map(remembered?.entries.map(entry => [entry.filePath, entry]));
    for (const entry of entries) {
      const previous = prior.get(entry.filePath);
      if (previous?.kind === entry.kind) {
        entry.fromName = previous.fromName;
        entry.filename = previous.filename;
        entry.facts = previous.facts;
        entry.matches = previous.matches;
      }
    }
    this.directories.set(dir, { signature, physicalPath: await realpath(dir), entries });
    return entries;
  }

  retainDirectories(visited: ReadonlySet<string>): void {
    for (const dir of this.directories.keys()) if (!visited.has(dir)) this.directories.delete(dir);
    const files = new Set([...this.directories.values()].flatMap(directory => directory.entries.map(entry => entry.filePath)));
    for (const file of this.sessionMetaCache.keys()) if (!files.has(file)) this.sessionMetaCache.delete(file);
  }
}

/** The existing observation demand owns these facts. Transcript reads may use
 * them only while that demand is live, and still validate native file versions. */
export class CodexRolloutObservationInventories {
  private readonly demands = new Map<AbortSignal, Map<string, CodexRolloutObservationInventory>>();

  observe(codexHome: string, lifetime: AbortSignal): CodexRolloutObservationInventory {
    lifetime.throwIfAborted();
    let homes = this.demands.get(lifetime);
    if (!homes) {
      homes = new Map();
      this.demands.set(lifetime, homes);
      const owned = homes;
      lifetime.addEventListener('abort', () => {
        for (const inventory of owned.values()) inventory.clear();
        owned.clear();
        this.demands.delete(lifetime);
      }, { once: true });
    }
    let inventory = homes.get(codexHome);
    if (!inventory) {
      inventory = new CodexRolloutObservationInventory();
      homes.set(codexHome, inventory);
    }
    return inventory;
  }

  read(codexHome: string): CodexRolloutObservationInventory | undefined {
    for (const homes of this.demands.values()) {
      const inventory = homes.get(codexHome);
      if (inventory) return inventory;
    }
    return undefined;
  }
}

export const codexRolloutObservationInventories = new CodexRolloutObservationInventories();

export async function inventoryCodexRootSessionRolloutFiles(params: Readonly<{
  codexHome: string;
  remoteSessionIds: readonly string[];
  signal: AbortSignal;
  observationInventory?: CodexRolloutObservationInventory;
  changedFiles?: readonly string[];
}> & CodexExternalSessionInvocationBounds): Promise<CodexRootSessionRolloutInventory> {
  throwIfCodexExternalSessionInvocationStopped(params);
  params.observationInventory?.invalidate(params.changedFiles);
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

  const preparation = params.preparation;
  const progress = preparation?.rootInventory(params.codexHome, params.remoteSessionIds, sourceGeneration);
  // Resume facts are locators, not authority. Re-authorize selected paths on
  // every invocation; unrelated completed heads need no further native I/O.
  const nativeBounds = { ...params, preparation: undefined,
    sessionMetaCache: params.observationInventory?.sessionMetaCache };
  const inventoryIds = new Set(progress?.requestedIds ?? requestedIds);
  const requestedIdentity = JSON.stringify([...inventoryIds].sort());
  const requestedStartTimes = [...inventoryIds].map(
    parseRemoteSessionTimestampMs,
  );
  const earliestRequestedStartMs = requestedStartTimes.some(
    (timestampMs) => timestampMs === null,
  )
    ? null
    : Math.min(...requestedStartTimes as number[]);

  // Compare path components in the same order as the sorted depth-first walk.
  // Whole-string comparison would misorder `a/x` and its sibling `a.jsonl`.
  const comparePaths = (left: string, right: string) => {
    const a = left.split('/');
    const b = right.split('/');
    if (a[0] !== b[0]) return a[0] === 'sessions' ? -1 : 1;
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  const resumeAfter = progress?.afterPath;
  const visitedDirectories = new Set<string>();
  const commitFile = (path: string) => {
    if (!progress || !preparation) return;
    progress.afterPath = path;
    preparation.control.checkWork();
  };
  // Codex creates a family member (a subagent thread) while an earlier member
  // is still being written: the spawner records the spawn after the child
  // exists. Without a resumable preparation cursor, heads past the family's
  // latest write (plus the local-time filename window) cannot hold a member and
  // stay unread. Codex resume appends to the thread's existing rollout, which
  // moves that member's last write. Members named by their file and revert
  // rollouts are always read, and each member found widens the window, so later
  // children are still found. Ids without a UUIDv7 start read every head.
  const deferUnreadHeads = !progress && earliestRequestedStartMs !== null;
  const deferredHeads: RolloutInventoryEntry[] = [];
  let familyLastWriteMs = earliestRequestedStartMs ?? 0;
  const classifyHead = async (entry: RolloutInventoryEntry, knownMetadata: Readonly<{ birthtimeMs: number; mtimeMs: number }> | null): Promise<void> => {
    const full = entry.filePath;
    const fileRelPath = entry.fileRelPath;
    let metadata = knownMetadata;
    await preparation?.authorize(full);
    const sessionMeta = entry.facts?.sessionMeta ?? await readCodexSessionMetaFromRollout(full, nativeBounds);
    throwIfCodexExternalSessionInvocationStopped(nativeBounds);
    const sessionId = readNonEmptySessionId(sessionMeta?.id);
    const metadataRootSessionId = readNonEmptySessionId(sessionMeta?.session_id);
    const matchingIds = matchingRolloutSessionIds(full, sessionMeta, inventoryIds, 'root_session_family', entry.filename);
    try {
      const current = entry.facts?.metadata ?? await stat(full);
      // Null/incomplete heads are retried; complete facts belong only to the
      // live observation demand and invalidate on named writes or topology.
      if (sessionMeta) entry.facts = { sessionMeta, metadata: current };
      if (matchingIds.length === 0) {
        entry.matches = { requested: requestedIdentity, ids: [] };
        commitFile(fileRelPath); return;
      }
      metadata ??= current;
      throwIfCodexExternalSessionInvocationStopped(nativeBounds);
      const fromName = entry.fromName;
      const fromBirth = (
        Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs > 0
      )
        ? metadata.birthtimeMs
        : null;
      const file = {
        filePath: full,
        fileRelPath: entry.nativeRelPath,
        sortMs: Math.max(
          fromName ?? 0,
          fromBirth ?? 0,
          metadata.mtimeMs,
        ),
        mtimeMs: metadata.mtimeMs,
        ...(sessionId ? { sessionId } : {}),
        ...(metadataRootSessionId ? { rootSessionId: metadataRootSessionId } : {}),
      };
      entry.matches = { requested: requestedIdentity, ids: matchingIds, file };
      familyLastWriteMs = Math.max(familyLastWriteMs, file.mtimeMs);
      if (progress) progress.files.push({ ref: { home: progress.home, path: fileRelPath }, matchingIds, generation: formatPhysicalGeneration(current),
        sortMs: file.sortMs, mtimeMs: file.mtimeMs });
      else for (const id of matchingIds) filesByRootSessionId.get(id)?.push(file);
    } catch (error) {
      throwIfCodexExternalSessionInvocationStopped(params);
    }
    commitFile(fileRelPath);
  };
  // Codex files a rollout under `sessions/YYYY/MM/DD` for the same local date its
  // file name carries, so a dated directory that ends before the filename
  // window of the earliest requested start holds only rollouts the walk skips.
  const endsBeforeRequestedStart = (dirRelPath: string): boolean => {
    if (earliestRequestedStartMs === null) return false;
    const match = /^sessions\/(\d{4})(?:\/(\d{2})(?:\/(\d{2}))?)?$/.exec(dirRelPath);
    if (!match) return false;
    const year = Number(match[1]);
    const month = match[2] === undefined ? null : Number(match[2]);
    const day = match[3] === undefined ? null : Number(match[3]);
    const endMs = month === null ? Date.UTC(year + 1, 0, 1)
      : day === null ? Date.UTC(year, month, 1)
      : Date.UTC(year, month - 1, day + 1);
    return endMs <= earliestRequestedStartMs - ROOT_SESSION_FAMILY_FILENAME_TIMEZONE_WINDOW_MS;
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    throwIfCodexExternalSessionInvocationStopped(nativeBounds);
    if (depth > 10) return;
    let entries: RolloutInventoryEntry[];
    try {
      await preparation?.authorize(dir);
      entries = params.observationInventory
        ? await params.observationInventory.readDirectory(params.codexHome, dir)
        : await readRolloutInventoryDirectory(params.codexHome, dir);
      visitedDirectories.add(dir);
    } catch (error) {
      throwIfCodexExternalSessionInvocationStopped(params);
      // Unreadable storage is not evidence that a previously indexed rollout
      // disappeared. Only actual missing paths establish absence.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      return;
    }
    for (const entry of entries) {
      throwIfCodexExternalSessionInvocationStopped(nativeBounds);
      const full = entry.filePath;
      const fileRelPath = entry.fileRelPath;
      if (resumeAfter && comparePaths(fileRelPath, resumeAfter) <= 0
        && !(entry.kind === 'directory' && resumeAfter.startsWith(`${fileRelPath}/`))) continue;
      if (entry.kind === 'directory') {
        if (!endsBeforeRequestedStart(fileRelPath)) await walk(full, depth + 1);
        continue;
      }
      if (entry.kind !== 'file') continue;
      if (entry.facts && entry.matches?.requested === requestedIdentity) {
        const { file, ids } = entry.matches;
        if (file) {
          familyLastWriteMs = Math.max(familyLastWriteMs, file.mtimeMs);
          for (const id of ids) filesByRootSessionId.get(id)?.push(file);
        }
        continue;
      }
      // Parse only past the cursor frontier, retaining the facts for observed
      // directories without redoing completed-prefix work on resumed scans.
      if (entry.fromName === undefined) entry.fromName = parseRolloutTimestampFromFilename(full);
      if (entry.filename === undefined) entry.filename = parseCodexRolloutFilename(full);

      let metadata: Readonly<{ birthtimeMs: number; mtimeMs: number }> | null = null;
      if (earliestRequestedStartMs !== null) {
        const fromName = entry.fromName;
        if (
          fromName !== null
          && fromName
            < earliestRequestedStartMs
              - ROOT_SESSION_FAMILY_FILENAME_TIMEZONE_WINDOW_MS
        ) {
          commitFile(fileRelPath);
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
            commitFile(fileRelPath);
            continue;
          }
        }
      }

      // A `<thread>_<rollout>` name is a revert's new immutable rollout, written
      // whenever a thread is reverted, so it is always read.
      if (deferUnreadHeads && !entry.facts && entry.fromName !== null && !entry.filename?.turnId
        && matchingRolloutSessionIds(full, null, inventoryIds, 'root_session_family', entry.filename).length === 0) {
        deferredHeads.push(entry);
        continue;
      }
      await classifyHead(entry, metadata);
    }
  };

  if (requestedIds.size > 0 && !progress?.complete) {
    const scan = async () => {
      // Preserve active-before-archived discovery and its cancellation boundary.
      await walk(join(params.codexHome, 'sessions'), 0);
      await walk(join(params.codexHome, 'archived_sessions'), 0);
      deferredHeads.sort((left, right) => left.fromName! - right.fromName!);
      for (const entry of deferredHeads) {
        throwIfCodexExternalSessionInvocationStopped(nativeBounds);
        if (entry.fromName! > familyLastWriteMs + ROOT_SESSION_FAMILY_FILENAME_TIMEZONE_WINDOW_MS + ROOT_SESSION_FAMILY_CLOCK_SKEW_MS) break;
        await classifyHead(entry, null);
      }
      if (progress) progress.complete = true;
      return true;
    };
    if (preparation) await preparation.control.prepare(scan);
    else await scan();
  }
  params.observationInventory?.retainDirectories(visitedDirectories);
  throwIfCodexExternalSessionInvocationStopped(params);
  for (const file of progress?.files ?? []) {
    const filePath = join(params.codexHome, ...file.ref.path.split('/'));
    await preparation?.authorize(filePath);
    const current = await stat(filePath).catch(() => null);
    const sessionMeta = await readCodexSessionMetaFromRollout(filePath, nativeBounds);
    const currentIds = matchingRolloutSessionIds(filePath, sessionMeta, inventoryIds, 'root_session_family');
    if (!current || formatPhysicalGeneration(current) !== file.generation || file.matchingIds.some(id => !currentIds.includes(id))) {
      preparation!.invalidate();
    }
    const member = { filePath, fileRelPath: relative(params.codexHome, filePath), sortMs: file.sortMs, mtimeMs: file.mtimeMs,
      ...(sessionMeta?.id ? { sessionId: sessionMeta.id } : {}), ...(sessionMeta?.session_id ? { rootSessionId: sessionMeta.session_id } : {}) };
    for (const id of file.matchingIds) filesByRootSessionId.get(id)?.push(member);
  }

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
