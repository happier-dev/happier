import { isSlashCommandSupported } from '@happier-dev/plugin-sdk/sessions';
import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/sessions/work-state';

import {
  buildEmptyClaudeGoalWorkStateSnapshot,
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  createClaudeGoalStatusWorkStateTracker,
  parseClaudeGoalStatusAttachment,
} from './goalStatus.js';

/**
 * Centralized Claude native `/goal` SOURCE wiring (ported by intent from
 * remote-dev's H6 `claudeGoalSource.ts`).
 *
 * The native Claude `/goal` feature surfaces goal state as a transcript
 * `attachment` record (`attachment.type === 'goal_status'`) and exposes the
 * `/goal` command through the system/init `slash_commands` list. Both signals
 * travel on the same raw-JSONL transcript stream that the unified-terminal
 * provider transcript follow loop already parses row by row.
 *
 * This module is the ONE place that knows how to turn those transcript signals
 * into a published `SessionWorkStateItemV1 kind:'goal'`. It wraps the latest-wins
 * goal tracker and the fail-closed `/goal` capability gate so the goal source is
 * wired identically wherever raw rows are observed — instead of each launcher
 * re-implementing the routing inline. The publish callback is invoked only when
 * the resolved goal item changes (allocation-light; safe to call per row inside
   * the shared file-follow row callback).
 */

export type ClaudeGoalWorkStateSource = Readonly<{
  /**
   * Observe one raw transcript row (a parsed `RawJSONLines` record or any
   * record-shaped message). Routes a `goal_status` attachment into the goal
   * work-state and reads the `/goal` capability from a system/init record's
   * `slash_commands` (fail-closed: unknown/missing commands leave it disabled).
   * Non-goal rows and unknown attachment subtypes are ignored.
   *
   * This is the ONLY ingress in the ../dev runner topology: the unified-terminal
   * follow loop replays the on-disk JSONL (incl. the system-init row carrying
   * `slash_commands`) through `onObserveRow`. Unlike remote-dev — whose agent-SDK
   * runner surfaces `slash_commands` out-of-band via an `onCapabilities` callback
   * and so needs a separate `applySlashCommands` ingress — the ../dev SDK runner
   * does not wire goal state, so no out-of-band capability path exists or is
   * needed here.
   */
  observeTranscriptMessage(message: unknown): void;
  /**
   * Deterministically remove the published Claude goal work-state item (publishes an empty goal-owned
   * snapshot) AND record a goal-control CLEAR intent so the provider's continued ACTIVE re-evaluation
   * of the cleared goal does not resurrect it. Used by the ACTIVE-session clear effector because
   * Claude's `/goal clear` emits no `goal_status` attachment the source could observe — without this
   * the work-state keeps showing the last (now-stale) goal after a clear. Idempotent.
   */
  clearGoalWorkState(): void;
  /**
   * Record a goal-control SET intent (the ACTIVE-session set effector injects `/goal <objective>`).
   * Bumps the goal-control epoch so re-setting the SAME objective after a clear is accepted — the
   * resulting active `goal_status` is no longer treated as a stale post-clear replay (G2/QA-CHIP-4).
   * Does not publish; the goal item still comes from the subsequent observed `goal_status`.
   */
  recordGoalSetIntent(): void;
  /**
   * G-3/E restart continuity: seed the live-usage accumulator from the last-published goal work-state
   * item (read from session metadata at wiring time). Only an ACTIVE item with usage seeds; terminal
   * or usage-less items are ignored. Lets a fresh tracker continue a running total after a CLI restart
   * instead of restarting the mid-run usage from zero.
   */
  reseedActiveGoalUsageFromPublishedItem(
    item: Readonly<{ status?: unknown; tokensUsed?: unknown; timeUsedSeconds?: unknown; updatedAt?: unknown }> | null | undefined,
  ): void;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readSlashCommandsFromSystemMessage(message: unknown): unknown {
  const record = asRecord(message);
  if (!record || record.type !== 'system') return undefined;
  return record.slash_commands;
}

/**
 * Read the Claude transcript session id that ESTABLISHES the channel's identity, from a record.
 * Every record on a Claude session's transcript channel (system, assistant, user, …) carries the
 * Claude session id under `sessionId` (camelCase) — this is the id `goal_status` attachments are
 * matched against, NOT the Happier session id.
 *
 * `goal_status` attachments are intentionally excluded: an attachment must be VALIDATED against the
 * established channel id, so it cannot be allowed to self-authorize (which would defeat the
 * cross-session guard). Non-goal_status records define the session; the goal_status attachment is
 * the thing being guarded.
 */
function readEstablishingClaudeSessionIdFromMessage(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) return null;
  const attachment = asRecord(record.attachment);
  if (attachment && attachment.type === 'goal_status') return null;
  const value = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  return value.length > 0 ? value : null;
}

