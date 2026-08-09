import { readFile } from 'node:fs/promises';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import type { PiSessionEntry } from './piEntryContext';
import { mapPiSessionToDirectMessages } from './mapPiSessionToDirectMessages';
import { resolvePiDirectSessionFile } from './resolvePiDirectSessionFile';

type PiBackwardCursorV1 = Readonly<{ v: 1; kind: 'piBackward'; endExclusive: number }>;
type PiForwardCursorV1 = Readonly<{ v: 1; kind: 'piForward'; delivered: number }>;

function encodeBackwardCursor(value: PiBackwardCursorV1): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBackwardCursor(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (value.v !== 1 || value.kind !== 'piBackward') return null;
    const endExclusive = typeof value.endExclusive === 'number' && Number.isFinite(value.endExclusive) ? value.endExclusive : NaN;
    if (!Number.isFinite(endExclusive) || endExclusive < 0) return null;
    return Math.trunc(endExclusive);
  } catch {
    return null;
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
  const maxItems = Math.max(1, Math.trunc(params.maxItems));
  const maxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const tailCursor = encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: total });

  // Backward paging uses an `endExclusive` cursor: each page delivers a contiguous block ending at
  // endExclusive, collected newest-first so byte-limit truncation cuts the OLDER end and the next
  // page's window begins exactly where this one stopped. This keeps pages gap-free, overlap-free,
  // and reconstructable into full chronological order even when maxBytes truncates below maxItems.
  const decoded = decodeBackwardCursor(params.cursor);
  const endExclusive = decoded === null ? total : Math.min(Math.max(0, decoded), total);
  if (endExclusive <= 0) {
    return { items: [], nextCursor: null, tailCursor, hasMore: false };
  }

  const windowStart = Math.max(0, endExclusive - maxItems);
  const collected: DirectTranscriptRawMessageV1[] = [];
  let bytesUsed = 0;
  for (let i = endExclusive - 1; i >= windowStart && collected.length < maxItems; i -= 1) {
    const item = items[i]!;
    const size = itemByteSize(item);
    if (collected.length > 0 && bytesUsed + size > maxBytes) break;
    collected.push(item);
    bytesUsed += size;
  }
  collected.reverse(); // newest-first collection → chronological intra-page order

  const newEndExclusive = endExclusive - collected.length;
  const hasMore = newEndExclusive > 0;
  const nextCursor = hasMore ? encodeBackwardCursor({ v: 1, kind: 'piBackward', endExclusive: newEndExclusive }) : null;

  return { items: collected, nextCursor, tailCursor, hasMore };
}
