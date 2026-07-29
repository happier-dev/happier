import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  scanJsonlSessionFile,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';
import {
  deriveExternalSessionActivity,
  type ExternalSessionCandidateV1,
  type ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import { resolveOhMyPiSessionsRoot } from './files.js';
import { resolveOhMyPiAgentDir } from './source.js';

type CandidatePreparation = Readonly<{
  kind: 'building_candidate_index';
  scanned: number;
}>;

export type OhMyPiCandidateResultBudget = Readonly<{
  fits(
    candidates: readonly ExternalSessionCandidateV1[],
    nextCursor: string | null,
    searchIncomplete: boolean | undefined,
    preparation: CandidatePreparation | undefined,
  ): boolean;
}>;

type CandidateScanPosition = Readonly<{
  rootEntryOffset: number;
  rootName: string | null;
  rootGeneration: string | null;
  fileEntryOffset: number;
}>;

type CandidateCursorV2 = Readonly<{
  v: 2;
  kind: 'ohMyPiCandidateIndexScan';
  sourceGeneration: string;
  phase: 'scan' | 'verify';
  position: CandidateScanPosition;
  scanned: number;
  aggregateXor: string;
  aggregateCount: number;
  expectedAggregateXor?: string;
  expectedAggregateCount?: number;
}>;

type FileIdentity = Readonly<{
  dev: string;
  ino: string;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}>;

const GENERATION_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const EMPTY_AGGREGATE_XOR = Buffer.alloc(12).toString('base64url');

export class OhMyPiCandidateInvalidCursorError extends Error {
  readonly name = 'OhMyPiCandidateInvalidCursorError';
}

export class OhMyPiCandidateResultBudgetTooSmallError extends Error {
  readonly name = 'OhMyPiCandidateResultBudgetTooSmallError';
}

export class OhMyPiCandidateSourceChangedError extends Error {
  readonly name = 'OhMyPiCandidateSourceChangedError';
}

function encodeCandidateCursor(cursor: CandidateCursorV2): string {
  return [
    'omp2',
    cursor.phase === 'scan' ? 's' : 'v',
    cursor.sourceGeneration,
    cursor.position.rootEntryOffset.toString(36),
    cursor.position.rootName
      ? Buffer.from(cursor.position.rootName, 'utf8').toString('base64url')
      : '-',
    cursor.position.rootGeneration ?? '-',
    cursor.position.fileEntryOffset.toString(36),
    cursor.scanned.toString(36),
    cursor.aggregateXor,
    cursor.aggregateCount.toString(36),
    cursor.expectedAggregateXor ?? '-',
    cursor.expectedAggregateCount?.toString(36) ?? '-',
  ].join('.');
}

function isPosition(value: unknown): value is CandidateScanPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.rootEntryOffset)
    && (record.rootEntryOffset as number) >= 0
    && (record.rootName === null || (typeof record.rootName === 'string' && record.rootName.length > 0))
    && (record.rootGeneration === null || (typeof record.rootGeneration === 'string' && record.rootGeneration.length > 0))
    && ((record.rootName === null) === (record.rootGeneration === null))
    && Number.isSafeInteger(record.fileEntryOffset)
    && (record.fileEntryOffset as number) >= 0;
}