const SYNTHETIC_NO_RESPONSE_TEXT = 'No response requested.';

/**
 * Read the additive per-message token cost from a raw `assistant` transcript row's `message.usage`.
 * G-3/E accumulates NEW tokens billed per turn — `input_tokens + output_tokens + cache_creation` —
 * deliberately excluding `cache_read_input_tokens` (re-reading the growing context each turn would
 * multiply-count it). The provider's authoritative `goal_status.tokens` WINS on completion, so this
 * mid-run figure is an honest estimate, not a precise accounting.
 *
 * MAIN-CHAIN ONLY. A subagent's assistant rows ride the SAME raw transcript channel as the parent's,
 * distinguished by `isSidechain: true`, and their cost belongs to the CHILD. Refusing them as turn
 * BOUNDARIES (`isCompletedTurnBoundaryRow`) is not enough on its own: without this guard their tokens
 * still accrue into `pendingTurnTokens` and are folded at the next PARENT boundary, billing a
 * subagent's budget to the parent goal's meter (measured on a real transcript: 42,277 sidechain
 * tokens against 13,955 main-chain, a 3x overstatement). The two guards answer different questions —
 * "is this a boundary?" and "whose tokens are these?" — and both are required.
 */
function readAssistantTurnTokens(message: unknown): number {
  const record = asRecord(message);
  if (!record || record.type !== 'assistant') return 0;
  if (record.isSidechain === true) return 0;
  const inner = asRecord(record.message);
  const usage = asRecord(inner?.usage);
  if (!usage) return 0;
  const read = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
  return read(usage.input_tokens) + read(usage.output_tokens) + read(usage.cache_creation_input_tokens);
}

/**
 * G-3/E restart double-count guard: is a raw transcript row STRICTLY newer than `basisMs`?
 * Rows carry an ISO `timestamp`. Fail-closed — a row without a parseable timestamp returns `false`
 * (cannot be proven newer than the floor basis, so it is treated as already-counted and not re-folded).
 */
function isTranscriptRowNewerThanMs(message: unknown, basisMs: number): boolean {
  const raw = asRecord(message)?.timestamp;
  const timestampMs = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(timestampMs) && timestampMs > basisMs;
}

function firstTextContent(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    const record = asRecord(item);
    if (record && typeof record.text === 'string') return record.text;
  }
  return null;
}

function isSyntheticNoResponseAssistantRow(record: Record<string, unknown>): boolean {
  if (record.model !== '<synthetic>') return false;
  const inner = asRecord(record.message);
  return firstTextContent(inner?.content)?.trim() === SYNTHETIC_NO_RESPONSE_TEXT;
}

/**
 * G-3/E turn-boundary detector for live goal-usage folding. Returns true only on a COMPLETED turn
 * boundary — a non-sidechain assistant row whose `message.stop_reason` is `end_turn` (excluding the
 * synthetic "No response requested." closure), or a MANUAL compact boundary. Mirrors the
 * `completion_candidate` cases of the shared Claude turn-signal reader; intentionally narrow (this
 * source only needs "did a turn just complete?", not the full lifecycle taxonomy — so it stays a
 * purpose-specific derivation rather than importing the runtime-layer lifecycle mapper).
 */
function isCompletedTurnBoundaryRow(message: unknown): boolean {
  const record = asRecord(message);
  if (!record) return false;
  if (record.isSidechain === true) return false;
  if (record.type === 'assistant') {
    const inner = asRecord(record.message);
    const stopReason = inner && typeof inner.stop_reason === 'string' ? inner.stop_reason : '';
    return stopReason === 'end_turn' && !isSyntheticNoResponseAssistantRow(record);
  }
  if (record.type === 'system') {
    if (record.subtype !== 'compact_boundary') return false;
    const meta = asRecord(record.compactMetadata) ?? asRecord(record.compact_metadata);
    const trigger = meta && typeof meta.trigger === 'string' ? meta.trigger.trim().toLowerCase() : '';
    // Manual compaction is a completed turn boundary; auto-compaction is a continuation, not a boundary.
    return trigger !== 'auto';
  }
  return false;
}

