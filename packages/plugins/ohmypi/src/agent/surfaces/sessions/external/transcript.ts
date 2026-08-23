import { stat } from 'node:fs/promises';

import {
  readJsonlAfterCursor,
  readJsonlFileBackwardPage,
} from '@happier-dev/plugin-sdk/sessions/file-stores';
import type {
  JsonlScannerFileSystem as JsonlScannerFileSystemV1,
} from '@happier-dev/plugin-sdk/sessions/file-stores';

import {
  decodeOhMyPiTranscriptCursor,
  encodeOhMyPiTranscriptCursor,
  parseOhMyPiJsonlLine,
  projectOhMyPiSessionSnapshotToDirectMessages,
} from '../../../transcripts/snapshot.js';
import {
  formatOhMyPiSessionFileGeneration,
  resolveOhMyPiSessionFile,
} from './files.js';
import type { OhMyPiExternalSessionSource } from './source.js';

type OhMyPiRawTranscriptItem =
  ReturnType<typeof projectOhMyPiSessionSnapshotToDirectMessages>['items'][number];

export type OhMyPiRawTranscriptPage = Readonly<{
  items: readonly OhMyPiRawTranscriptItem[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
}>;

type PagingParams = Readonly<{
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
}>;

type OhMyPiTranscriptCursorV1 = Readonly<{
  v: 1;
  kind: 'ohMyPiTree';
  mode: 'page' | 'tail';
  generation: string;
  position: number;
  leafEntryId: string | null;
  tailLeafEntryId?: string | null;
  itemEndExclusive?: number;
  itemStartIndex?: number;
  sourceSize?: number;
  sourceMtimeMs?: number;
}>;

export class OhMyPiExternalSessionSourceChangedError extends Error {
  constructor(message = 'Oh My Pi external-session source changed.') {
    super(message);
    this.name = 'OhMyPiExternalSessionSourceChangedError';
  }
}

export class OhMyPiExternalSessionSourceUnavailableError extends Error {
  constructor(message = 'Oh My Pi external-session source is unavailable.') {
    super(message);
    this.name = 'OhMyPiExternalSessionSourceUnavailableError';
  }
}

/**
 * The branch reached the first byte of its source with a parent entry that no
 * record in the file supplies. The reachable suffix is not the transcript, and
 * publishing it as ordinary completion presents a partial history as complete.
 */
export class OhMyPiExternalSessionIncompleteBranchError extends Error {
  constructor(
    message = 'Oh My Pi transcript branch reaches the start of its source with an unresolved parent entry.',
  ) {
    super(message);
    this.name = 'OhMyPiExternalSessionIncompleteBranchError';
  }
}

export class OhMyPiExternalSessionInvalidCursorError extends Error {
  constructor(message = 'Oh My Pi external-session cursor is invalid.') {
    super(message);
    this.name = 'OhMyPiExternalSessionInvalidCursorError';
  }
}

function encodeOhMyPiTreeCursor(cursor: OhMyPiTranscriptCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeOhMyPiTreeCursor(raw: string | null | undefined): OhMyPiTranscriptCursorV1 | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const cursor = value as Record<string, unknown>;
    if (
      cursor.v !== 1
      || cursor.kind !== 'ohMyPiTree'
      || (cursor.mode !== 'page' && cursor.mode !== 'tail')
      || typeof cursor.generation !== 'string'
      || cursor.generation.length === 0
      || typeof cursor.position !== 'number'
      || !Number.isSafeInteger(cursor.position)
      || cursor.position < 0
      || (cursor.leafEntryId !== null && typeof cursor.leafEntryId !== 'string')
      || (
        cursor.tailLeafEntryId !== undefined
        && cursor.tailLeafEntryId !== null
        && typeof cursor.tailLeafEntryId !== 'string'
      )
      || (
        cursor.itemEndExclusive !== undefined
        && (
          typeof cursor.itemEndExclusive !== 'number'
          || !Number.isSafeInteger(cursor.itemEndExclusive)
          || cursor.itemEndExclusive < 0
        )
      )
      || (
        cursor.itemStartIndex !== undefined
        && (
          typeof cursor.itemStartIndex !== 'number'
          || !Number.isSafeInteger(cursor.itemStartIndex)
          || cursor.itemStartIndex < 0
        )
      )
      || (
        cursor.sourceSize !== undefined
        && (
          typeof cursor.sourceSize !== 'number'
          || !Number.isSafeInteger(cursor.sourceSize)
          || cursor.sourceSize < 0
        )
      )
      || (
        cursor.sourceMtimeMs !== undefined
        && (
          typeof cursor.sourceMtimeMs !== 'number'
          || !Number.isFinite(cursor.sourceMtimeMs)
          || cursor.sourceMtimeMs < 0
        )
      )
    ) {
      return null;
    }
    return {
      v: 1,
      kind: 'ohMyPiTree',
      mode: cursor.mode,
      generation: cursor.generation,
      position: cursor.position,
      leafEntryId: cursor.leafEntryId,
      ...(cursor.tailLeafEntryId !== undefined
        ? { tailLeafEntryId: cursor.tailLeafEntryId }
        : {}),
      ...(cursor.itemEndExclusive !== undefined
        ? { itemEndExclusive: cursor.itemEndExclusive }
        : {}),
      ...(cursor.itemStartIndex !== undefined
        ? { itemStartIndex: cursor.itemStartIndex }
        : {}),
      ...(cursor.sourceSize !== undefined ? { sourceSize: cursor.sourceSize } : {}),
      ...(cursor.sourceMtimeMs !== undefined ? { sourceMtimeMs: cursor.sourceMtimeMs } : {}),
    };
  } catch {
    return null;
  }
}

