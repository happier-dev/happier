import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { DirectSessionsProviderUnavailableError } from '@/backends/directSessions/providerOps';
import type { CodexAppServerClient } from '../appServer/client/createCodexAppServerClient';
import { projectCodexNativeHistoryItem } from '../appServer/session/projectCodexNativeHistoryItem';
import { projectCodexRolloutActions } from '../rollout/projectCodexRolloutActions';
import { mapCodexProjectedEventsToDirectMessages } from './mapCodexRolloutLineToDirectMessages';
import { measureDirectTranscriptItemBytes } from './codexDirectTranscriptProjection';
import { lazySchema } from '@happier-dev/protocol';

const TailSchema = lazySchema(() => z.object({ position: z.string().nullable(), anchor: z.string().nullable(), fingerprint: z.string().nullable() }));
const CursorSchema = lazySchema(() => z.object({
  v: z.literal(1), kind: z.literal('codexNativeHistory'), threadId: z.string(), home: z.string(),
  direction: z.enum(['older', 'newer']), position: z.string().nullable(), limit: z.number().int().positive(),
  skip: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), pendingId: z.string().nullable(),
  anchor: z.string().nullable(), fingerprint: z.string().nullable(), tail: TailSchema,
}));
type NativeCursor = z.infer<typeof CursorSchema>;
const PageSchema = lazySchema(() => z.object({
  data: z.array(z.object({ turnId: z.string().min(1), item: z.record(z.string(), z.unknown()),
    startedAtMs: z.number().nonnegative().nullable(), completedAtMs: z.number().nonnegative().nullable() })),
  nextCursor: z.string().min(1).nullable(), backwardsCursor: z.string().min(1).nullable(),
}));
type Entry = z.infer<typeof PageSchema>['data'][number];