function decodeCandidateCursor(raw: string | undefined): CandidateCursorV2 | null {
  if (!raw?.trim()) return null;
  try {
    const value = raw.split('.');
    if (value.length !== 12) return null;
    const [
      version,
      rawPhase,
      sourceGeneration,
      rootEntryOffset,
      rootName,
      rootGeneration,
      fileEntryOffset,
      scanned,
      aggregateXor,
      aggregateCount,
      expectedAggregateXor,
      expectedAggregateCount,
    ] = value;
    const phase = rawPhase === 's' ? 'scan' : rawPhase === 'v' ? 'verify' : null;
    const parseInteger = (input: string | undefined): number | null => {
      if (!input || !/^[0-9a-z]+$/.test(input)) return null;
      const parsed = Number.parseInt(input, 36);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    };
    const parsedRootOffset = parseInteger(rootEntryOffset);
    const parsedFileOffset = parseInteger(fileEntryOffset);
    const parsedScanned = parseInteger(scanned);
    const parsedAggregateCount = parseInteger(aggregateCount);
    const parsedExpectedCount = expectedAggregateCount === '-'
      ? null
      : parseInteger(expectedAggregateCount);
    const parsedRootName = rootName === '-'
      ? null
      : Buffer.from(rootName ?? '', 'base64url').toString('utf8');
    const parsedRootGeneration = rootGeneration === '-' ? null : rootGeneration;
    if (
      rootName !== '-'
      && (
        !rootName
        || !parsedRootName
        || Buffer.from(parsedRootName, 'utf8').toString('base64url') !== rootName
      )
    ) return null;
    const position = {
      rootEntryOffset: parsedRootOffset,
      rootName: parsedRootName,
      rootGeneration: parsedRootGeneration,
      fileEntryOffset: parsedFileOffset,
    };
    if (
      version !== 'omp2'
      || phase === null
      || typeof sourceGeneration !== 'string'
      || !GENERATION_PATTERN.test(sourceGeneration)
      || !isPosition(position)
      || (
        position.rootGeneration !== null
        && !GENERATION_PATTERN.test(position.rootGeneration)
      )
      || parsedScanned === null
      || typeof aggregateXor !== 'string'
      || !GENERATION_PATTERN.test(aggregateXor)
      || parsedAggregateCount === null
    ) return null;
    if (
      phase === 'scan'
      && (expectedAggregateXor !== '-' || expectedAggregateCount !== '-')
    ) return null;
    if (phase === 'verify' && (
      typeof expectedAggregateXor !== 'string'
      || !GENERATION_PATTERN.test(expectedAggregateXor)
      || parsedExpectedCount === null
    )) return null;
    return {
      v: 2,
      kind: 'ohMyPiCandidateIndexScan',
      sourceGeneration,
      phase,
      position,
      scanned: parsedScanned,
      aggregateXor,
      aggregateCount: parsedAggregateCount,
      ...(phase === 'verify' ? {
        expectedAggregateXor: expectedAggregateXor as string,
        expectedAggregateCount: parsedExpectedCount as number,
      } : {}),
    };
  } catch {
    return null;
  }
}

function fileIdentity(metadata: Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
}>): FileIdentity {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    birthtimeMs: metadata.birthtimeMs,
    mtimeMs: metadata.mtimeMs,
    size: metadata.size,
  };
}