type OhMyPiTranscriptRecordClassification =
  | Readonly<{
      kind: 'known_non_transcript';
      treeEntry: Readonly<{
        id: string;
        parentId: string | null;
      }> | null;
    }>
  | Readonly<{ kind: 'preamble' }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{
      kind: 'entry';
      id: string;
      parentId: string | null;
    }>;

function classifyOhMyPiTranscriptRecord(
  value: unknown,
): OhMyPiTranscriptRecordClassification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unsupported' };
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'session' && typeof record.id === 'string' && record.id.length > 0) {
    return { kind: 'preamble' };
  }
  if (record.type === 'title' && record.v === 1 && typeof record.title === 'string') {
    return { kind: 'preamble' };
  }
  if (record.type === 'session_info' && typeof record.name === 'string') {
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
    const parentId = record.parentId === null
      ? null
      : typeof record.parentId === 'string' && record.parentId.length > 0
        ? record.parentId
        : undefined;
    return {
      kind: 'known_non_transcript',
      treeEntry: id !== null && parentId !== undefined
        ? { id, parentId }
        : null,
    };
  }
  if (
    typeof record.type !== 'string'
    || typeof record.id !== 'string'
    || record.id.length === 0
    || (
      record.parentId !== undefined
      && record.parentId !== null
      && (typeof record.parentId !== 'string' || record.parentId.length === 0)
    )
  ) {
    return { kind: 'unsupported' };
  }
  return {
    kind: 'entry',
    id: record.id,
    parentId: typeof record.parentId === 'string' && record.parentId.length > 0
      ? record.parentId
      : null,
  };
}

