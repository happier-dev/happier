import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/plugin-sdk/experimental/sessions';

import {
  classifyOpenCodeMessageForProjection,
  extractOpenCodeProjectedText,
} from './projection/index.js';
import { buildOpenCodeRuntimeTranscriptLocalId } from './identity.js';

export type OpenCodeIndexCursorV1 =
  | Readonly<{ v: 1; kind: 'index'; offset: number }>
  | Readonly<{ v: 1; kind: 'opencodeTranscript'; nextIndex: number }>
  | Readonly<{ v: 1; kind: 'opencodeAfter'; nextIndex: number }>
  | Readonly<{ v: 1; kind: 'opencodeBackward'; endIndex: number }>;

export type OpenCodeForwardTranscriptWindowV1<TItem> = Readonly<{
  items: readonly TItem[];
  nextIndex: number;
  truncated: boolean;
}>;

export type OpenCodeBackwardTranscriptWindowV1<TItem> = Readonly<{
  items: readonly TItem[];
  nextIndex: number;
  truncated: boolean;
}>;

export type OpenCodeTranscriptProjectionOptions = Readonly<{
  isHappierAuthoredProviderUserMessageId?: (messageId: string) => boolean;
}>;

type OpenCodeCursorKindV1 = OpenCodeIndexCursorV1['kind'];

function readCursorIndex(cursor: OpenCodeIndexCursorV1): number {
  switch (cursor.kind) {
    case 'index':
      return cursor.offset;
    case 'opencodeBackward':
      return cursor.endIndex;
    case 'opencodeAfter':
    case 'opencodeTranscript':
      return cursor.nextIndex;
  }
}

function buildCursor(kind: OpenCodeCursorKindV1, value: number): OpenCodeIndexCursorV1 {
  const index = Math.max(0, Math.trunc(value));
  switch (kind) {
    case 'index':
      return { v: 1, kind, offset: index };
    case 'opencodeBackward':
      return { v: 1, kind, endIndex: index };
    case 'opencodeAfter':
    case 'opencodeTranscript':
      return { v: 1, kind, nextIndex: index };
  }
}

export function encodeOpenCodeIndexCursor(cursor: OpenCodeIndexCursorV1): string {
  return Buffer.from(JSON.stringify(buildCursor(cursor.kind, readCursorIndex(cursor))), 'utf8').toString('base64url');
}

export function decodeOpenCodeIndexCursor(
  raw: string | null | undefined,
  kind: OpenCodeCursorKindV1,
): OpenCodeIndexCursorV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || record.kind !== kind) return null;
    const key = kind === 'index'
      ? 'offset'
      : kind === 'opencodeBackward'
        ? 'endIndex'
        : 'nextIndex';
    const index = typeof record[key] === 'number' && Number.isFinite(record[key])
      ? Math.trunc(record[key])
      : NaN;
    return Number.isFinite(index) && index >= 0 ? buildCursor(kind, index) : null;
  } catch {
    return null;
  }
}

export function measureOpenCodeTranscriptItemBytes(item: ExternalSessionTranscriptRawMessageV1): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

export function mapOpenCodeMessageToTranscriptItem(
  message: unknown,
  providerSessionId: string,
): ExternalSessionTranscriptRawMessageV1 | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }

  const record = message as Record<string, unknown>;
  const projection = classifyOpenCodeMessageForProjection(record);
  if (projection.kind !== 'user_transcript' && projection.kind !== 'assistant_transcript') return null;
  if (!projection.messageId) return null;

  const contentText = typeof record.content === 'string' ? record.content.trim() : '';
  const text = contentText || extractOpenCodeProjectedText(
    Array.isArray(record.parts) ? record.parts : [],
    { context: 'direct_transcript' },
  );
  if (!text) return null;

  const stableId = buildOpenCodeRuntimeTranscriptLocalId(providerSessionId, projection.messageId);
  if (projection.kind === 'user_transcript') {
    return {
      id: stableId,
      localId: stableId,
      createdAtMs: projection.createdAtMs,
      raw: {
        role: 'user',
        content: { type: 'text', text },
      },
    };
  }

  return {
    id: stableId,
    localId: stableId,
    createdAtMs: projection.createdAtMs,
    raw: {
      role: 'agent',
      content: {
        type: 'acp',
        agentId: 'opencode',
        data: { type: 'message', message: text },
      },
    },
  };
}

type OpenCodeTranscriptMessageProjection = Readonly<{
  item: ExternalSessionTranscriptRawMessageV1 | null;
  projectionKind: 'user_transcript' | 'assistant_transcript' | 'other';
  messageId: string;
}>;

function projectOpenCodeTranscriptMessage(
  message: unknown,
  providerSessionId: string,
): OpenCodeTranscriptMessageProjection {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { item: null, projectionKind: 'other', messageId: '' };
  }

  const record = message as Record<string, unknown>;
  const projection = classifyOpenCodeMessageForProjection(record);
  const projectionKind =
    projection.kind === 'user_transcript' || projection.kind === 'assistant_transcript'
      ? projection.kind
      : 'other';
  return {
    item: mapOpenCodeMessageToTranscriptItem(message, providerSessionId),
    projectionKind,
    messageId: projection.messageId,
  };
}

