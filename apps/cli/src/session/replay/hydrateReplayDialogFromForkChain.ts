import type { Credentials } from '@/persistence';

import { measureHappierReplayDialogLineChars } from '@happier-dev/agents';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { findTranscriptEncryptedMessageByLocalId } from '@/api/session/transcriptMessageLookup';
import { configuration } from '@/configuration';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionEncryptionContextFromCredentials,
  tryDecryptSessionMetadata,
  type SessionEncryptionContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchLatestMemorySynopsisSystemRecord } from '@/session/systemRecords/memory/fetchMemorySystemRecords';
import { readMemorySynopsisPointerV1FromSessionMetadata } from '@/session/memoryArtifacts/memorySynopsisPointerV1';

import type { HappierReplayDialogItem } from './types';
import { fetchEncryptedTranscriptMessagesPage } from './fetchEncryptedTranscriptMessages';
import { decryptTranscriptReplaySlice } from './decryptTranscriptReplaySlice';

type ForkV1 = Readonly<{
  v: 1;
  parentSessionId: string;
  parentCutoffSeqInclusive: number;
}>;

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

/**
 * The only roles a replay seed can carry.
 *
 * Not configurable, because it is structural rather than a preference: the
 * canonical role classifier files tool calls, tool results, thinking
 * transcripts and lifecycle rows as `event`, and none of those is a
 * conversational turn. Asking the server for the other two is what turns a
 * fixed page of rows into a page of CONVERSATION: the observed unfiltered
 * window spent 500 rows to yield 165 lines and zero user turns.
 *
 * The server ORs `messageRole: null` into the filter whenever `user` is asked
 * for, so pre-`messageRole` Sessions still answer with everything; the decoder
 * discards what it cannot use, and the walk simply yields less per request.
 */
const REPLAY_DIALOG_MESSAGE_ROLES = ['user', 'agent'] as const;

/**
 * Ceiling on the adjacent-duplicate comparison below.
 *
 * This is a run-collapse over neighbouring turns, not a similarity engine: one
 * comparison against the previously accepted line, and only for lines short
 * enough that the comparison is cheap. A turn larger than this is never
 * collapsed.
 */
const DUPLICATE_COMPARISON_MAX_CHARS = 8_000;

function normalizeForDuplicateComparison(text: string): string | null {
  if (text.length > DUPLICATE_COMPARISON_MAX_CHARS) return null;
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * True when the OLDER turn says nothing the newer one does not already say at
 * its head.
 *
 * Streaming Agents publish progressive snapshots of the same turn, so the older
 * row is literally a prefix of the newer one: the observed window spent 101 of
 * its 165 lines on that. Prefix containment is deliberately the whole rule —
 * anything looser starts discarding content that only RESEMBLES what was kept.
 */
function isSupersededAdjacentDuplicate(
  older: Readonly<{ role: string; text: string }>,
  newer: Readonly<{ role: string; text: string }>,
): boolean {
  if (older.role !== newer.role) return false;
  const olderText = normalizeForDuplicateComparison(older.text);
  const newerText = normalizeForDuplicateComparison(newer.text);
  if (olderText === null || newerText === null) return false;
  return olderText.length <= newerText.length && newerText.startsWith(olderText);
}

/**
 * The Session's own title (`metadata.summary.text`).
 *
 * It survives the cutover, it is the one durable sentence describing what the
 * Session is FOR, and it is already in hand here — while the transcript turn
 * that established the task is routinely thousands of rows behind the window.
 */
function readSessionTitleText(metadata: Record<string, unknown> | null | undefined): string | null {
  const summary = (metadata as { summary?: unknown } | null | undefined)?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const text = (summary as { text?: unknown }).text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function tryHydrateSynopsisFromMetadataPointer(params: Readonly<{
  credentials: Credentials;
  rawSession: any;
  sessionId: string;
  maxTextChars?: number;
  /** Null for a `plain` Session; otherwise the canonical owner's answer. */
  ctx?: SessionEncryptionContext | null;
}>): Promise<string | null> {
  const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: params.rawSession });
  if (!metadata) return null;
  const pointer = readMemorySynopsisPointerV1FromSessionMetadata(metadata);
  if (!pointer) return null;

  const found = await findTranscriptEncryptedMessageByLocalId({
    token: params.credentials.token,
    sessionId: params.sessionId,
    localId: pointer.localId,
  }).catch((error) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  if (!found) return null;

  const slice = decryptTranscriptReplaySlice({
    rows: [{ seq: found.seq, createdAt: 0, content: found.content }],
    ...(params.ctx ?? {}),
    maxTextChars: params.maxTextChars,
    maxDialogItems: 1,
  });
  return slice.latestSynopsisText;
}

async function tryHydrateSynopsisFromSystemRecord(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  encryptionMode: 'plain' | 'e2ee';
  /** Null for a `plain` Session; otherwise the canonical owner's answer. */
  ctx?: SessionEncryptionContext | null;
}>): Promise<string | null> {
  const synopsis = await fetchLatestMemorySynopsisSystemRecord({
    token: params.credentials.token,
    sessionId: params.sessionId,
    mode: params.encryptionMode === 'plain' ? 'plain' : 'e2ee',
    ...(params.ctx ? { ctx: params.ctx } : {}),
  }).catch((error) => {
    if (isAuthenticationError(error)) throw error;
    return null;
  });
  const text = typeof synopsis?.synopsis === 'string' ? synopsis.synopsis.trim() : '';
  return text.length > 0 ? text : null;
}

