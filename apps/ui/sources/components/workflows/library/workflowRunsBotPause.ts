import type { SessionListBotRowsByServerId } from '@/sync/store/domains/sessionListBotSelection';

/** The person's own Bots on one Home, and which of them are paused (the Runs "Now" Pause all / Resume). */
export type WorkflowRunsBotPause = Readonly<{
  ownBotIds: readonly string[];
  pausedBotIds: readonly string[];
}>;

const EMPTY: WorkflowRunsBotPause = Object.freeze({
  ownBotIds: [],
  pausedBotIds: [],
});

/**
 * Reads the Session list's loaded Bot rows for one Home. Only the person's own Bots can be paused (a shared
 * Session names its `owner`); the pause itself is each Bot's `botPausedAt`, pushed with its Session row.
 * `previous` is returned when neither list changed, so the Now leaf does not re-render for an unrelated Bot update.
 */
export function projectWorkflowRunsBotPause(
  rows: SessionListBotRowsByServerId[string],
  previous: WorkflowRunsBotPause = EMPTY,
): WorkflowRunsBotPause {
  const ownBotIds: string[] = [];
  const pausedBotIds: string[] = [];
  for (const row of Object.values(rows ?? {})) {
    if (row.owner !== undefined) continue;
    ownBotIds.push(row.id);
    if (row.botPausedAt != null) pausedBotIds.push(row.id);
  }
  ownBotIds.sort();
  pausedBotIds.sort();
  return sameIds(previous.ownBotIds, ownBotIds) &&
    sameIds(previous.pausedBotIds, pausedBotIds)
    ? previous
    : { ownBotIds, pausedBotIds };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/**
 * Pause every own Bot not paused yet, or resume every paused one: one `session.bot.set` per Bot, all at once.
 * Each Bot's write stands alone; the count of refused writes lets the caller say some did not change.
 */
export async function applyWorkflowRunsBotPause(
  params: Readonly<{
    pause: WorkflowRunsBotPause;
    intent: 'pause' | 'resume';
    now: number;
    write: (
      sessionId: string,
      pausedAt: number | null,
    ) => Promise<Readonly<{ ok: boolean }>>;
  }>,
): Promise<Readonly<{ failed: number }>> {
  const paused = new Set(params.pause.pausedBotIds);
  const targets =
    params.intent === 'pause'
      ? params.pause.ownBotIds.filter((id) => !paused.has(id))
      : params.pause.pausedBotIds;
  const pausedAt = params.intent === 'pause' ? params.now : null;
  const results = await Promise.all(
    targets.map((id) =>
      params.write(id, pausedAt).catch(() => ({ ok: false })),
    ),
  );
  return { failed: results.filter((result) => !result.ok).length };
}
