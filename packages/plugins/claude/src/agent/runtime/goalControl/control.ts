import {
  mergeSessionWorkStateMetadataV1,
  readDisplayableSessionWorkStateV1,
  resolveSessionWorkStatePrimaryItemId,
  type SessionWorkStateItemV1,
  type SessionWorkStateV1,
  type SessionWorkStateWriteSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import {
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY,
} from '../../transcripts/goalStatus.js';

/**
 * Claude INACTIVE-session goal effector (the `runtimeControl.goal` contribution).
 *
 * For an ACTIVE Claude session the goal router prefers the live RPC, which the
 * unified-terminal native runtime handles by injecting a literal `/goal` user
 * turn; the resulting `goal_status` attachment is the single SOURCE OF TRUTH.
 *
 * This effector only runs when the session is INACTIVE: it seeds/updates the goal
 * item in `metadata.sessionWorkStateV1` using the SAME stable id (`goal:claude`)
 * and source family (`goal:derived:claude.goal`) as the transcript source, so on
 * resume — once a real `goal_status` arrives — it replaces the seed cleanly with
 * no divergence. The host persists the returned `metadata.sessionWorkStateV1`.
 *
 * Ported by intent from remote-dev's `claudeGoalControlAdapter`. Shaped to match
 * the `RuntimeControlContribution.goal` input (`{ runtimeControl, params }`) and
 * the Codex goal-control result (`{ metadata, workState }`).
 */

const CLAUDE_BACKEND_ID = 'claude';
const CLAUDE_AGENT_ID = 'claude';

type MetadataRecord = Record<string, unknown>;

type GoalControlInput<TParams> = Readonly<{
  // The host injects a runtime-control service; the inactive Claude path does not
  // use it (Claude has no app-server goal RPC — live goals inject `/goal`).
  runtimeControl: unknown;
  params: TParams;
}>;

type GoalControlParams = Readonly<{
  metadata: MetadataRecord;
  request?: Readonly<{
    objective?: string;
    status?: string;
    tokenBudget?: number | null;
  }>;
}>;

type ClaudeGoalControlResult =
  | Readonly<{ metadata: MetadataRecord; workState: ReturnType<typeof readDisplayableSessionWorkStateV1> }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

/** Snapshot carrying the goal source's owned families, mirroring the transcript source publish shape. */
type OwnedSessionWorkStateV1 = SessionWorkStateV1 & Readonly<{ ownedSourceFamilies: readonly string[] }>;

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
    ownedSourceFamilies: [CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY],
  });
}

function successWithMetadata(metadata: MetadataRecord): ClaudeGoalControlResult {
  return {
    metadata,
    workState: readDisplayableSessionWorkStateV1(metadata.sessionWorkStateV1),
  };
}

export async function getClaudeGoal(
  input: GoalControlInput<GoalControlParams>,
): Promise<ClaudeGoalControlResult> {
  const metadata = asRecord(input.params.metadata) ?? {};
  return successWithMetadata(metadata);
}

export async function setClaudeGoal(
  input: GoalControlInput<GoalControlParams>,
): Promise<ClaudeGoalControlResult> {
  // G-1/G-2: Claude cannot enforce a token budget or apply a status transition — live goals inject
  // a literal `/goal <objective>` (carrying neither field) and the provider's own `goal_status`
  // attachment is the single source of truth, replacing this seed cleanly on resume. Silently
  // seeding a goal that drops the requested field is a split-brain: reject loudly instead. The UI
  // never sends these for Claude (capability gate); this hardens the contract for non-UI callers.
  if (input.params.request?.tokenBudget !== undefined || input.params.request?.status !== undefined) {
    return stableError('session_goal_control_unsupported');
  }
  const metadata = asRecord(input.params.metadata) ? { ...input.params.metadata } : {};
  const objective = readString(input.params.request?.objective)
    ?? readString(readLatestGoalItem(metadata)?.title);
  if (!objective) {
    return stableError('session_goal_control_objective_required');
  }
  const updatedAt = Date.now();
  const goalItem = buildActiveGoalItem(objective, updatedAt);
  const nextOwned: OwnedSessionWorkStateV1 = {
    v: 1,
    backendId: CLAUDE_BACKEND_ID,
    agentId: CLAUDE_AGENT_ID,
    updatedAt,
    ownedSourceFamilies: [CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY],
    items: [goalItem],
    // Goal-only sub-snapshot primary; the merge re-resolves the REAL primary
    // canonically over the merged set so seeding a goal never steals the badge
    // from an active task/todo (MED-2). setClaudeGoal/clearClaudeGoal are now
    // consistent: both defer the primary decision to the shared merge resolver.
    primaryItemId: resolveSessionWorkStatePrimaryItemId([goalItem]),
  };
  // The merge re-resolves the primary canonically over the merged set, so there
  // is no effector-local primary preservation step.
  return successWithMetadata(mergeGoalSnapshotIntoMetadata(metadata, nextOwned));
}

export async function clearClaudeGoal(
  input: GoalControlInput<GoalControlParams>,
): Promise<ClaudeGoalControlResult> {
  const metadata = asRecord(input.params.metadata) ? { ...input.params.metadata } : {};
  const nextOwned: OwnedSessionWorkStateV1 = {
    v: 1,
    backendId: CLAUDE_BACKEND_ID,
    agentId: CLAUDE_AGENT_ID,
    updatedAt: Date.now(),
    ownedSourceFamilies: [CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILY],
    items: [],
    primaryItemId: null,
  };
  // The merge re-resolves the primary canonically after the goal item is removed
  // (preserving a still-present active task/todo via stability), so there is no
  // effector-local primary preservation step.
  return successWithMetadata(mergeGoalSnapshotIntoMetadata(metadata, nextOwned));
}