function formatPhysicalGeneration(metadata: Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
  mtimeMs: number;
}>): string {
  return createHash('sha256').update([
    String(metadata.dev),
    String(metadata.ino),
    String(metadata.birthtimeMs),
    String(metadata.mtimeMs),
  ].join(':'), 'utf8').digest().subarray(0, 12).toString('base64url');
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

function updateAggregate(
  currentXor: string,
  currentCount: number,
  value: string,
): Readonly<{ xor: string; count: number }> {
  const left = Buffer.from(currentXor, 'base64url');
  const right = createHash('sha256').update(value, 'utf8').digest().subarray(0, 12);
  const combined = Buffer.alloc(12);
  for (let index = 0; index < combined.length; index += 1) {
    combined[index] = (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return { xor: combined.toString('base64url'), count: currentCount + 1 };
}

function cursorAt(params: Readonly<{
  sourceGeneration: string;
  phase: 'scan' | 'verify';
  position: CandidateScanPosition;
  scanned: number;
  aggregateXor: string;
  aggregateCount: number;
  expectedAggregateXor?: string;
  expectedAggregateCount?: number;
}>): string {
  return encodeCandidateCursor({
    v: 2,
    kind: 'ohMyPiCandidateIndexScan',
    ...params,
  });
}

function preparation(scanned: number, searchTerm: string): CandidatePreparation | undefined {
  return searchTerm
    ? undefined
    : { kind: 'building_candidate_index', scanned };
}

function searchIncomplete(searchTerm: string, hasMore: boolean): true | undefined {
  return searchTerm && hasMore ? true : undefined;
}

function throwSourceChanged(): never {
  throw new OhMyPiCandidateSourceChangedError(
    'Oh My Pi candidate source changed while building its exact index.',
  );
}

async function inspectCandidateFile(params: Readonly<{
  filePath: string;
  sessionRoot: string;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  searchTerm: string;
}>): Promise<Readonly<{
  candidate: ExternalSessionCandidateV1 | null;
  identityToken: string;
}>> {
  const beforeMetadata = await lstat(params.filePath);
  if (!beforeMetadata.isFile() || beforeMetadata.isSymbolicLink()) {
    return {
      candidate: null,
      identityToken: `${params.filePath}\u0000not-file`,
    };
  }
  const before = fileIdentity(beforeMetadata);
  const scanned = await scanJsonlSessionFile(params.filePath);
  const afterMetadata = await lstat(params.filePath);
  const after = fileIdentity(afterMetadata);
  if (
    !afterMetadata.isFile()
    || afterMetadata.isSymbolicLink()
    || !sameFileIdentity(before, after)
  ) throwSourceChanged();
  const identityToken = `${params.filePath}\u0000${JSON.stringify(after)}`;
  if (!scanned) return { candidate: null, identityToken };
  const haystack = [
    scanned.sessionId,
    scanned.title ?? '',
    scanned.cwd ?? '',
    basename(params.sessionRoot),
  ].join(' ').toLowerCase();
  if (params.searchTerm && !haystack.includes(params.searchTerm)) {
    return { candidate: null, identityToken };
  }
  return {
    candidate: {
      remoteSessionId: scanned.sessionId,
      ...(scanned.title ? { title: scanned.title } : {}),
      updatedAtMs: scanned.lastActivityAtMs || Math.trunc(afterMetadata.mtimeMs),
      ...(typeof scanned.createdAtMs === 'number' ? { createdAtMs: scanned.createdAtMs } : {}),
      activity: deriveExternalSessionActivity({
        updatedAtMs: scanned.lastActivityAtMs || Math.trunc(afterMetadata.mtimeMs),
        env: params.env,
      }),
      details: {
        workingDirectory: scanned.cwd,
        agentDir: params.agentDir,
        sessionFilePath: params.filePath,
      },
    },
    identityToken,
  };
}

export async function listOhMyPiSessionCandidates(params: Readonly<{
  source: ExternalSessionsSource;
  env?: NodeJS.ProcessEnv;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  signal?: AbortSignal;
  resultBudget?: OhMyPiCandidateResultBudget;
}>): Promise<Readonly<{
  candidates: ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: true;
  preparation?: CandidatePreparation;
}>> {
  params.signal?.throwIfAborted();
  const env = params.env ?? process.env;
  const agentDir = resolveOhMyPiAgentDir({ source: params.source, env });
  const sessionsRoot = await resolveOhMyPiSessionsRoot({ source: params.source, env });
  const searchTerm = typeof params.searchTerm === 'string'
    ? params.searchTerm.trim().toLowerCase()
    : '';
  const limit = Math.max(1, Math.trunc(params.limit));
  const decoded = params.cursor ? decodeCandidateCursor(params.cursor) : null;
  if (params.cursor && !decoded) {
    throw new OhMyPiCandidateInvalidCursorError('Invalid Oh My Pi candidate cursor.');
  }

  const sessionsRootMetadata = await lstat(sessionsRoot).catch(() => null);
  if (!sessionsRootMetadata?.isDirectory() || sessionsRootMetadata.isSymbolicLink()) {
    if (decoded) throwSourceChanged();
    return {
      candidates: [],
      nextCursor: null,
      ...(searchTerm ? {} : { preparation: { kind: 'building_candidate_index', scanned: 0 } }),
    };
  }
  const sourceGeneration = formatPhysicalGeneration(sessionsRootMetadata);
  if (
      decoded
    && decoded.sourceGeneration !== sourceGeneration
  ) throwSourceChanged();

  const phase = decoded?.phase ?? 'scan';
  let position: CandidateScanPosition = decoded?.position ?? {
    rootEntryOffset: 0,
    rootName: null,
    rootGeneration: null,
    fileEntryOffset: 0,
  };
  let scanned = decoded?.scanned ?? 0;
  let aggregateXor = decoded?.aggregateXor ?? EMPTY_AGGREGATE_XOR;
  let aggregateCount = decoded?.aggregateCount ?? 0;
  const expectedAggregateXor = decoded?.expectedAggregateXor;
  const expectedAggregateCount = decoded?.expectedAggregateCount;
  const candidates: ExternalSessionCandidateV1[] = [];
  let inspectedEntries = 0;
  let inspectedRoots = 0;
  const rootDirectory = await opendir(sessionsRoot);
  try {
    let currentRootOffset = 0;
    for await (const rootEntry of rootDirectory) {
      params.signal?.throwIfAborted();
      if (currentRootOffset < position.rootEntryOffset) {
        currentRootOffset += 1;
        continue;
      }
      if (inspectedRoots >= limit) {
        const nextCursor = cursorAt({
          sourceGeneration,
          phase,
          position: {
            rootEntryOffset: currentRootOffset,
            rootName: null,
            rootGeneration: null,
            fileEntryOffset: 0,
          },
          scanned,
          aggregateXor,
          aggregateCount,
          ...(phase === 'verify' ? { expectedAggregateXor, expectedAggregateCount } : {}),
        });
        return {
          candidates,
          nextCursor,
          ...(searchIncomplete(searchTerm, true) ? { searchIncomplete: true } : {}),
          ...(preparation(scanned, searchTerm) ? { preparation: preparation(scanned, searchTerm) } : {}),
        };
      }
      inspectedRoots += 1;
      const rootPath = join(sessionsRoot, rootEntry.name);
      const rootMetadata = await lstat(rootPath).catch(() => null);
      if (
        !rootEntry.isDirectory()
        || rootEntry.isSymbolicLink()
        || !rootMetadata?.isDirectory()
        || rootMetadata.isSymbolicLink()
      ) {
        currentRootOffset += 1;
        position = {
          rootEntryOffset: currentRootOffset,
          rootName: null,
          rootGeneration: null,
          fileEntryOffset: 0,
        };
        continue;
      }
      const rootGeneration = formatPhysicalGeneration(rootMetadata);
      if (
        position.rootEntryOffset === currentRootOffset
        && position.rootName !== null
        && (
          position.rootName !== rootEntry.name
          || position.rootGeneration !== rootGeneration
        )
      ) throwSourceChanged();

      const sessionDirectory = await opendir(rootPath);
      let fileOffset = 0;
      try {
        for await (const fileEntry of sessionDirectory) {
          params.signal?.throwIfAborted();
          if (fileOffset < position.fileEntryOffset) {
            fileOffset += 1;
            continue;
          }
          if (inspectedEntries >= limit) {
            const currentRootMetadata = await lstat(rootPath).catch(() => null);
            if (
              !currentRootMetadata?.isDirectory()
              || formatPhysicalGeneration(currentRootMetadata) !== rootGeneration
            ) throwSourceChanged();
            const nextCursor = cursorAt({
              sourceGeneration,
              phase,
              position: {
                rootEntryOffset: currentRootOffset,
                rootName: rootEntry.name,
                rootGeneration,
                fileEntryOffset: fileOffset,
              },
              scanned,
              aggregateXor,
              aggregateCount,
              ...(phase === 'verify' ? { expectedAggregateXor, expectedAggregateCount } : {}),
            });
            return {
              candidates,
              nextCursor,
              ...(searchIncomplete(searchTerm, true) ? { searchIncomplete: true } : {}),
              ...(preparation(scanned, searchTerm) ? { preparation: preparation(scanned, searchTerm) } : {}),
            };
          }
          inspectedEntries += 1;
          scanned += 1;
          fileOffset += 1;
          if (
            !fileEntry.isFile()
            || fileEntry.isSymbolicLink()
            || !fileEntry.name.endsWith('.jsonl')
          ) continue;

          const filePath = join(rootPath, fileEntry.name);
          const cursorBeforeCandidate = cursorAt({
            sourceGeneration,
            phase,
            position: {
              rootEntryOffset: currentRootOffset,
              rootName: rootEntry.name,
              rootGeneration,
              fileEntryOffset: fileOffset - 1,
            },
            scanned: scanned - 1,
            aggregateXor,
            aggregateCount,
            ...(phase === 'verify' ? { expectedAggregateXor, expectedAggregateCount } : {}),
          });
          let identityToken: string;
          let candidate: ExternalSessionCandidateV1 | null = null;
          if (phase === 'scan') {
            const inspected = await inspectCandidateFile({
              filePath,
              sessionRoot: rootPath,
              agentDir,
              env,
              searchTerm,
            }).catch((error: unknown) => {
              if (error instanceof OhMyPiCandidateSourceChangedError) throw error;
              return null;
            });
            if (!inspected) continue;
            identityToken = inspected.identityToken;
            candidate = inspected.candidate;
          } else {
            const metadata = await lstat(filePath).catch(() => null);
            if (!metadata?.isFile() || metadata.isSymbolicLink()) {
              identityToken = `${filePath}\u0000not-file`;
            } else {
              identityToken = `${filePath}\u0000${JSON.stringify(fileIdentity(metadata))}`;
            }
          }
          const aggregate = updateAggregate(aggregateXor, aggregateCount, identityToken);
          aggregateXor = aggregate.xor;
          aggregateCount = aggregate.count;
          if (!candidate) continue;

          const nextCursor = cursorAt({
            sourceGeneration,
            phase,
            position: {
              rootEntryOffset: currentRootOffset,
              rootName: rootEntry.name,
              rootGeneration,
              fileEntryOffset: fileOffset,
            },
            scanned,
            aggregateXor,
            aggregateCount,
          });
          const nextPreparation = preparation(scanned, searchTerm);
          const nextSearchIncomplete = searchIncomplete(searchTerm, true);
          const proposed = [...candidates, candidate];
          if (!params.resultBudget || params.resultBudget.fits(
            proposed,
            nextCursor,
            nextSearchIncomplete,
            nextPreparation,
          )) {
            candidates.push(candidate);
            continue;
          }
          const { title: _discardedTitle, ...candidateWithoutTitle } = candidate;
          const withoutTitle = [...candidates, candidateWithoutTitle];
          if (params.resultBudget.fits(
            withoutTitle,
            nextCursor,
            nextSearchIncomplete,
            nextPreparation,
          )) {
            candidates.push(candidateWithoutTitle);
            continue;
          }
          if (candidates.length === 0) {
            throw new OhMyPiCandidateResultBudgetTooSmallError(
              'Oh My Pi candidate result byte budget cannot fit one candidate.',
            );
          }
          return {
            candidates,
            nextCursor: cursorBeforeCandidate,
            ...(searchIncomplete(searchTerm, true) ? { searchIncomplete: true } : {}),
            ...(preparation(scanned - 1, searchTerm)
              ? { preparation: preparation(scanned - 1, searchTerm) }
              : {}),
          };
        }
      } finally {
        await sessionDirectory.close().catch(() => undefined);
      }
      const currentRootMetadata = await lstat(rootPath).catch(() => null);
      if (
        !currentRootMetadata?.isDirectory()
        || formatPhysicalGeneration(currentRootMetadata) !== rootGeneration
      ) throwSourceChanged();
      currentRootOffset += 1;
      position = {
        rootEntryOffset: currentRootOffset,
        rootName: null,
        rootGeneration: null,
        fileEntryOffset: 0,
      };
    }
  } finally {
    await rootDirectory.close().catch(() => undefined);
  }

  const finalSessionsRootMetadata = await lstat(sessionsRoot).catch(() => null);
  if (
    !finalSessionsRootMetadata?.isDirectory()
    || formatPhysicalGeneration(finalSessionsRootMetadata) !== sourceGeneration
  ) throwSourceChanged();

  if (searchTerm) {
    return { candidates, nextCursor: null };
  }
  if (phase === 'scan') {
    const nextCursor = cursorAt({
      sourceGeneration,
      phase: 'verify',
      position: {
        rootEntryOffset: 0,
        rootName: null,
        rootGeneration: null,
        fileEntryOffset: 0,
      },
      scanned,
      aggregateXor: EMPTY_AGGREGATE_XOR,
      aggregateCount: 0,
      expectedAggregateXor: aggregateXor,
      expectedAggregateCount: aggregateCount,
    });
    return {
      candidates,
      nextCursor,
      preparation: { kind: 'building_candidate_index', scanned },
    };
  }
  if (
    aggregateXor !== expectedAggregateXor
    || aggregateCount !== expectedAggregateCount
  ) throwSourceChanged();
  return {
    candidates: [],
    nextCursor: null,
    preparation: { kind: 'building_candidate_index', scanned },
  };
}