function measureItemBytes(item: OhMyPiRawTranscriptItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

export function pageOhMyPiTranscriptItems(
  items: readonly OhMyPiRawTranscriptItem[],
  params?: PagingParams,
): OhMyPiRawTranscriptPage {
  const endExclusive = decodeOhMyPiTranscriptCursor(params?.cursor ?? null, items.length);
  const maxItems = Math.max(1, Math.trunc(params?.maxItems ?? 100));
  const maxBytes = Math.max(1024, Math.trunc(params?.maxBytes ?? 1024 * 1024));

  const selected: OhMyPiRawTranscriptItem[] = [];
  let usedBytes = 0;
  let nextIndex = endExclusive;
  for (let index = Math.min(endExclusive, items.length) - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const itemBytes = measureItemBytes(item);
    if (selected.length > 0 && (selected.length >= maxItems || usedBytes + itemBytes > maxBytes)) break;
    selected.unshift(item);
    usedBytes += itemBytes;
    nextIndex = index;
    if (selected.length >= maxItems) break;
  }

  return {
    items: selected,
    nextCursor: nextIndex > 0 ? encodeOhMyPiTranscriptCursor(nextIndex) : null,
    hasMore: nextIndex > 0,
    tailCursor: encodeOhMyPiTranscriptCursor(items.length),
    truncated: false,
  };
}

export function readAfterOhMyPiTranscriptItems(
  items: readonly OhMyPiRawTranscriptItem[],
  params?: PagingParams,
): OhMyPiRawTranscriptPage {
  const startIndex = decodeOhMyPiTranscriptCursor(params?.cursor ?? null, items.length);
  const maxItems = Math.max(1, Math.trunc(params?.maxItems ?? 100));
  const maxBytes = Math.max(1024, Math.trunc(params?.maxBytes ?? 1024 * 1024));

  const selected: OhMyPiRawTranscriptItem[] = [];
  let usedBytes = 0;
  let nextIndex = Math.min(startIndex, items.length);
  for (let index = Math.min(startIndex, items.length); index < items.length; index += 1) {
    const item = items[index]!;
    const itemBytes = measureItemBytes(item);
    if (selected.length > 0 && (selected.length >= maxItems || usedBytes + itemBytes > maxBytes)) break;
    selected.push(item);
    usedBytes += itemBytes;
    nextIndex = index + 1;
    if (selected.length >= maxItems) break;
  }

  return {
    items: selected,
    nextCursor: encodeOhMyPiTranscriptCursor(nextIndex),
    truncated: nextIndex < items.length,
  };
}

export async function pageOhMyPiSessionTranscript(params: Readonly<{
  source: OhMyPiExternalSessionSource;
  env?: NodeJS.ProcessEnv;
  providerSessionId: string;
  sessionFilePath?: string | null;
  /**
   * This leaf pages Oh My Pi's entry tree from the active leaf backwards. There
   * is no forward page; the contribution refuses that direction rather than
   * reporting an empty one, so nothing here reinterprets it.
   */
  direction: 'older';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
  scannerFileSystem?: JsonlScannerFileSystemV1;
}>): Promise<OhMyPiRawTranscriptPage> {
  const resolved = await resolveOhMyPiSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.providerSessionId,
    sessionFilePath: params.sessionFilePath,
  });
  if (!resolved.ok) {
    // A source that is gone, unreadable, out of the granted roots, or now holds
    // a different session is not an authoritatively empty history.
    throw resolved.reason === 'source_replaced'
      ? new OhMyPiExternalSessionSourceChangedError()
      : new OhMyPiExternalSessionSourceUnavailableError();
  }
  const before = await stat(resolved.filePath);
  const generation = formatOhMyPiSessionFileGeneration(before);
  const cursor = params.cursor ? decodeOhMyPiTreeCursor(params.cursor) : null;
  if (params.cursor && (!cursor || cursor.mode !== 'page')) {
    throw new OhMyPiExternalSessionInvalidCursorError();
  }
  if (cursor && cursor.generation !== generation) {
    throw new OhMyPiExternalSessionSourceChangedError();
  }
  if (
    cursor
    && (
      cursor.sourceSize === undefined
      || cursor.sourceMtimeMs === undefined
      || cursor.sourceSize !== before.size
      || cursor.sourceMtimeMs !== before.mtimeMs
    )
  ) {
    throw new OhMyPiExternalSessionSourceChangedError();
  }
  const scan = await readJsonlFileBackwardPage({
    filePath: resolved.filePath,
    endOffsetBytes: cursor?.position ?? before.size,
    maxBytes: params.maxBytes,
    maxItems: Math.max(64, Math.trunc(params.maxItems) * 8),
    ...(params.scannerFileSystem ? { fileSystem: params.scannerFileSystem } : {}),
  });
  if (scan.diagnostics?.some((diagnostic) => diagnostic.code === 'malformed_source_utf8')) {
    throw new Error('Oh My Pi transcript source contains malformed UTF-8.');
  }
  const after = await stat(resolved.filePath);
  if (
    generation !== formatOhMyPiSessionFileGeneration(after)
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
  ) {
    throw new OhMyPiExternalSessionSourceChangedError();
  }

  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const maxBytes = Math.max(1024, Math.trunc(params.maxBytes));
  const selectedNewestFirst: OhMyPiRawTranscriptItem[] = [];
  let usedBytes = 0;
  let targetEntryId = cursor?.leafEntryId ?? null;
  let pendingItemEndExclusive = cursor?.itemEndExclusive;
  let initialLeafEntryId: string | null = cursor?.tailLeafEntryId ?? null;
  let nextPosition = scan.nextEndOffsetBytes;
  let nextItemEndExclusive: number | undefined;
  let stoppedForOutputBound = false;
  let matchedEntry = false;

  for (let index = scan.items.length - 1; index >= 0; index -= 1) {
    const scanned = scan.items[index]!;
    const classification = classifyOhMyPiTranscriptRecord(scanned.value);
    if (classification.kind === 'known_non_transcript') {
      const treeEntry = classification.treeEntry;
      if (!treeEntry) continue;
      if (targetEntryId !== null && treeEntry.id !== targetEntryId) continue;
      matchedEntry = true;
      if (targetEntryId === null && initialLeafEntryId === null) {
        initialLeafEntryId = treeEntry.id;
      }
      pendingItemEndExclusive = undefined;
      targetEntryId = treeEntry.parentId;
      nextPosition = scanned.startOffsetBytes;
      if (targetEntryId === null) break;
      continue;
    }
    if (classification.kind !== 'entry') continue;
    if (targetEntryId !== null && classification.id !== targetEntryId) continue;
    matchedEntry = true;
    if (targetEntryId === null && initialLeafEntryId === null) {
      initialLeafEntryId = classification.id;
    }

    const projected = projectOhMyPiSessionSnapshotToDirectMessages({
      sessionFilePath: resolved.filePath,
      sessionId: params.providerSessionId,
      lines: [
        { type: 'session', id: params.providerSessionId },
        scanned.value,
      ],
    });
    const itemEndExclusive = Math.min(
      projected.items.length,
      pendingItemEndExclusive ?? projected.items.length,
    );
    let consumedWholeEntry = true;
    for (let itemIndex = itemEndExclusive - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = projected.items[itemIndex]!;
      const itemBytes = measureItemBytes(item);
      const wouldExceedBound =
        selectedNewestFirst.length >= maxItems
        || (selectedNewestFirst.length > 0 && usedBytes + itemBytes > maxBytes);
      if (wouldExceedBound) {
        consumedWholeEntry = false;
        nextPosition = scanned.endOffsetBytes;
        targetEntryId = classification.id;
        nextItemEndExclusive = itemIndex + 1;
        stoppedForOutputBound = true;
        break;
      }
      selectedNewestFirst.push(item);
      usedBytes += itemBytes;
    }
    if (!consumedWholeEntry) break;

    pendingItemEndExclusive = undefined;
    targetEntryId = classification.parentId;
    nextPosition = scanned.startOffsetBytes;
    if (targetEntryId === null) {
      break;
    }
    if (selectedNewestFirst.length >= maxItems) {
      stoppedForOutputBound = true;
      break;
    }
  }

  // A missing parent inside a bounded scan window is the paging handoff and must
  // keep the continuation alive. Once the backward scan has consumed the first
  // byte of the source the parent is not coming, so this is not completion.
  if (!stoppedForOutputBound && scan.reachedStart && targetEntryId !== null) {
    throw new OhMyPiExternalSessionIncompleteBranchError();
  }
  const reachedTreeStart =
    (matchedEntry && targetEntryId === null && nextItemEndExclusive === undefined)
    || (!stoppedForOutputBound && scan.reachedStart);
  const hasMore = !reachedTreeStart && nextPosition > 0;
  const nextCursor = hasMore
    ? encodeOhMyPiTreeCursor({
      v: 1,
      kind: 'ohMyPiTree',
      mode: 'page',
      generation,
      position: nextPosition,
      leafEntryId: targetEntryId,
      tailLeafEntryId: initialLeafEntryId,
      ...(nextItemEndExclusive !== undefined ? { itemEndExclusive: nextItemEndExclusive } : {}),
      sourceSize: before.size,
      sourceMtimeMs: before.mtimeMs,
    })
    : null;
  return {
    items: selectedNewestFirst.reverse(),
    nextCursor,
    hasMore,
    tailCursor: encodeOhMyPiTreeCursor({
      v: 1,
      kind: 'ohMyPiTree',
      mode: 'tail',
      generation,
      position: Math.max(0, Math.trunc(after.size)),
      leafEntryId: initialLeafEntryId,
    }),
    truncated: false,
  };
}