export function decodeCodexNativeTranscriptCursor(raw: string | undefined): NativeCursor | null {
  if (!raw) return null;
  try { return CursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))); }
  catch { return null; }
}
function encode(cursor: NativeCursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function identity(entry: Entry): string {
  if (typeof entry.item.id !== 'string' || !entry.item.id) throw new Error('Codex native history item omitted its identity');
  return JSON.stringify([entry.turnId, entry.item.id]);
}
function fingerprint(entry: Entry): string { return createHash('sha256').update(JSON.stringify(entry)).digest('hex'); }

/**
 * Codex 0.162.1 thread/items/list cursors are opaque; reverse cursors include their anchor.
 * Retain a partial page's native frontier and item identity, never a copy of transcript bodies.
 */
export async function pageCodexNativeTranscript(params: Readonly<{
  client: Pick<CodexAppServerClient, 'request'>;
  home: string;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxItems: number;
  maxBytes: number;
  tailOnly?: boolean;
  hasPaginatedRollout?: boolean;
}>) {
  try {
    const decoded = decodeCodexNativeTranscriptCursor(params.cursor);
    if (params.cursor && (!decoded || decoded.home !== params.home || decoded.threadId !== params.remoteSessionId
      || decoded.direction !== params.direction)) throw new Error('Codex native transcript cursor no longer matches its source');
    const state: NativeCursor = decoded ?? { v: 1, kind: 'codexNativeHistory', threadId: params.remoteSessionId,
      home: params.home, direction: params.direction, position: null, limit: params.tailOnly ? 1 : params.maxItems,
      skip: 0, offset: 0, pendingId: null, anchor: null, fingerprint: null,
      tail: { position: null, anchor: null, fingerprint: null } };
    const page = PageSchema.parse(await params.client.request('thread/items/list', {
      threadId: params.remoteSessionId, sortDirection: params.tailOnly || params.direction === 'older' ? 'desc' : 'asc',
      limit: state.limit, ...(state.position ? { cursor: state.position } : {}),
    }));
    // Codex can recreate an empty SQL projection from a surviving paginated
    // rollout. That successful empty head does not establish complete history.
    // An exclusive forward frontier may legitimately be empty when caught up.
    if (page.data.length === 0 && ((params.hasPaginatedRollout && (!decoded || params.tailOnly))
      || (params.direction === 'older' && state.tail.anchor !== null))) {
      throw new Error('Codex native history is empty but its source history cannot be confirmed');
    }
    if (new Set(page.data.map(identity)).size !== page.data.length) throw new Error('Codex native history repeated an item');
    if (page.nextCursor && page.nextCursor === state.position) throw new Error('Codex native history cursor did not advance');
    if (page.nextCursor && page.data.length === 0) throw new Error('Codex native history continuation omitted its items');
    if (!decoded || params.tailOnly) {
      const head = page.data[0];
      if (head && !page.backwardsCursor) throw new Error('Codex native history omitted its reverse cursor');
      state.tail = { position: page.backwardsCursor, anchor: head ? identity(head) : null,
        fingerprint: head ? fingerprint(head) : null };
    }
    const tailCursor = encode({ ...state, ...state.tail, direction: 'newer', limit: params.maxItems,
      skip: state.tail.anchor ? 1 : 0, offset: 0, pendingId: null });
    if (params.tailOnly) return { items: [], nextCursor: tailCursor, tailCursor, hasMore: false, truncated: false };

    if (state.skip > page.data.length || (state.pendingId && (!page.data[state.skip]
      || identity(page.data[state.skip]!) !== state.pendingId))) throw new Error('Codex native history changed during paging');
    if (state.anchor && state.skip > 0) {
      const prior = page.data[state.skip - 1];
      if (!prior || identity(prior) !== state.anchor) throw new Error('Codex native history replaced its tail');
      // A previously partial live item may settle in place; emit its same stable ids again.
      if (params.direction === 'newer' && fingerprint(prior) !== state.fingerprint) { state.skip -= 1; state.offset = 0; }
    }
    const items: DirectTranscriptRawMessageV1[] = [];
    let bytes = 0;
    let index = state.skip;
    let offset = state.offset;
    for (; index < page.data.length; index += 1, offset = 0) {
      const entry = page.data[index]!;
      const key = identity(entry);
      const projected = projectCodexRolloutActions(projectCodexNativeHistoryItem(entry.item), { sidechainId: null });
      const messages = mapCodexProjectedEventsToDirectMessages({ projected,
        createdAtMs: entry.startedAtMs ?? entry.completedAtMs ?? 0,
        idForIndex: action => `codex:native:${params.remoteSessionId}:${key}:${action}` });
      if (params.direction === 'older') messages.reverse();
      if (offset > messages.length) throw new Error('Codex native history changed its partial item');
      for (; offset < messages.length; offset += 1) {
        const item = messages[offset]!;
        const size = measureDirectTranscriptItemBytes(item);
        if (items.length >= params.maxItems || bytes + size > params.maxBytes) {
          if (items.length === 0) throw new Error('Codex native transcript item exceeds the requested byte budget');
          const nextCursor = encode({ ...state, skip: index, offset, pendingId: key,
            anchor: index ? identity(page.data[index - 1]!) : null,
            fingerprint: index ? fingerprint(page.data[index - 1]!) : null });
          if (params.direction === 'older') items.reverse();
          return { items, nextCursor, tailCursor, hasMore: true, truncated: params.direction === 'newer',
            ...(params.direction === 'newer' ? { truncationReason: 'page_limit' as const } : {}) };
        }
        items.push(item); bytes += size;
      }
    }
    const last = page.data.at(-1);
    const nextCursor = page.nextCursor
      ? encode({ ...state, position: page.nextCursor, skip: 0, offset: 0, pendingId: null, anchor: null, fingerprint: null })
      : params.direction === 'older' ? null : encode({ ...state, skip: page.data.length, offset: 0, pendingId: null,
        anchor: last ? identity(last) : state.anchor, fingerprint: last ? fingerprint(last) : state.fingerprint });
    if (params.direction === 'older') items.reverse();
    return { items, nextCursor, tailCursor, hasMore: page.nextCursor !== null,
      truncated: params.direction === 'newer' && page.nextCursor !== null,
      ...(params.direction === 'newer' && page.nextCursor ? { truncationReason: 'page_limit' as const } : {}) };
  } catch (error) {
    if (error instanceof DirectSessionsProviderUnavailableError) throw error;
    throw new DirectSessionsProviderUnavailableError(error instanceof Error
      ? `Codex history could not be read completely: ${error.message}` : 'Codex history could not be read completely');
  }
}
