import { describe, expect, it } from 'vitest';

import {
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_SOURCE_FAMILY,
} from '../workState/claudeGoalStatus';
import { claudeGoalControlAdapter } from './claudeGoalControlAdapter';

type AdapterResult = Readonly<{ metadata?: Record<string, unknown>; workState?: unknown }>;

function baseParams(metadata: Record<string, unknown>) {
  return {
    token: 'token',
    sessionId: 'session-1',
    rawSession: { id: 'session-1' } as never,
    metadata,
    currentMachineId: 'machine-1',
    sessionMachineId: 'machine-1',
    cwd: '/repo',
    ctx: {} as never,
    mode: 'plain' as never,
  };
}

function readGoalItems(result: unknown): Array<Record<string, unknown>> {
  const metadata = (result as AdapterResult).metadata;
  const workState = (metadata as { sessionWorkStateV1?: { items?: unknown } } | undefined)?.sessionWorkStateV1;
  const items = workState?.items;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

describe('claudeGoalControlAdapter (inactive path)', () => {
  it('seeds an active goal item with the canonical id/family on setGoal', async () => {
    const result = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams({}),
      request: { objective: 'finish the goal feature' },
    });

    const goals = readGoalItems(result).filter((item) => item.kind === 'goal');
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
      kind: 'goal',
      origin: 'vendor',
      status: 'active',
      backendId: 'claude',
      title: 'finish the goal feature',
    });
  });

  it('keeps the goal under the canonical source family so a real goal_status replaces it cleanly', async () => {
    const result = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams({}),
      request: { objective: 'aligned objective' },
    });
    const workState = (result as AdapterResult).metadata?.sessionWorkStateV1 as
      | { ownedSourceFamilies?: readonly string[]; primaryItemId?: string }
      | undefined;
    expect(workState?.ownedSourceFamilies).toContain(CLAUDE_GOAL_WORK_STATE_SOURCE_FAMILY);
    expect(workState?.primaryItemId).toBe(CLAUDE_GOAL_WORK_STATE_ITEM_ID);
  });

  it('preserves non-goal work-state families when seeding a goal', async () => {
    const metadata = {
      sessionWorkStateV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 10,
        items: [{ id: 'todo:1', kind: 'todo', origin: 'vendor', title: 'a todo', status: 'active', backendId: 'claude' }],
        primaryItemId: 'todo:1',
      },
    };
    const result = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams(metadata),
      request: { objective: 'new goal' },
    });
    const items = readGoalItems(result);
    expect(items.some((item) => item.id === 'todo:1')).toBe(true);
    expect(items.some((item) => item.id === CLAUDE_GOAL_WORK_STATE_ITEM_ID)).toBe(true);
  });

  it('removes the goal item on clearGoal', async () => {
    const seeded = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams({}),
      request: { objective: 'temporary goal' },
    });
    const seededMetadata = (seeded as AdapterResult).metadata ?? {};

    const cleared = await claudeGoalControlAdapter.clearGoal?.(baseParams(seededMetadata));
    const goals = readGoalItems(cleared).filter((item) => item.kind === 'goal');
    expect(goals).toHaveLength(0);
  });

  // G-2: the INACTIVE-session adapter mirrors the runtime control (G-1) — Claude cannot honor a
  // status transition, so instead of silently dropping the field while seeding a goal
  // (the original bug), it rejects with the same typed, non-fallback error.
  it('rejects a setGoal that requests a status transition (unsupported on Claude, inactive path)', async () => {
    const result = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams({}),
      request: { objective: 'ship it', status: 'paused' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
  });

  it('reads the latest goal item via getGoal', async () => {
    const seeded = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams({}),
      request: { objective: 'read me' },
    });
    const seededMetadata = (seeded as AdapterResult).metadata ?? {};

    const got = await claudeGoalControlAdapter.getGoal?.(baseParams(seededMetadata));
    const goals = readGoalItems(got).filter((item) => item.kind === 'goal');
    expect(goals[0]).toMatchObject({ id: CLAUDE_GOAL_WORK_STATE_ITEM_ID, title: 'read me', status: 'active' });
  });

  it('rejects a setGoal with no objective and no existing goal to re-activate', async () => {
    const result = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams({}),
      request: {},
    });
    expect((result as { ok?: boolean }).ok).toBe(false);
  });

  it('does not silently re-activate a completed goal from an absent objective (suspected-(b))', async () => {
    const metadata = {
      sessionWorkStateV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 10,
        primaryItemId: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
        items: [{
          id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
          kind: 'goal',
          origin: 'vendor',
          status: 'complete',
          title: 'Already finished objective',
          backendId: 'claude',
          updatedAt: 10,
        }],
      },
    };
    const result = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams(metadata),
      request: {},
    });
    // The completed goal must NOT be resurrected as active off a stale title.
    expect((result as { ok?: boolean }).ok).toBe(false);
  });

  it('still re-activates a completed goal when an explicit objective edit is provided', async () => {
    const metadata = {
      sessionWorkStateV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 10,
        primaryItemId: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
        items: [{
          id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
          kind: 'goal',
          origin: 'vendor',
          status: 'cancelled',
          title: 'Old objective',
          backendId: 'claude',
          updatedAt: 10,
        }],
      },
    };
    const result = await claudeGoalControlAdapter.setGoal?.({
      ...baseParams(metadata),
      request: { objective: 'Pursue a fresh objective' },
    });
    const goal = readGoalItems(result).find((item) => item.id === CLAUDE_GOAL_WORK_STATE_ITEM_ID);
    expect(goal).toMatchObject({ status: 'active', title: 'Pursue a fresh objective' });
  });
});