export async function readAfterOhMyPiSessionTranscript(params: Readonly<{
  source: OhMyPiExternalSessionSource;
  env?: NodeJS.ProcessEnv;
  providerSessionId: string;
  sessionFilePath?: string | null;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<OhMyPiRawTranscriptPage & Readonly<{
  diagnostics?: readonly Readonly<{
    code: string;
    count: number;
    positions: readonly number[];
  }>[];
  skippedRecords?: readonly Readonly<{
    code:
      | 'malformed_record_skipped'
      | 'non_transcript_record_skipped'
      | 'unsupported_record_skipped';
    position: number;
  }>[];
}>> {
  const resolved = await resolveOhMyPiSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.providerSessionId,
    sessionFilePath: params.sessionFilePath,
  });
  if (!resolved.ok) {
    throw resolved.reason === 'source_replaced'
      ? new OhMyPiExternalSessionSourceChangedError()
      : new OhMyPiExternalSessionSourceUnavailableError();
  }
  const cursor = decodeOhMyPiTreeCursor(params.cursor);
  if (!cursor || cursor.mode !== 'tail') {
    throw new OhMyPiExternalSessionInvalidCursorError();
  }
  const metadata = await stat(resolved.filePath);
  const generation = formatOhMyPiSessionFileGeneration(metadata);
  if (cursor.generation !== generation || cursor.position > metadata.size) {
    throw new OhMyPiExternalSessionSourceChangedError();
  }
  const read = await readJsonlAfterCursor({
    filePath: resolved.filePath,
    cursor: {
      v: 1,
      kind: 'byteOffset',
      offset: cursor.position,
    },
    maxBytes: params.maxBytes,
    maxItems: params.maxItems,
  });
  const items: OhMyPiRawTranscriptItem[] = [];
  const skippedRecords: Array<{
    code:
      | 'malformed_record_skipped'
      | 'non_transcript_record_skipped'
      | 'unsupported_record_skipped';
    position: number;
  }> = [];
  let leafEntryId = cursor.leafEntryId;
  let nextPosition = cursor.position;
  let nextItemStartIndex: number | undefined = cursor.itemStartIndex;
  let usedBytes = 0;
  let stoppedForOutputBound = false;
  for (let index = 0; index < read.lines.length; index += 1) {
    const line = read.lines[index]!;
    const lineStartOffset = read.lineStartOffsets[index] ?? nextPosition;
    const nextLineStartOffset = read.lineStartOffsets[index + 1] ?? read.nextCursor.offset;
    const parsed = parseOhMyPiJsonlLine(line);
    if (parsed === null) {
      skippedRecords.push({ code: 'malformed_record_skipped', position: lineStartOffset });
      nextPosition = nextLineStartOffset;
      nextItemStartIndex = undefined;
      continue;
    }
    const classification = classifyOhMyPiTranscriptRecord(parsed);
    if (classification.kind === 'known_non_transcript') {
      skippedRecords.push({ code: 'non_transcript_record_skipped', position: lineStartOffset });
      if (classification.treeEntry) {
        if (classification.treeEntry.parentId !== leafEntryId) {
          throw new OhMyPiExternalSessionSourceChangedError(
            'Oh My Pi external-session branch changed after the cursor.',
          );
        }
        leafEntryId = classification.treeEntry.id;
      }
      nextPosition = nextLineStartOffset;
      nextItemStartIndex = undefined;
      continue;
    }
    if (classification.kind === 'unsupported' || classification.kind === 'preamble') {
      skippedRecords.push({ code: 'unsupported_record_skipped', position: lineStartOffset });
      nextPosition = nextLineStartOffset;
      nextItemStartIndex = undefined;
      continue;
    }
    if (classification.parentId !== leafEntryId) {
      throw new OhMyPiExternalSessionSourceChangedError(
        'Oh My Pi external-session branch changed after the cursor.',
      );
    }
    const projected = projectOhMyPiSessionSnapshotToDirectMessages({
      sessionFilePath: resolved.filePath,
      sessionId: params.providerSessionId,
      lines: [
        { type: 'session', id: params.providerSessionId },
        parsed,
      ],
    });
    if (projected.items.length === 0) {
      skippedRecords.push({ code: 'unsupported_record_skipped', position: lineStartOffset });
      leafEntryId = classification.id;
      nextPosition = nextLineStartOffset;
      nextItemStartIndex = undefined;
      continue;
    }
    const itemStartIndex = index === 0 ? (cursor.itemStartIndex ?? 0) : 0;
    if (itemStartIndex >= projected.items.length) {
      throw new OhMyPiExternalSessionInvalidCursorError(
        'Oh My Pi external-session item continuation is outside its source record.',
      );
    }
    let consumedWholeEntry = true;
    for (let itemIndex = itemStartIndex; itemIndex < projected.items.length; itemIndex += 1) {
      const item = projected.items[itemIndex]!;
      const itemBytes = measureItemBytes(item);
      if (
        items.length >= Math.max(1, Math.trunc(params.maxItems))
        || (items.length > 0 && usedBytes + itemBytes > Math.max(1, Math.trunc(params.maxBytes)))
      ) {
        consumedWholeEntry = false;
        stoppedForOutputBound = true;
        nextPosition = lineStartOffset;
        nextItemStartIndex = itemIndex;
        break;
      }
      items.push(item);
      usedBytes += itemBytes;
    }
    if (!consumedWholeEntry) break;
    leafEntryId = classification.id;
    nextPosition = nextLineStartOffset;
    nextItemStartIndex = undefined;
    if (items.length >= Math.max(1, Math.trunc(params.maxItems))) {
      stoppedForOutputBound = nextPosition < read.nextCursor.offset || read.truncated;
      break;
    }
  }
  const after = await stat(resolved.filePath);
  if (generation !== formatOhMyPiSessionFileGeneration(after)) {
    throw new OhMyPiExternalSessionSourceChangedError();
  }
  if (
    items.length === 0
    && skippedRecords.length === 0
    && !read.diagnostics?.length
    && read.nextCursor.offset > cursor.position
  ) {
    skippedRecords.push({
      code: 'unsupported_record_skipped',
      position: cursor.position,
    });
  }
  return {
    items,
    nextCursor: encodeOhMyPiTreeCursor({
      v: 1,
      kind: 'ohMyPiTree',
      mode: 'tail',
      generation,
      position: nextPosition,
      leafEntryId,
      ...(nextItemStartIndex !== undefined ? { itemStartIndex: nextItemStartIndex } : {}),
    }),
    truncated: stoppedForOutputBound || read.truncated,
    ...(read.diagnostics?.length ? { diagnostics: read.diagnostics } : {}),
    ...(skippedRecords.length > 0 ? { skippedRecords } : {}),
  };
}
