import {
  resolveSessionWorkStatePrimaryItemId,
  type SessionWorkStateGoalCapabilitiesV1,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import { createClaudeGoalControlEpochTracker, type ClaudeGoalControlIntent } from './goalControlState.js';

/**
 * Claude native `/goal` source.
 *
 * Claude Code (>= 2.1.153) emits a transcript `attachment` record of
 * `attachment.type === 'goal_status'` whenever the active goal changes:
 *   - `met:false`              → goal is active (pursuing `condition`)
 *   - `met:true` + `sentinel`  → goal was cleared/cancelled
 *   - `met:true` (no sentinel) → goal completed
 *
 * Ported by intent from remote-dev's `claudeGoalStatus.ts` (parse + map + reduce,
 * latest-wins) and retargeted to our unified `SessionWorkStateItemV1 kind:'goal'`,
 * so a Claude goal coexists with the todo/task families that the outbound
 * dispatch facet already derives in `metadata.sessionWorkStateV1.items`.
 */

/** Stable id for the single Claude goal work-state item (latest-wins). */
export const CLAUDE_GOAL_WORK_STATE_ITEM_ID = 'goal:claude';
/** Source family the goal source owns in the work-state merge. */
export const CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY = 'goal:derived:claude.goal';
export const CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES = [
  CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY,
] as const;

export type ClaudeGoalStatusAttachment = Readonly<{
  type: 'goal_status';
  met: boolean;
  condition: string;
  sentinel?: boolean;
  reason?: string;
  iterations?: number;
  durationMs?: number;
  tokens?: number;
}>;

export type ClaudeGoalStatusTranscriptEvent = Readonly<{
  type: 'goal_status';
  uuid: string;
  sourceSessionId: string;
  sourceRevision: string;
  timestamp?: string;
  attachment: ClaudeGoalStatusAttachment;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestampToMs(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse a raw transcript record into a typed goal_status event. Returns null for
 * any record that is not a well-formed `goal_status` attachment. Mirrors
 * remote-dev `parseClaudeGoalStatusAttachment`.
 */
export function parseClaudeGoalStatusAttachment(value: unknown): ClaudeGoalStatusTranscriptEvent | null {
  const message = asRecord(value);
  if (!message || message.type !== 'attachment') {
    return null;
  }

  const attachment = asRecord(message.attachment);
  if (!attachment || attachment.type !== 'goal_status' || typeof attachment.met !== 'boolean') {
    return null;
  }

  const uuid = nonEmptyString(message.uuid);
  const sourceSessionId = nonEmptyString(message.sessionId);
  const condition = nonEmptyString(attachment.condition);
  if (!uuid || !sourceSessionId || !condition) {
    return null;
  }

  return {
    type: 'goal_status',
    uuid,
    sourceSessionId,
    sourceRevision: uuid,
    ...(optionalString(message.timestamp) !== undefined ? { timestamp: optionalString(message.timestamp) } : {}),
    attachment: {
      type: 'goal_status',
      met: attachment.met,
      condition,
      ...(optionalBoolean(attachment.sentinel) !== undefined ? { sentinel: optionalBoolean(attachment.sentinel) } : {}),
      ...(optionalString(attachment.reason) !== undefined ? { reason: optionalString(attachment.reason) } : {}),
      ...(optionalNumber(attachment.iterations) !== undefined ? { iterations: optionalNumber(attachment.iterations) } : {}),
      ...(optionalNumber(attachment.durationMs) !== undefined ? { durationMs: optionalNumber(attachment.durationMs) } : {}),
      ...(optionalNumber(attachment.tokens) !== undefined ? { tokens: optionalNumber(attachment.tokens) } : {}),
    },
  };
}

export type ClaudeGoalStatusMapParams = Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  /** When set, only accept events whose source session matches the active Claude session. */
  currentClaudeSessionId?: string | null;
  /** Whether the active runtime supports the `/goal` command (gates editable capabilities). */
  goalCommandSupported?: boolean;
}>;

/**
 * Provider-derived goal capabilities. Only surfaced when a goal_status was actually
 * observed AND `/goal` is supported (fail-closed). Claude exposes edit/set + clear
 * only — it has no pause/resume/budget control (those stay Codex-only via canStop).
 */
function resolveGoalCapabilities(goalCommandSupported: boolean | undefined): SessionWorkStateGoalCapabilitiesV1 | undefined {
  if (!goalCommandSupported) return undefined;
  return { canEdit: true, canClear: true };
}

/**
 * Map one goal_status event to a `SessionWorkStateItemV1` (or null if the event
 * targets a different session). Mirrors remote-dev
 * `mapClaudeGoalStatusEventToWorkStateItem`.
 */
export function mapClaudeGoalStatusEventToWorkStateItem(
  event: ClaudeGoalStatusTranscriptEvent,
  params: ClaudeGoalStatusMapParams,
): SessionWorkStateItemV1 | null {
  const currentClaudeSessionId = nonEmptyString(params.currentClaudeSessionId);
  if (currentClaudeSessionId && event.sourceSessionId !== currentClaudeSessionId) {
    return null;
  }

  const base = {
    id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
    kind: 'goal',
    origin: 'vendor',
    title: event.attachment.condition,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    vendorRef: event.sourceRevision,
    updatedAt: params.updatedAt,
  } as const;

  if (event.attachment.met) {
    const completedAt = timestampToMs(event.timestamp) ?? params.updatedAt;
    const tokensUsed = optionalNumber(event.attachment.tokens);
    const durationMs = optionalNumber(event.attachment.durationMs);
    return {
      ...base,
      status: event.attachment.sentinel ? 'cancelled' : 'complete',
      completedAt,
      ...(typeof tokensUsed === 'number' && tokensUsed >= 0 ? { tokensUsed: Math.trunc(tokensUsed) } : {}),
      ...(typeof durationMs === 'number' && durationMs >= 0 ? { timeUsedSeconds: durationMs / 1000 } : {}),
    };
  }

  const capabilities = resolveGoalCapabilities(params.goalCommandSupported);
  return {
    ...base,
    status: 'active',
    ...(capabilities ? { goalCapabilities: capabilities } : {}),
  };
}

/**
 * Reduce a stream of goal_status events to the latest applicable work-state item
 * (latest-wins). Mirrors remote-dev `reduceClaudeGoalStatusEventsToWorkStateItem`.
 */
export function reduceClaudeGoalStatusEventsToWorkStateItem(
  events: Iterable<ClaudeGoalStatusTranscriptEvent>,
  params: ClaudeGoalStatusMapParams,
): SessionWorkStateItemV1 | null {
  let latest: SessionWorkStateItemV1 | null = null;
  for (const event of events) {
    const item = mapClaudeGoalStatusEventToWorkStateItem(event, params);
    if (item) latest = item;
  }
  return latest;
}

function buildSnapshot(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
  item: SessionWorkStateItemV1;
}>): SessionWorkStateV1 {
  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    // Self-describing: the published snapshot carries the goal source's owned
    // families so consumers can read them back to drive the merge prune
    // (parity with remote-dev `buildSnapshot`). The merge passes this field
    // through harmlessly when the families are also supplied explicitly.
    ownedSourceFamilies: CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
    items: [params.item],
    // Goal-only sub-snapshot primary; the merge re-resolves the REAL primary
    // canonically over the merged set so a goal publish never steals the badge
    // from an active task/todo (MED-2). The source no longer forces its own item.
    primaryItemId: resolveSessionWorkStatePrimaryItemId([params.item]),
  } as SessionWorkStateV1 & Readonly<{ ownedSourceFamilies: readonly string[] }>;
}