function readForkV1FromMetadata(metadata: Record<string, unknown>): ForkV1 | null {
  const fork = (metadata as any)?.forkV1;
  if (!fork || typeof fork !== 'object') return null;
  if ((fork as any).v !== 1) return null;
  const parentSessionId = typeof (fork as any).parentSessionId === 'string' ? String((fork as any).parentSessionId).trim() : '';
  const cutoffRaw = (fork as any).parentCutoffSeqInclusive;
  const cutoff = typeof cutoffRaw === 'number' && Number.isFinite(cutoffRaw) ? Math.max(0, Math.floor(cutoffRaw)) : NaN;
  if (!parentSessionId) return null;
  if (!Number.isFinite(cutoff)) return null;
  return { v: 1, parentSessionId, parentCutoffSeqInclusive: cutoff };
}

function readMinSeq(rows: readonly { seq?: unknown }[]): number | null {
  let min = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const seq = typeof row?.seq === 'number' && Number.isFinite(row.seq) ? row.seq : null;
    if (seq === null) continue;
    min = Math.min(min, Math.floor(seq));
  }
  return Number.isFinite(min) ? Math.max(0, min) : null;
}

export async function hydrateReplayDialogFromForkChain(params: Readonly<{
  credentials: Credentials;
  startingSessionId: string;
  /** Transcript page size. The server caps a single request at 500 rows. */
  limit: number;
  /**
   * Optional count stop, for the released `recentMessagesCount` wire contract.
   * Absent means the CHARACTER budget is the only content bound — which is the
   * point: a fixed row count in front of a character budget makes the budget
   * unreachable for short turns and redundant for long ones.
   */
  maxDialogItems?: number | null;
  /**
   * How many characters of transcript the seed can actually carry, answered by
   * the framer that will render it
   * (`planHappierReplayTranscriptCharBudget`). Retrieval stops exactly where the
   * framer would have started dropping, so the two do not truncate in sequence.
   *
   * Called once, after the synopsis is resolved, because the synopsis is part of
   * the frame the transcript has to share the budget with.
   */
  planTranscriptCharBudget?: (input: Readonly<{
    summaryText: string | null;
    sessionTitle: string | null;
  }>) => number | null;
  maxTextChars?: number;
  upToSeqInclusive?: number;
  /**
   * Exclusive LOWER bound in the STARTING Session's seq space: rows at or below
   * it are not fetched at all.
   *
   * Set only when the reader already holds everything up to that seq — today
   * that is the same-Session Agent transition returning an Agent to its own
   * native conversation (`AM-26`). The bound is enforced HERE, not by the
   * server: this walk pages BACKWARDS with `beforeSeq`, and
   * `GET /v1/sessions/:sessionId/messages` rejects `beforeSeq` and `afterSeq`
   * together with `400 beforeSeq and afterSeq are mutually exclusive`. Sending
   * both failed every bounded fetch. Rows at or below the bound are dropped
   * from each page, and the backward cursor stops once it reaches the bound, so
   * the walk still neither carries history it will discard nor spends its
   * request ceiling paging below it.
   *
   * A bound also ENDS the chain here: it lives in this Session's seq space, so
   * a parent segment is entirely below it by construction. Reaching it is
   * therefore natural termination, and `reachedSourceStart` stays true — the
   * seed must not claim a loss that does not exist.
   */
  afterSeqExclusive?: number;
  maxDepth?: number;
  /**
   * When false, do not resolve `session_synopsis.v1` artifacts at all.
   *
   * Callers should set this to true only when they will actually use
   * `synopsisText` (e.g. replay strategy `summary_plus_recent`).
   */
  wantSynopsisText?: boolean;
}>): Promise<{
  dialog: HappierReplayDialogItem[];
  sourceCutoffSeqInclusive: number;
  synopsisText?: string | null;
  /**
   * The chain was read, but not all of it: a segment could not be fetched or
   * opened, or the decoder examined rows it could not read. The returned dialog
   * is then a conversation WITH HOLES, and only this owner can say so — every
   * skip beneath it is a `continue`.
   *
   * Distinct from a `null` result: `null` means the retrieval failed and what the
   * source holds is unknown; this means part of it is known to be missing.
   *
   * Also distinct from `reachedSourceStart`: a bounded walk that simply stopped
   * has no holes in what it carries.
   */
  historyIncomplete: boolean;
  /**
   * False when the walk stopped on a bound — character budget, count, request
   * ceiling or deadline — rather than on the start of the source.
   *
   * The framer's omission notice marks items it was GIVEN and dropped; rows this
   * walk never fetched are invisible to it. Without this fact the seed presents
   * a truncated tail as the whole conversation.
   *
   * A native-return `afterSeqExclusive` bound is NOT such a stop: the reader
   * already holds everything below it, so the walk reaching it is the start of
   * the source as far as that reader is concerned.
   */
  reachedSourceStart: boolean;
  /**
   * The source's most recent user turn, whether or not the window reached it.
   *
   * A character budget fills from the newest end, and on a long agent-led
   * stretch the newest end is all agent: the observed window held 500 rows and
   * no user turn at all, so the target Agent received the work without the
   * instruction it was serving.
   */
  lastUserDialogItem: HappierReplayDialogItem | null;
  /** The starting Session's `metadata.summary.text`, when it has one. */
  sourceTitleText: string | null;
} | null> {
  const maxDepth =
    typeof params.maxDepth === 'number' && Number.isFinite(params.maxDepth)
      ? Math.max(1, Math.min(25, Math.floor(params.maxDepth)))
      : 10;
  const pageSize =
    typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(500, Math.floor(params.limit)))
      : 500;
  const maxDialogItems =
    typeof params.maxDialogItems === 'number' && Number.isFinite(params.maxDialogItems)
      ? Math.max(1, Math.floor(params.maxDialogItems))
      : null;
  const maxRequests = configuration.replaySeedMaxTranscriptRequests;
  const deadlineAtMs = Date.now() + configuration.replaySeedTranscriptDeadlineMs;
  const afterSeqExclusive =
    typeof params.afterSeqExclusive === 'number'
      && Number.isSafeInteger(params.afterSeqExclusive)
      && params.afterSeqExclusive >= 0
      ? params.afterSeqExclusive
      : null;
  /**
   * The departure bound applied to the rows a page actually returned.
   *
   * The route refuses `beforeSeq` together with `afterSeq`, and this walk needs
   * `beforeSeq` to page backwards, so the lower bound cannot be a query
   * parameter. Dropping the rows here and stopping the cursor at the bound
   * below is the same window, asked for legally.
   */
  const withinDepartureBound = (rows: readonly RawTranscriptRow[]): readonly RawTranscriptRow[] =>
    afterSeqExclusive === null
      ? rows
      : rows.filter((row) => typeof row.seq === 'number' && row.seq > afterSeqExclusive);

  const visited = new Set<string>();
  const segments: Array<{ sessionId: string; rawSession: any; upToSeqInclusive?: number }> = [];

  let currentSessionId = String(params.startingSessionId ?? '').trim();
  let currentUpToSeqInclusive = params.upToSeqInclusive;
  /**
   * The walk ended because the chain ended, not because a bound or an
   * unreadable segment stopped it. Only then can an exhausted page walk claim
   * it reached the start of the source.
   */
  let chainTerminatedNaturally = false;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!currentSessionId) {
      chainTerminatedNaturally = true;
      break;
    }
    if (visited.has(currentSessionId)) break;
    visited.add(currentSessionId);

    const rawSession = await fetchSessionByIdCompat({ token: params.credentials.token, sessionId: currentSessionId }).catch((error) => {
      if (isAuthenticationError(error)) throw error;
      return null;
    });
    if (!rawSession) break;

    segments.push({
      sessionId: currentSessionId,
      rawSession,
      ...(typeof currentUpToSeqInclusive === 'number' && Number.isFinite(currentUpToSeqInclusive)
        ? { upToSeqInclusive: Math.max(0, Math.floor(currentUpToSeqInclusive)) }
        : {}),
    });

    if (afterSeqExclusive !== null) {
      // The bound is in THIS Session's seq space and no parent segment reaches
      // above it, so the chain is exhausted here by construction rather than by
      // a bound the seed would have to disclose.
      chainTerminatedNaturally = true;
      break;
    }

    const metadata = tryDecryptSessionMetadata({ credentials: params.credentials, rawSession });
    if (!metadata) break;
    const fork = readForkV1FromMetadata(metadata);
    if (!fork) {
      chainTerminatedNaturally = true;
      break;
    }

    currentSessionId = fork.parentSessionId;
    currentUpToSeqInclusive = fork.parentCutoffSeqInclusive;
  }

  if (segments.length === 0) return null;

  /**
   * "This Session carries no dialog" and "a segment could not be read" are
   * different facts, and this is the only owner that can tell them apart: every
   * unreadable segment below is skipped with `continue`, so an empty result can
   * mean either. Collapsing both into `null` made a fresh empty Session
   * indistinguishable from a failed retrieval, and the same-Session Agent
   * transition asks this question AFTER stopping the source — so the one case
   * that trivially cannot fail was the one that failed.
   */
  let segmentContentUnavailable = false;
  let unreadableRowCount = 0;
  const wantSynopsisText = params.wantSynopsisText === true;

  /**
   * WHICH key opens a Session is not this reader's decision. The canonical
   * session-crypto owner already answers it for every credential shape the
   * daemon can hold — the Account secret for a legacy home, the Session's
   * sealed DEK (or the machine key for a pre-DEK Session) for a data-key home
   * — and every other reader of a Session's stored content goes through it.
   */
  const openSegment = (segment: { rawSession: any }): SessionEncryptionContext | null =>
    (segment.rawSession as any)?.encryptionMode === 'plain'
      ? null
      : resolveSessionEncryptionContextFromCredentials(params.credentials, segment.rawSession);

  const startingSegment = segments[0]!;
  const startingSessionSeq =
    typeof (startingSegment.rawSession as any)?.seq === 'number' && Number.isFinite((startingSegment.rawSession as any).seq)
      ? Math.max(0, Math.floor((startingSegment.rawSession as any).seq))
      : 0;
  const sourceCutoffSeqInclusive =
    typeof startingSegment.upToSeqInclusive === 'number' && Number.isFinite(startingSegment.upToSeqInclusive)
      ? Math.max(0, Math.floor(startingSegment.upToSeqInclusive))
      : startingSessionSeq;

  const sourceTitleText = readSessionTitleText(
    tryDecryptSessionMetadata({ credentials: params.credentials, rawSession: startingSegment.rawSession }),
  );

  // Resolved BEFORE the walk, because the summary is part of the frame the
  // transcript shares its budget with: planning the walk without it would fetch
  // more than the framer can carry and the framer would drop the oldest of it
  // again. Both sources here are dialog-independent, so nothing about this
  // ordering costs the walk anything.
  const startingCtx = openSegment(startingSegment);
  let synopsisText: string | null = null;
  if (wantSynopsisText) {
    const encryptionMode = (startingSegment.rawSession as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    synopsisText = await tryHydrateSynopsisFromSystemRecord({
      credentials: params.credentials,
      sessionId: startingSegment.sessionId,
      encryptionMode,
      ctx: startingCtx,
    });
    if (!synopsisText) {
      synopsisText = await tryHydrateSynopsisFromMetadataPointer({
        credentials: params.credentials,
        rawSession: startingSegment.rawSession,
        sessionId: startingSegment.sessionId,
        maxTextChars: params.maxTextChars,
        ctx: startingCtx,
      });
    }
  }

  const charBudget = params.planTranscriptCharBudget
    ? params.planTranscriptCharBudget({ summaryText: synopsisText, sessionTitle: sourceTitleText })
    : configuration.replaySeedMaxChars;

  /**
   * Accepted newest-first; the final sort restores conversation order. The walk
   * has to run this way round because a character budget is filled from the
   * newest end: the old oldest-first walk spent a whole page on every segment
   * and then threw most of it away at the tail slice.
   */
  const accepted: HappierReplayDialogItem[] = [];
  let usedChars = 0;
  let lastUserDialogItem: HappierReplayDialogItem | null = null;
  let requestsUsed = 0;
  let stoppedOnBound = false;
  let everySegmentExhausted = true;
  let pageSynopsisText: string | null = null;

  walk: for (const segment of segments) {
    const ctx = segment === startingSegment ? startingCtx : openSegment(segment);

    const sessionSeq =
      typeof (segment.rawSession as any)?.seq === 'number' && Number.isFinite((segment.rawSession as any).seq)
        ? Math.max(0, Math.floor((segment.rawSession as any).seq))
        : 0;
    const cutoff =
      typeof segment.upToSeqInclusive === 'number' && Number.isFinite(segment.upToSeqInclusive)
        ? Math.max(0, Math.floor(segment.upToSeqInclusive))
        : sessionSeq;

    let cursor = Math.max(0, Math.floor(cutoff) + 1);
    let firstPage = true;
    let segmentExhausted = false;

    while (!segmentExhausted) {
      if (requestsUsed >= maxRequests || Date.now() >= deadlineAtMs) {
        stoppedOnBound = true;
        everySegmentExhausted = false;
        break walk;
      }
      requestsUsed += 1;

      const page = await fetchEncryptedTranscriptMessagesPage({
        token: params.credentials.token,
        sessionId: segment.sessionId,
        limit: pageSize,
        beforeSeq: cursor,
        roles: REPLAY_DIALOG_MESSAGE_ROLES,
      }).catch((error) => {
        if (isAuthenticationError(error)) throw error;
        return null;
      });
      if (!page) {
        everySegmentExhausted = false;
        // A segment that could not be opened at all is a hole. A page that
        // failed after the first one is a stop: what was already collected is
        // real, and re-asking for it is how a slow server turns one failure
        // into a retry loop.
        if (firstPage) {
          segmentContentUnavailable = true;
          continue walk;
        }
        stoppedOnBound = true;
        break walk;
      }
      firstPage = false;

      const slice = decryptTranscriptReplaySlice({
        rows: withinDepartureBound(page.messages as readonly RawTranscriptRow[]),
        ...(ctx ?? {}),
        maxTextChars: params.maxTextChars,
        maxDialogItems: pageSize,
      });
      unreadableRowCount += slice.unreadableRowCount;
      if (wantSynopsisText && !pageSynopsisText) pageSynopsisText = slice.latestSynopsisText;
      /**
       * Every row this page produced, tagged with the Session its `seq` is
       * numbered in.
       *
       * This walk is the one place a chain's Sessions meet: `accepted` below
       * concatenates segments, and after the final sort a parent row and a child
       * row are two entries whose seq means something different. Untagged, the
       * seed's range claim reads them as one span and hands the Session it points
       * at a paging cursor taken from another Session's numbering — so the rows
       * above that cursor are skipped forever.
       */
      const pageDialog = slice.dialog.map((item) => ({ ...item, sessionId: segment.sessionId }));

      let budgetMet = false;
      for (let index = pageDialog.length - 1; index >= 0; index -= 1) {
        const item = pageDialog[index]!;
        // Tracked on every turn the walk SAW, not only the ones it kept: a user
        // turn the budget refused is still the newest instruction, and knowing
        // it is here is what makes the extra lookup below unnecessary.
        if (item.role === 'User' && !lastUserDialogItem) lastUserDialogItem = item;

        const previouslyAccepted = accepted[accepted.length - 1];
        if (previouslyAccepted && isSupersededAdjacentDuplicate(item, previouslyAccepted)) continue;

        if (maxDialogItems !== null && accepted.length >= maxDialogItems) {
          budgetMet = true;
          break;
        }
        const cost = measureHappierReplayDialogLineChars(item) + (accepted.length === 0 ? 0 : 1);
        if (charBudget !== null && accepted.length > 0 && usedChars + cost > charBudget) {
          budgetMet = true;
          break;
        }
        usedChars += cost;
        accepted.push(item);
        // The newest turn alone can exceed the whole budget. Keeping it is
        // right — the framer clips its TEXT with a marker — but nothing after
        // it can fit, so the walk stops instead of paging for room that does
        // not exist.
        if (charBudget !== null && usedChars >= charBudget) {
          budgetMet = true;
          break;
        }
      }

      if (budgetMet) {
        stoppedOnBound = true;
        everySegmentExhausted = false;
        break walk;
      }

      // `nextBeforeSeq` is the server's own exhaustion signal. A deployment that
      // does not send one is read the way the synopsis scan already read it —
      // by the oldest seq on the page — and a short page ends the segment.
      const nextCursor = page.nextBeforeSeq ?? readMinSeq(page.messages);
      if (
        page.messages.length === 0
        || nextCursor === null
        || nextCursor <= 0
        || nextCursor >= cursor
        || (page.nextBeforeSeq === null && page.messages.length < pageSize)
        // The departure bound, as a stop rather than a query parameter: the
        // next request would ask for `seq < nextCursor`, and once that is at or
        // below the bound every row it could return is already in the returning
        // Agent's own conversation. Same exhaustion, so `reachedSourceStart`
        // still holds — reaching the bound is the start of the source for this
        // reader.
        || (afterSeqExclusive !== null && nextCursor <= afterSeqExclusive + 1)
      ) {
        segmentExhausted = true;
        break;
      }
      cursor = nextCursor;
    }
  }

  // Empty AND something was unreadable: what this chain holds is unknown, so the
  // caller must treat it as unavailable. Empty with every segment read is the
  // truthful "nothing to carry over".
  if (accepted.length === 0 && segmentContentUnavailable) return null;

  // The window is all agent output, so the instruction it is serving is outside
  // it. One targeted lookup — the newest user row of the source, nothing else —
  // is the whole cost of not handing the target Agent the work without the ask.
  if (!lastUserDialogItem) {
    const pinnedPage = await fetchEncryptedTranscriptMessagesPage({
      token: params.credentials.token,
      sessionId: startingSegment.sessionId,
      limit: 1,
      beforeSeq: Math.max(0, sourceCutoffSeqInclusive + 1),
      roles: ['user'],
    }).catch((error) => {
      if (isAuthenticationError(error)) throw error;
      return null;
    });
    if (pinnedPage) {
      const pinnedSlice = decryptTranscriptReplaySlice({
        // Bounded the same way as the walk, and for the same reason it cannot be
        // an `afterSeq`: a user turn from BEFORE the returning Agent left is
        // already in that Agent's own conversation, and pinning it as "the
        // latest instruction" would restate an ask it has already served.
        rows: withinDepartureBound(pinnedPage.messages as readonly RawTranscriptRow[]),
        ...(startingCtx ?? {}),
        maxTextChars: params.maxTextChars,
        maxDialogItems: 1,
      });
      const pinned = pinnedSlice.dialog.find((item) => item.role === 'User');
      lastUserDialogItem = pinned ? { ...pinned, sessionId: startingSegment.sessionId } : null;
    }
  }

  const dialog = [...accepted].sort((a, b) => a.createdAt - b.createdAt);
  return {
    dialog,
    sourceCutoffSeqInclusive,
    synopsisText: wantSynopsisText ? (synopsisText ?? pageSynopsisText) : null,
    // ONE incompleteness fact for the whole chain: a segment that could not be
    // read at all and a row the decoder could not read are the same loss to the
    // reader of the seed. A bound the walk stopped on is NOT a hole — it is
    // reported separately, because the seed states the two differently.
    historyIncomplete: segmentContentUnavailable || unreadableRowCount > 0,
    reachedSourceStart: chainTerminatedNaturally && everySegmentExhausted && !stoppedOnBound,
    lastUserDialogItem,
    sourceTitleText,
  };
}
