import { readFile } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { PiSessionEntry } from './piEntryContext';
import { mapPiSessionToDirectMessages } from './mapPiSessionToDirectMessages';
import { resolvePiDirectSessionFile } from './resolvePiDirectSessionFile';

type PiBackwardCursorV1 = Readonly<{ v: 1; kind: 'piBackward'; consumed: number }>;
type PiForwardCursorV1 = Readonly<{ v: 1; kind: 'piForward'; delivered: number }>;

function encodeBackwardCursor(value: PiBackwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return 0;
    const value = parsed as Record<string, unknown>;
    if (value.v !== 1 || value.kind !== 'piBackward') return 0;
    const consumed = typeof value.consumed === 'number' && Number.isFinite(value.consumed) ? value.consumed : 0;
    return Math.max(0, Math.trunc(consumed));
  } catch {
    return 0;
  }
}

export function encodePiForwardCursor(value: PiForwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodePiForwardCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return 0;
    const value = parsed as Record<string, unknown>;
    if (value.v !== 1 || value.kind !== 'piForward') return 0;
    const delivered = typeof value.delivered === 'number' && Number.isFinite(value.delivered) ? value.delivered : 0;
    return Math.max(0, Math.trunc(delivered));
  } catch {
    return 0;
  }
}

/**
 * Parse a whole pi session JSONL file into its raw entries. Pi sessions are trees, so the active
 * branch cannot be resolved incrementally; the full entry list is required for the tree walk.
 */
export async function loadPiSessionEntries(filePath: string): Promise<PiSessionEntry[]> {
  const content = await readFile(filePath, 'utf8').catch(() => '');
  const entries: PiSessionEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(parsed as PiSessionEntry);
      }
    } catch {
      // Skip malformed lines (matches pi's own parseSessionEntryLine).
    }
  }
  return entries;
}

async function loadMappedItems(
  filePath: string,
  fileRelPath: string,
): Promise<DirectTranscriptRawMessageV1[]> {
  const entries = await loadPiSessionEntries(filePath);
  return mapPiSessionToDirectMessages({ entries, fileRelPath });
}

function itemByteSize(item: DirectTranscriptRawMessageV1): number {
  try {
    return Buffer.byteLength(JSON.stringify(item.raw), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Page a pi direct-session transcript. Pi pages the projected active-branch item list rather than
 * raw file bytes: the `older` direction walks backward from the newest item (the import flow),
 * returning each page in chronological order so the caller's page-reversal reconstructs full
 * chronological order. `consumed` counts items already delivered from the end.
 */
export async function pagePiTranscript(params: Readonly<{
  source: DirectSessionsSource;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated?: boolean;
}>> {
  const resolved = await resolvePiDirectSessionFile({
    source: params.source,
    env: params.env,
    remoteSessionId: params.remoteSessionId,
  });
  if (!resolved) {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
  }

  // Forward paging is not required for v1 UI flows (tail uses readAfter).
  if (params.direction !== 'older') {
    return { items: [], nextCursor: null, tailCursor: null, hasMore: false };
  }

  const items = await loadMappedItems(resolved.filePath, resolved.fileRelPath);
  const total = items.length;
  const consumed = decodeBackwardCursor(params.cursor);
  const tailCursor = encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: total });

  const remaining = total - consumed;
  if (remaining <= 0) {
    return { items: [], nextCursor: null, tailCursor, hasMore: false };
  }

  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));

  const pageStart = Math.max(0, total - consumed - maxItems);
  const pageEndExclusive = total - consumed;

  const pageItems: DirectTranscriptRawMessageV1[] = [];
  let bytesUsed = 0;
  for (let i = pageStart; i < pageEndExclusive; i += 1) {
    const item = items[i]!;
    if (pageItems.length >= maxItems) break;
    const size = itemByteSize(item);
    if (pageItems.length > 0 && bytesUsed + size > maxBytes) break;
    pageItems.push(item);
    bytesUsed += size;
  }

  const newConsumed = consumed + pageItems.length;
  const hasMore = newConsumed < total;
  const nextCursor = hasMore ? encodeBackwardCursor({ v: 1, kind: 'piBackward', consumed: newConsumed }) : null;

  return { items: pageItems, nextCursor, tailCursor, hasMore };
}