/**
 * An empty goal-owned work-state snapshot: removes the Claude goal item from metadata at the merge
 * chokepoint (the merge replaces the `goal:derived:claude.goal` family with no items). Used by the
 * active-session clear, because Claude's `/goal clear` emits no `goal_status` to drive removal.
 */
export function buildEmptyClaudeGoalWorkStateSnapshot(params: Readonly<{
  backendId: string;
  agentId?: string;
  updatedAt: number;
}>): SessionWorkStateV1 {
  return {
    v: 1,
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    updatedAt: params.updatedAt,
    ownedSourceFamilies: CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
    items: [],
    primaryItemId: null,
  } as SessionWorkStateV1 & Readonly<{ ownedSourceFamilies: readonly string[] }>;
}

export type ClaudeGoalStatusWorkStateTracker = Readonly<{
  /**
   * Apply a parsed goal_status event. Returns a publishable work-state snapshot
   * when the resolved goal changes, otherwise null (duplicate uuid, foreign
   * session, or unchanged state). Allocation-light + O(1) per event.
   */
  applyAttachment(
    event: ClaudeGoalStatusTranscriptEvent,
    opts: Readonly<{ updatedAt: number; currentClaudeSessionId?: string | null }>,
  ): SessionWorkStateV1 | null;
  /**
   * Update whether the runtime supports the `/goal` command (derived FACTUALLY
   * from the Claude system-init `slash_commands`, fail-closed until observed).
   * When the flip changes the editable capability of the current active goal,
   * returns a republish snapshot so the UI capability gate reflects the truth;
   * otherwise null.
   */
  setGoalCommandSupported(
    supported: boolean,
    opts: Readonly<{ updatedAt: number; currentClaudeSessionId?: string | null }>,
  ): SessionWorkStateV1 | null;
  /**
   * G-3/E: fold live per-turn usage into the ACTIVE goal item. Called on TURN BOUNDARIES only (never
   * per streaming delta) so metadata write cadence tracks the record cadence, not token deltas.
   * `addTokens` is added to a running accumulated total; `timeUsedSeconds` is the ABSOLUTE elapsed
   * wall-time since the goal was set (latest-wins, monotonic-ish). Returns a republish snapshot of the
   * active goal carrying the accumulated `tokensUsed` + `timeUsedSeconds`, or null when: there is no
   * active goal (never observed, or terminal), the event targets a foreign session, or neither value
   * changed since the last fold (no-churn). Provider totals from a `met:true` `goal_status` WIN — a
   * terminal `applyAttachment` overwrites these accumulated estimates and resets the accumulator.
   */
  foldActiveGoalUsage(
    opts: Readonly<{
      updatedAt: number;
      currentClaudeSessionId?: string | null;
      addTokens: number;
      timeUsedSeconds: number;
    }>,
  ): SessionWorkStateV1 | null;
  /**
   * G-3/E: reseed the usage accumulator from an already-published active goal item (restart
   * continuity). On a fresh tracker after a CLI restart, the last published active goal already
   * carries `tokensUsed`/`timeUsedSeconds`; seeding the accumulator with them means the next
   * `foldActiveGoalUsage` continues the running total instead of restarting from zero.
   */
  reseedActiveGoalUsage(seed: Readonly<{ tokensUsed?: number; timeUsedSeconds?: number }>): void;
  /**
   * Record a user-driven goal control intent (G2/D3). A `clear` bumps the goal-control epoch and arms
   * stale-replay suppression against the cleared baseline (so the provider's continued ACTIVE
   * re-evaluation of the un-meetable cleared goal does not resurrect the badge); a `set` bumps the
   * epoch and lifts any clear suppression so re-setting the SAME objective is accepted. Either intent
   * clears the latest item signature + retained latest event so a subsequent `goal_status`
   * re-publishes even when its content matches the goal that was just cleared/changed. Does not forget
   * seen uuids (a re-scan of the SAME event must still not resurrect it).
   */
  recordGoalControlIntent(intent: Readonly<{ kind: 'set' | 'clear' }>): void;
}>;

