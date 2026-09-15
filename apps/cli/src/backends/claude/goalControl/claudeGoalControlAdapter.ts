import {
  readDisplayableSessionWorkStateV1,
  resolveSessionWorkStatePrimaryItemId,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
  type SessionWorkStateWriteSnapshotV1,
} from '@happier-dev/protocol';

import type { SessionGoalControlAdapter } from '@/session/goalControls/sessionGoalControlTypes';
import { mergeSessionWorkStateMetadataV1 } from '@/session/workState/sessionWorkStateMetadata';

import {
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
} from '../workState/claudeGoalStatus';

/** Snapshot carrying the goal source's owned families, mirroring the F3 source publish shape. */
type OwnedSessionWorkStateV1 = SessionWorkStateV1 & Readonly<{ ownedSourceFamilies: readonly string[] }>;

/**
 * Claude `SessionGoalControlAdapter` — the INACTIVE-session goal effector.
 *
 * For an active Claude session the router prefers the live RPC, which injects a
 * literal `/goal` user turn (see `runtimeGoalControl` wired in
 * `runClaudeUnifiedTerminalSession`). The `goal_status` attachment that Claude
 * then emits is the single SOURCE OF TRUTH (parsed by `claudeGoalStatus`).
 *
 * This adapter only runs when the session is INACTIVE: it seeds/updates the
 * goal item in `metadata.sessionWorkStateV1` using the SAME stable id
 * (`goal:claude`) and source family (`goal:derived:claude.goal`) as the source,
 * so that on resume — once a real `goal_status` arrives — it replaces the seed
 * cleanly with no divergence. Resume injects `/goal` so Claude actually pursues
 * it (see the initial-goal injection in the unified terminal launcher).
 */

const CLAUDE_BACKEND_ID = 'claude';
const CLAUDE_AGENT_ID = 'claude';

type MetadataRecord = Record<string, unknown>;

type AdapterResult = Readonly<{
  metadata: MetadataRecord;
  workState: ReturnType<typeof readDisplayableSessionWorkStateV1>;
}>;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readWorkStateItems(metadata: MetadataRecord): MetadataRecord[] {
  const workState = asRecord(metadata.sessionWorkStateV1);
  const items = workState?.items;
  return Array.isArray(items)
    ? items.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

/** Latest goal item the metadata work-state carries (single Claude goal, latest-wins). */
function readLatestGoalItem(metadata: MetadataRecord): MetadataRecord | null {
  const goals = readWorkStateItems(metadata).filter((item) => item.kind === 'goal');
  return goals.find((item) => readString(item.id) === CLAUDE_GOAL_WORK_STATE_ITEM_ID)
    ?? goals[goals.length - 1]
    ?? null;
}

function buildActiveGoalItem(objective: string, updatedAt: number): SessionWorkStateItemV1 {
  return {
    id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
    kind: 'goal',
    origin: 'vendor',
    title: objective,
    backendId: CLAUDE_BACKEND_ID,
    agentId: CLAUDE_AGENT_ID,
    status: 'active',
    goalCapabilities: { canEdit: true, canClear: true },
    updatedAt,
  };
}

function mergeGoalSnapshotIntoMetadata(
  metadata: MetadataRecord,
  nextOwned: SessionWorkStateV1,
): MetadataRecord & Readonly<{ sessionWorkStateV1: SessionWorkStateWriteSnapshotV1 }> {
  return mergeSessionWorkStateMetadataV1({
    metadata,
    nextOwned,
    ownedItemIds: [CLAUDE_GOAL_WORK_STATE_ITEM_ID],
    ownedSourceFamilies: CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
  });
}

function successWithMetadata(metadata: MetadataRecord): AdapterResult {
  return {
    metadata,
    workState: readDisplayableSessionWorkStateV1(metadata.sessionWorkStateV1),
  };
}

export const claudeGoalControlAdapter: SessionGoalControlAdapter = {
  getGoal: async (params) => {
    const metadata = asRecord(params.metadata) ?? {};
    return successWithMetadata(metadata);
  },
  setGoal: async (params) => {
    // G-2: Claude cannot apply a status transition on the inactive path
    // either — the seeded goal item is replaced cleanly by the provider's own `goal_status` on
    // resume, and `/goal` (the resume mechanism) carries no status field. Reject loudly (matching the
    // runtime control, G-1) instead of silently seeding a goal that drops the requested field.
    if (params.request.status !== undefined) {
      return stableError('session_goal_control_unsupported');
    }
    const metadata = asRecord(params.metadata) ? { ...params.metadata } : {};
    const requestObjective = readString(params.request.objective);
    const latestGoal = readLatestGoalItem(metadata);
    const objective = requestObjective ?? readString(latestGoal?.title);
    if (!objective) {
      return stableError('session_goal_control_objective_required');
    }
    // Suspected-(b) guard: when no fresh objective is supplied we only fall back to
    // the existing goal's title to preserve it across a status mutation. We must NOT
    // silently resurrect a goal that is already complete/cancelled off its stale
    // title — an explicit objective edit is required to re-activate it (mirrors the
    // Codex adapter's `shouldReactivateForObjectiveEdit` discipline).
    const latestStatus = readString(latestGoal?.status);
    if (!requestObjective && (latestStatus === 'complete' || latestStatus === 'cancelled')) {
      return stableError('session_goal_control_objective_required');
    }
    const updatedAt = Date.now();
    const goalItem = buildActiveGoalItem(objective, updatedAt);
    const nextOwned: OwnedSessionWorkStateV1 = {
      v: 1,
      backendId: CLAUDE_BACKEND_ID,
      agentId: CLAUDE_AGENT_ID,
      updatedAt,
      ownedSourceFamilies: CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
      items: [goalItem],
      // Goal-only sub-snapshot primary; the merge re-resolves the REAL primary
      // canonically over the merged set so seeding a goal never steals the badge
      // from an active task/todo (MED-2). setGoal/clearGoal are now consistent:
      // both defer the primary decision to the shared merge-time resolver.
      primaryItemId: resolveSessionWorkStatePrimaryItemId([goalItem]),
    };
    return successWithMetadata(mergeGoalSnapshotIntoMetadata(metadata, nextOwned));
  },
  clearGoal: async (params) => {
    const metadata = asRecord(params.metadata) ? { ...params.metadata } : {};
    const nextOwned: OwnedSessionWorkStateV1 = {
      v: 1,
      backendId: CLAUDE_BACKEND_ID,
      agentId: CLAUDE_AGENT_ID,
      updatedAt: Date.now(),
      ownedSourceFamilies: CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
      items: [],
      primaryItemId: null,
    };
    // The merge re-resolves the primary canonically after the goal item is
    // removed (preserving a still-present active task/todo via stability), so
    // there is no adapter-local primary preservation step.
    return successWithMetadata(mergeGoalSnapshotIntoMetadata(metadata, nextOwned));
  },
};