export function createClaudeGoalWorkStateSource(params: Readonly<{
  backendId: string;
  agentId?: string;
  publishWorkStateSnapshot: (snapshot: SessionWorkStateV1) => void;
  /**
   * Optional seed for the active CLAUDE transcript session id used by the cross-session guard
   * (mirrors happy's `metadata.claudeSessionId`). This MUST be the Claude session id (the transcript
   * `sessionId`), NOT the Happier session id — the latter never matches a `goal_status` attachment's
   * `sessionId` and would drop every goal. The source also self-learns this id from the transcript
   * records it observes, so a `null` seed is fine (the guard is then a no-op until the channel's id
   * is established, exactly like happy when `claudeSessionId` is still unknown).
   */
  getCurrentClaudeSessionId: () => string | null;
  logError?: (message: string, error: unknown) => void;
  /** Injectable clock for the live-usage wall-time (G-3/E). Defaults to `Date.now`. */
  now?: () => number;
}>): ClaudeGoalWorkStateSource {
  const now = params.now ?? Date.now;
  const tracker = createClaudeGoalStatusWorkStateTracker({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    // Fail-closed: `/goal` support is confirmed FACTUALLY from the runtime
    // `slash_commands` (see applySlashCommands), not assumed.
  });

  // The Claude session id this source guards against. Self-learned (latest-wins) from the channel's
  // establishing records; the injected seed is consulted only before any has been observed. Null =>
  // guard is a no-op (accept), matching happy's behavior when the claude session id is still unknown.
  let observedClaudeSessionId: string | null = null;
  const resolveCurrentClaudeSessionId = (): string | null =>
    observedClaudeSessionId ?? params.getCurrentClaudeSessionId();

  // G-3/E live-usage state. `goalSetAtMs` is the wall-clock time the current active goal was first
  // observed (basis for elapsed); `pendingTurnTokens` accrues the current in-flight turn's new tokens
  // and is folded into the goal item on the turn boundary, then reset.
  let goalSetAtMs: number | null = null;
  let pendingTurnTokens = 0;
  // G-3/E restart double-count guard. After a restart the scanner may re-feed transcript history on
  // the raw channel, so historical assistant turns can re-arrive here. The reseed floor ALREADY counts
  // those turns; re-folding them would inflate the token total. `reseedBasisMs` is the wall-time the
  // floor was last published at — an assistant turn whose transcript `timestamp` is at/before it was
  // already counted and must NOT re-fold.
  let reseedBasisMs: number | null = null;

  const readPublishedActiveGoalStatus = (snapshot: SessionWorkStateV1): 'active' | 'other' | 'none' => {
    const item = snapshot.items.find((candidate) => candidate.id === CLAUDE_GOAL_WORK_STATE_ITEM_ID);
    if (!item) return 'none';
    return item.status === 'active' ? 'active' : 'other';
  };

  const publish = (snapshot: SessionWorkStateV1 | null): void => {
    if (!snapshot) return;
    // Track the active-goal lifecycle so live usage folds only during an active goal and elapsed is
    // measured from when THIS goal was set. A published active goal (re)starts the wall-time basis on
    // its first observation; a non-active or removed goal ends it.
    const status = readPublishedActiveGoalStatus(snapshot);
    if (status === 'active') {
      if (goalSetAtMs === null) goalSetAtMs = now();
    } else {
      goalSetAtMs = null;
      pendingTurnTokens = 0;
      // The goal lifecycle ended: a subsequent NEW goal in this process must count from scratch, so the
      // historical-replay guard basis no longer applies.
      reseedBasisMs = null;
    }
    try {
      params.publishWorkStateSnapshot(snapshot);
    } catch (error) {
      params.logError?.('failed to publish Claude goal work-state snapshot (non-fatal)', error);
    }
  };

  // G-3/E: on a turn boundary, fold the accrued turn tokens + elapsed wall-time into the active goal.
  const foldTurnUsageOnBoundary = (message: unknown): void => {
    // Skip turns already accounted for by the reseed floor (historical rows re-fed by transcript
    // initial-replay after a restart). Fail-closed: a row without a parseable timestamp cannot be
    // proven newer than the floor basis, so it is treated as already-counted and does not re-fold.
    if (reseedBasisMs !== null && !isTranscriptRowNewerThanMs(message, reseedBasisMs)) return;

    const turnTokens = readAssistantTurnTokens(message);
    if (turnTokens > 0) pendingTurnTokens += turnTokens;

    // Only a completed turn boundary records a usage checkpoint (never per streaming delta).
    if (!isCompletedTurnBoundaryRow(message)) return;
    if (goalSetAtMs === null) {
      pendingTurnTokens = 0;
      return;
    }
    const elapsedSeconds = Math.max(0, (now() - goalSetAtMs) / 1000);
    const snapshot = tracker.foldActiveGoalUsage({
      updatedAt: now(),
      currentClaudeSessionId: resolveCurrentClaudeSessionId(),
      addTokens: pendingTurnTokens,
      timeUsedSeconds: elapsedSeconds,
    });
    pendingTurnTokens = 0;
    // NB: bypass the lifecycle-tracking `publish` — a usage fold never changes the goal's active
    // status, and routing it through `publish` would be harmless but the direct call keeps the
    // wall-time basis untouched.
    if (snapshot) {
      try {
        params.publishWorkStateSnapshot(snapshot);
      } catch (error) {
        params.logError?.('failed to publish Claude goal usage snapshot (non-fatal)', error);
      }
    }
  };

  const applySlashCommands = (slashCommands: unknown): void => {
    // A non-array carries no capability info: leave the current `/goal` support untouched rather than
    // flipping it off. The `goal`/`/goal` shape parity lives in the shared protocol helper (D2).
    if (!Array.isArray(slashCommands)) return;
    publish(tracker.setGoalCommandSupported(isSlashCommandSupported(slashCommands, 'goal'), {
      updatedAt: Date.now(),
      currentClaudeSessionId: resolveCurrentClaudeSessionId(),
    }));
  };

  return {
    observeTranscriptMessage(message) {
      // Learn (and adopt, latest-wins) the Claude session id from this channel's ESTABLISHING
      // records (system/assistant/user — never the goal_status attachment itself) BEFORE the guard,
      // so the session's own `goal_status` attachments are never dropped while genuinely foreign
      // session ids (resume tail-bleed) are still rejected.
      const recordSessionId = readEstablishingClaudeSessionIdFromMessage(message);
      if (recordSessionId) observedClaudeSessionId = recordSessionId;

      const event = parseClaudeGoalStatusAttachment(message);
      if (event) {
        publish(tracker.applyAttachment(event, {
          updatedAt: Date.now(),
          currentClaudeSessionId: resolveCurrentClaudeSessionId(),
        }));
      }
      // The system/init record carries the `slash_commands` list on the same
      // transcript stream; gate `/goal` capability (fail-closed) from it.
      const slashCommands = readSlashCommandsFromSystemMessage(message);
      if (slashCommands !== undefined) applySlashCommands(slashCommands);
      // G-3/E: accrue this turn's token usage and, on a turn boundary, fold live usage into the
      // active goal. Rides the SAME raw transcript channel (assistant rows carry `message.usage`).
      foldTurnUsageOnBoundary(message);
    },
    clearGoalWorkState() {
      tracker.recordGoalControlIntent({ kind: 'clear' });
      publish(buildEmptyClaudeGoalWorkStateSnapshot({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: Date.now(),
      }));
    },
    recordGoalSetIntent() {
      tracker.recordGoalControlIntent({ kind: 'set' });
    },
    reseedActiveGoalUsageFromPublishedItem(item) {
      if (!item || item.status !== 'active') return;
      const tokensUsed = typeof item.tokensUsed === 'number' && item.tokensUsed >= 0 ? item.tokensUsed : undefined;
      const timeUsedSeconds = typeof item.timeUsedSeconds === 'number' && item.timeUsedSeconds >= 0 ? item.timeUsedSeconds : undefined;
      if (tokensUsed === undefined && timeUsedSeconds === undefined) return;
      tracker.reseedActiveGoalUsage({
        ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
      });
      // Record the floor's publish time as the historical-replay cutoff: assistant turns at/before it
      // were already counted into `tokensUsed`, so the initial-replay must not re-fold them.
      reseedBasisMs = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : null;
    },
  };
}