/**
 * Stateful, latest-wins goal source for the shared file-follow row callback. Dedupes by event
 * uuid so re-scanned transcript history does not re-publish, and only emits a
 * snapshot when the resolved goal item actually changes.
 */
export function createClaudeGoalStatusWorkStateTracker(params: Readonly<{
  backendId: string;
  agentId?: string;
  goalCommandSupported?: boolean;
}>): ClaudeGoalStatusWorkStateTracker {
  const seenUuids = new Set<string>();
  let latestItemSignature: string | null = null;
  // Fail-closed `/goal` capability; set factually from the runtime `slash_commands`
  // (see setGoalCommandSupported, fed from the system-init record).
  let goalCommandSupported = params.goalCommandSupported ?? false;
  let latestEvent: ClaudeGoalStatusTranscriptEvent | null = null;
  let latestCurrentClaudeSessionId: string | null | undefined;
  // G-3/E live-usage accumulator for the ACTIVE goal. `accumulatedTokens` is a running total folded
  // across turn boundaries; `accumulatedTimeUsedSeconds` is the latest absolute elapsed wall-time.
  // Reset whenever a new active goal is set or the goal terminates (provider totals then win), so a
  // resumed goal never inherits a previous run's estimate.
  let accumulatedTokens = 0;
  let accumulatedTimeUsedSeconds = 0;
  let hasAccumulatedUsage = false;
  // Restart-continuity FLOORS (G-3/E): seeded from the last-published active goal item after a CLI
  // restart. Unlike the per-run accumulator, the floors SURVIVE the `resetUsageAccumulator()` that
  // fires when the same active goal_status is re-observed during transcript replay — otherwise the
  // replay would wipe the prior run's usage. Cleared only when the goal lifecycle genuinely ends (a
  // terminal goal_status, whose provider totals WIN, or a clear/set control intent).
  let reseedTokensFloor = 0;
  let reseedTimeFloorSeconds = 0;
  // Explicit goal-control epoch state (G2/D3), replacing the old `clearedCondition` tombstone. The
  // epoch — not the objective text — is the operation identity, so re-setting the SAME objective after
  // a clear is allowed while the provider's stale ACTIVE re-evaluation of the cleared goal is still
  // suppressed.
  const controlEpoch = createClaudeGoalControlEpochTracker();

  // Reset the per-run accumulator. Does NOT clear the restart floors (those persist across a replay's
  // re-observation of the same active goal). `clearUsageFloors` ends the goal's usage lifecycle.
  const resetUsageAccumulator = (): void => {
    accumulatedTokens = 0;
    accumulatedTimeUsedSeconds = 0;
    hasAccumulatedUsage = false;
  };
  const clearUsageFloors = (): void => {
    reseedTokensFloor = 0;
    reseedTimeFloorSeconds = 0;
  };

  const effectiveTokens = (): number => reseedTokensFloor + accumulatedTokens;
  const effectiveTimeUsedSeconds = (): number => Math.max(reseedTimeFloorSeconds, accumulatedTimeUsedSeconds);
  const hasEffectiveUsage = (): boolean => hasAccumulatedUsage || reseedTokensFloor > 0 || reseedTimeFloorSeconds > 0;

  // Decorate an ACTIVE goal item with the running usage (floor + accumulator). Terminal items are
  // returned unchanged: the provider's authoritative `met:true` totals (already mapped) WIN.
  const withAccumulatedUsage = (item: SessionWorkStateItemV1): SessionWorkStateItemV1 => {
    if (item.status !== 'active' || !hasEffectiveUsage()) return item;
    const tokens = effectiveTokens();
    const timeUsedSeconds = effectiveTimeUsedSeconds();
    return {
      ...item,
      ...(tokens > 0 ? { tokensUsed: tokens } : {}),
      ...(timeUsedSeconds > 0 ? { timeUsedSeconds } : {}),
    };
  };

  return {
    applyAttachment(event, opts) {
      if (seenUuids.has(event.uuid)) return null;
      seenUuids.add(event.uuid);

      // Suppress a stale post-clear replay (the provider keeps re-evaluating an already-cleared,
      // un-meetable goal as ACTIVE, which would otherwise resurrect the badge the user cleared). A SET
      // intent or a genuinely different objective lifts the suppression (see goalControlState).
      if (controlEpoch.resolveReplay({
        met: event.attachment.met,
        uuid: event.uuid,
        sourceRevision: event.sourceRevision,
        condition: event.attachment.condition,
      }) === 'suppress') {
        return null;
      }

      latestEvent = event;
      latestCurrentClaudeSessionId = opts.currentClaudeSessionId;

      const item = mapClaudeGoalStatusEventToWorkStateItem(event, {
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: opts.updatedAt,
        currentClaudeSessionId: opts.currentClaudeSessionId,
        goalCommandSupported,
      });
      if (!item) return null;

      // Identity excludes updatedAt so a redundant re-derivation of the same goal
      // state does not churn metadata writes.
      // (A new goal state supersedes any live-usage accumulation: a terminal goal_status carries the
      // provider's authoritative totals — which WIN, already mapped onto the item — and a genuinely
      // new/changed active goal starts its own run. resetUsageAccumulator() below runs after the
      // no-change early return so unchanged re-derivations do not drop an in-progress accumulator.)
      const signature = `${item.status} ${item.title} ${item.vendorRef ?? ''}`;
      if (signature === latestItemSignature) return null;
      latestItemSignature = signature;
      // The per-run accumulator restarts on any goal-state change. A terminal goal_status ends the
      // usage lifecycle entirely (provider totals WIN), so its floors clear too; an active (re-)publish
      // keeps the restart floors so the item carries the prior run's usage immediately.
      resetUsageAccumulator();
      if (item.status !== 'active') clearUsageFloors();

      return buildSnapshot({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: opts.updatedAt,
        item: withAccumulatedUsage(item),
      });
    },
    setGoalCommandSupported(supported, opts) {
      if (supported === goalCommandSupported) return null;
      goalCommandSupported = supported;
      if (!latestEvent) return null;
      // Re-derive the latest goal with the corrected capability gate so the UI
      // edit/clear affordances reflect the runtime truth even when the
      // `slash_commands` capability is observed after the goal_status event.
      const item = mapClaudeGoalStatusEventToWorkStateItem(latestEvent, {
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: opts.updatedAt,
        currentClaudeSessionId: opts.currentClaudeSessionId ?? latestCurrentClaudeSessionId ?? null,
        goalCommandSupported,
      });
      if (!item) return null;
      const caps = item.goalCapabilities;
      const capsSig = caps ? `${caps.canEdit ? 1 : 0}${caps.canStop ? 1 : 0}${caps.canClear ? 1 : 0}` : '-';
      const signature = `${item.status} ${item.title} ${item.vendorRef ?? ''} ${capsSig}`;
      if (signature === latestItemSignature) return null;
      latestItemSignature = signature;
      return buildSnapshot({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: opts.updatedAt,
        item: withAccumulatedUsage(item),
      });
    },
    foldActiveGoalUsage(opts) {
      if (!latestEvent) return null;
      const item = mapClaudeGoalStatusEventToWorkStateItem(latestEvent, {
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: opts.updatedAt,
        currentClaudeSessionId: opts.currentClaudeSessionId ?? latestCurrentClaudeSessionId ?? null,
        goalCommandSupported,
      });
      // Only an active goal accumulates: a terminal goal's provider totals already WIN, and a
      // foreign-session drop has no goal to fold into.
      if (!item || item.status !== 'active') return null;

      const prevTokens = effectiveTokens();
      const prevTimeUsedSeconds = effectiveTimeUsedSeconds();
      accumulatedTokens += Math.max(0, Math.trunc(opts.addTokens));
      // Elapsed is absolute + monotonic non-decreasing (a later boundary never shows less wall-time).
      accumulatedTimeUsedSeconds = Math.max(accumulatedTimeUsedSeconds, Math.max(0, opts.timeUsedSeconds));
      const nextTokens = effectiveTokens();
      const nextTimeUsedSeconds = effectiveTimeUsedSeconds();
      // No-churn: a boundary that added no tokens and did not advance elapsed re-publishes nothing.
      if (hasEffectiveUsage() && nextTokens === prevTokens && nextTimeUsedSeconds === prevTimeUsedSeconds) {
        return null;
      }
      hasAccumulatedUsage = true;

      return buildSnapshot({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: opts.updatedAt,
        item: withAccumulatedUsage(item),
      });
    },
    reseedActiveGoalUsage(seed) {
      // Seed the FLOORS (not the per-run accumulator): they must survive the replay's re-observation
      // of the same active goal_status (which resets the accumulator) so the prior run's usage is not
      // lost on restart. Live folds then add on top of the floor.
      reseedTokensFloor = typeof seed.tokensUsed === 'number' && seed.tokensUsed >= 0 ? Math.trunc(seed.tokensUsed) : 0;
      reseedTimeFloorSeconds = typeof seed.timeUsedSeconds === 'number' && seed.timeUsedSeconds >= 0 ? seed.timeUsedSeconds : 0;
    },
    recordGoalControlIntent(intent) {
      if (intent.kind === 'clear') {
        // Arm stale-replay suppression against the cleared baseline (uuid/sourceRevision + objective,
        // the latter held privately by the epoch tracker, never as the operation identity).
        const clearIntent: ClaudeGoalControlIntent = {
          kind: 'clear',
          ...(latestEvent ? {
            baselineUuid: latestEvent.uuid,
            baselineSourceRevision: latestEvent.sourceRevision,
            baselineCondition: latestEvent.attachment.condition,
          } : {}),
        };
        controlEpoch.recordIntent(clearIntent);
      } else {
        controlEpoch.recordIntent({ kind: 'set' });
      }
      // Drop the latest signature + retained event so a subsequent goal_status re-publishes even when
      // its content matches the goal that was just cleared/changed by app intent.
      latestItemSignature = null;
      latestEvent = null;
      latestCurrentClaudeSessionId = undefined;
      // A clear/set intent starts a fresh goal lifecycle: prior live-usage accumulation (per-run
      // accumulator AND restart floors) must not carry into the next goal.
      resetUsageAccumulator();
      clearUsageFloors();
    },
  };
}
