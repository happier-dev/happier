import { inboxItemViewV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { areSessionBotFaceFactsEqual, readSessionBotFaceFacts, type SessionBotFaceFacts } from './face/sessionBotFaceFacts';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts, sessionWorkStatusFactsFromStatus } from '@/components/work/status/sessionWorkStatusFacts';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionStatusNextRefreshAtMs } from '@/utils/sessions/sessionUtils';

export type BotActivity = 'needsYou' | 'working' | 'quiet';

/**
 * What a Bot is doing, as the roster header, the rail badge and the rail pins all say it: one
 * reading of the shared Session presentation, including reachability and content availability.
 */
export function classifyBotActivity(
  status: Pick<WorkStatusPresentation, 'bucket' | 'attentionType'> | null | undefined,
): BotActivity {
  if (!status) return 'quiet';
  if (status.attentionType && inboxItemViewV1(status.attentionType) === 'needs_you') return 'needsYou';
  return status.bucket === 'working' ? 'working' : 'quiet';
}

/** The same reading from a loaded row (the rail holds rows, not row view models). */
export function readBotActivity(
  session: Parameters<typeof readSessionWorkStatusFacts>[0],
  nowMs: number,
  status?: Parameters<typeof sessionWorkStatusFactsFromStatus>[1],
): BotActivity {
  const facts = status ? sessionWorkStatusFactsFromStatus(session, status, { nowMs })
    : readSessionWorkStatusFacts(session, nowMs);
  return classifyBotActivity(resolveWorkStatusTone({ kind: 'session', facts }));
}

const BOT_ACTIVITY_RANK: Readonly<Record<BotActivity, number>> = { needsYou: 0, working: 1, quiet: 2 };

/**
 * The roster's order (lab `b-rail A`): what needs the person first, then what is working, then the
 * rest, each most recently active first, so the header's counts are the first rows it lists. A
 * stable sort keeps the list's own order between Bots that tie.
 */
export function compareBotRosterOrder(
  left: Readonly<{ activity: BotActivity; meaningfulActivityAt: number }>,
  right: Readonly<{ activity: BotActivity; meaningfulActivityAt: number }>,
): number {
  return (
    BOT_ACTIVITY_RANK[left.activity] - BOT_ACTIVITY_RANK[right.activity] ||
    right.meaningfulActivityAt - left.meaningfulActivityAt
  );
}

export type BotOrderRow = SessionAddress & Readonly<{ session: SessionListRenderableSession | null }>;

/** Presentation facts only: raw liveness remains in the loaded Session maps. */
export type OrderedBot = SessionAddress & Readonly<{
  key: string;
  /** The Bot's face, read once by the Session face owner (a roster row without a loaded Session seeds by its id). */
  face: SessionBotFaceFacts;
  activity: BotActivity;
  meaningfulActivityAt: number;
}>;

/** One pure projection for loaded Bots and queried roster rows. The previous source/projection
 * belongs to the existing presentation reader; it lets unchanged rows retain their identity and
 * heartbeat-only updates avoid sorting or publishing. No wall clock or retained raw rows here. */
export function orderBots(
  rows: readonly BotOrderRow[],
  nowMs: number,
  status?: (row: BotOrderRow, index: number) => Parameters<typeof readBotActivity>[2] | null,
  previous?: Readonly<{ rows: readonly BotOrderRow[]; nowMs: number; ordered: readonly OrderedBot[] }>,
): readonly OrderedBot[] {
  const previousEntries = new Map(previous?.ordered.map(entry => [entry.key, entry]));
  const previousRows = new Map(previous?.rows.map(row => [sessionAddressKey(row), row]));
  let rankingChanged = rows.length !== previous?.ordered.length;
  const entries = rows.map((row, index): OrderedBot => {
    const key = sessionAddressKey(row);
    const prior = previousEntries.get(key);
    if (!status && prior && previous && previousRows.get(key)?.session === row.session) {
      const nextRefresh = row.session && previous.nowMs !== nowMs
        ? readSessionStatusNextRefreshAtMs(row.session, previous.nowMs) : null;
      if (nextRefresh === null || nextRefresh > nowMs) return prior;
    }
    const activity = row.session ? readBotActivity(row.session, nowMs, status?.(row, index) ?? undefined) : 'quiet';
    const meaningfulActivityAt = row.session ? resolveSessionListRenderableMeaningfulActivityAt(row.session) : 0;
    const read = (row.session ? readSessionBotFaceFacts(row.session, row.serverId) : null) ?? { seed: row.sessionId, face: null };
    const face = prior && areSessionBotFaceFactsEqual(prior.face, read) ? prior.face : read;
    if (!prior || prior.activity !== activity || prior.meaningfulActivityAt !== meaningfulActivityAt) rankingChanged = true;
    if (prior && prior.activity === activity && prior.meaningfulActivityAt === meaningfulActivityAt && prior.face === face) return prior;
    return { serverId: row.serverId, sessionId: row.sessionId, key, face, activity, meaningfulActivityAt };
  });
  if (!rankingChanged && previous) {
    const sourceIndexes = new Map(entries.map((entry, index) => [entry.key, index]));
    // An actual source-order change between tied rows must remain visible too.
    rankingChanged = previous.ordered.some((entry, index, ordered) => index > 0
      && compareBotRosterOrder(ordered[index - 1]!, entry) === 0
      && sourceIndexes.get(ordered[index - 1]!.key)! > sourceIndexes.get(entry.key)!);
    if (!rankingChanged) {
      const byKey = new Map(entries.map(entry => [entry.key, entry]));
      const ordered = previous.ordered.map(entry => byKey.get(entry.key)!);
      return ordered.every((entry, index) => entry === previous.ordered[index]) ? previous.ordered : ordered;
    }
  }
  return entries.sort(compareBotRosterOrder);
}
