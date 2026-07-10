import { describe, expect, it } from 'vitest';

import { CLAUDE_GOAL_WORK_STATE_ITEM_ID } from '../../transcripts/goalStatus.js';
import { clearClaudeGoal, getClaudeGoal, setClaudeGoal } from './control.js';

function input(
  metadata: Record<string, unknown>,
  request?: Readonly<{ objective?: string; status?: string; tokenBudget?: number | null }>,
) {
  return { runtimeControl: {}, params: { metadata, ...(request ? { request } : {}) } };
}

function readGoalItem(result: unknown): Record<string, unknown> | undefined {
  const metadata = (result as { metadata?: Record<string, unknown> }).metadata;
  const items = (metadata?.sessionWorkStateV1 as { items?: unknown[] } | undefined)?.items;
  return (items ?? []).find((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && (item as { kind?: unknown }).kind === 'goal');
}

describe('claude inactive goal control', () => {
  it('seeds an active goal item with edit/clear capabilities on set', async () => {
    const result = await setClaudeGoal(input({}, { objective: 'Finish the port' }));
    const goal = readGoalItem(result);
    expect(goal).toMatchObject({
      id: CLAUDE_GOAL_WORK_STATE_ITEM_ID,
      kind: 'goal',
      origin: 'vendor',
      status: 'active',
      title: 'Finish the port',
      goalCapabilities: { canEdit: true, canClear: true },
    });
  });

  it('requires an objective when none is supplied and none exists', async () => {
    const result = await setClaudeGoal(input({}));
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_objective_required' });
  });

  it('rejects a token budget with session_goal_control_unsupported (G-2)', async () => {
    const result = await setClaudeGoal(input({}, { objective: 'Budgeted goal', tokenBudget: 100_000 }));
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
  });

  it('rejects a status transition with session_goal_control_unsupported (G-1)', async () => {
    const result = await setClaudeGoal(input({}, { objective: 'Paused goal', status: 'paused' }));
    expect(result).toMatchObject({ ok: false, errorCode: 'session_goal_control_unsupported' });
  });

  it('reuses the existing goal objective when set is called with no objective', async () => {
    const seeded = await setClaudeGoal(input({}, { objective: 'Keep going' }));
    const seededMetadata = (seeded as { metadata: Record<string, unknown> }).metadata;
    const result = await setClaudeGoal(input(seededMetadata));
    expect(readGoalItem(result)?.title).toBe('Keep going');
  });

  it('removes the goal item on clear while preserving other work-state families', async () => {
    const metadata = {
      sessionWorkStateV1: {
        v: 1,
        backendId: 'claude',
        updatedAt: 1,
        primaryItemId: 'todo:claude:keep',
        items: [
          { id: 'todo:claude:keep', kind: 'todo', origin: 'vendor', status: 'active', title: 'A task', updatedAt: 1 },
          { id: CLAUDE_GOAL_WORK_STATE_ITEM_ID, kind: 'goal', origin: 'vendor', status: 'active', title: 'A goal', updatedAt: 1 },
        ],
      },
    };
    const result = await clearClaudeGoal(input(metadata));
    expect(readGoalItem(result)).toBeUndefined();
    const items = ((result as { metadata: Record<string, unknown> }).metadata.sessionWorkStateV1 as { items: unknown[] }).items;
    expect(items).toHaveLength(1);
    expect((items[0] as { id: string }).id).toBe('todo:claude:keep');
  });

  it('get returns the current metadata work-state unchanged', async () => {
    const metadata = { sessionWorkStateV1: { v: 1, backendId: 'claude', updatedAt: 1, items: [] } };
    const result = await getClaudeGoal(input(metadata));
    expect((result as { metadata: Record<string, unknown> }).metadata).toEqual(metadata);
  });
});