export function createOpenCodeTranscriptProjectionMapper(params: Readonly<{
  messages: readonly unknown[];
  providerSessionId: string;
  options?: OpenCodeTranscriptProjectionOptions;
}>): (message: unknown, index: number) => ExternalSessionTranscriptRawMessageV1 | null {
  const projections = new Map<number, OpenCodeTranscriptMessageProjection>();
  const latestUserOriginByIndex = new Map<number, 'external' | 'happier_authored' | null>();
  let latestScannedIndex = -1;
  let latestUserOrigin: 'external' | 'happier_authored' | null = null;
  const readProjection = (index: number): OpenCodeTranscriptMessageProjection => {
    const cached = projections.get(index);
    if (cached) return cached;
    const projected = projectOpenCodeTranscriptMessage(params.messages[index], params.providerSessionId);
    projections.set(index, projected);
    return projected;
  };
  const readLatestUserOriginAt = (index: number): 'external' | 'happier_authored' | null => {
    while (latestScannedIndex < index) {
      latestScannedIndex += 1;
      const projected = readProjection(latestScannedIndex);
      if (projected.projectionKind === 'user_transcript') {
        latestUserOrigin = projected.messageId
          && params.options?.isHappierAuthoredProviderUserMessageId?.(projected.messageId) === true
          ? 'happier_authored'
          : 'external';
      }
      latestUserOriginByIndex.set(latestScannedIndex, latestUserOrigin);
    }
    return latestUserOriginByIndex.get(index) ?? null;
  };

  return (_message, index) => {
    const projected = readProjection(index);
    if (!projected.item) return null;
    if (
      projected.projectionKind === 'user_transcript'
      && projected.messageId
      && params.options?.isHappierAuthoredProviderUserMessageId?.(projected.messageId) === true
    ) {
      return null;
    }
    if (
      projected.projectionKind === 'assistant_transcript'
      && readLatestUserOriginAt(index) === 'happier_authored'
    ) {
      return null;
    }
    return projected.item;
  };
}

export function readOpenCodeTranscriptForwardWindow<TItem>(params: Readonly<{
  messages: readonly unknown[];
  startIndex: number;
  maxItems: number;
  maxBytes: number;
  mapMessage: (message: unknown, index: number) => TItem | null;
  measureItemBytes: (item: TItem) => number;
}>): OpenCodeForwardTranscriptWindowV1<TItem> {
  const items: TItem[] = [];
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  let remainingBytes = Math.max(1, Math.trunc(params.maxBytes));
  let nextIndex = Math.max(0, Math.trunc(params.startIndex));
  let truncated = false;

  for (let index = nextIndex; index < params.messages.length; index += 1) {
    const item = params.mapMessage(params.messages[index], index);
    nextIndex = index + 1;
    if (!item) continue;

    const itemBytes = params.measureItemBytes(item);
    if (items.length >= maxItems) {
      nextIndex = index;
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && items.length === 0) {
      items.push(item);
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && items.length > 0) {
      nextIndex = index;
      truncated = true;
      break;
    }
    items.push(item);
    remainingBytes = Math.max(0, remainingBytes - itemBytes);
  }

  return {
    items,
    nextIndex,
    truncated: truncated || nextIndex < params.messages.length,
  };
}

export function readOpenCodeTranscriptBackwardWindow<TItem>(params: Readonly<{
  messages: readonly unknown[];
  endIndex: number;
  maxItems: number;
  maxBytes: number;
  rawItemLimit?: number;
  mapMessage: (message: unknown, index: number) => TItem | null;
  measureItemBytes: (item: TItem) => number;
}>): OpenCodeBackwardTranscriptWindowV1<TItem> {
  const reversedItems: TItem[] = [];
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  let remainingBytes = Math.max(1, Math.trunc(params.maxBytes));
  let nextIndex = Math.min(params.messages.length, Math.max(0, Math.trunc(params.endIndex)));
  const rawItemLimit = typeof params.rawItemLimit === 'number' && Number.isFinite(params.rawItemLimit)
    ? Math.max(1, Math.trunc(params.rawItemLimit))
    : null;
  const lowerBound = rawItemLimit === null ? 0 : Math.max(0, nextIndex - rawItemLimit);
  let truncated = false;

  for (let index = nextIndex - 1; index >= lowerBound; index -= 1) {
    const item = params.mapMessage(params.messages[index], index);
    nextIndex = index;
    if (!item) continue;

    const itemBytes = params.measureItemBytes(item);
    if (reversedItems.length >= maxItems) {
      nextIndex = index + 1;
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && reversedItems.length === 0) {
      reversedItems.push(item);
      truncated = true;
      break;
    }
    if (itemBytes > remainingBytes && reversedItems.length > 0) {
      nextIndex = index + 1;
      truncated = true;
      break;
    }
    reversedItems.push(item);
    remainingBytes = Math.max(0, remainingBytes - itemBytes);
  }

  return {
    items: reversedItems.reverse(),
    nextIndex,
    truncated,
  };
}
