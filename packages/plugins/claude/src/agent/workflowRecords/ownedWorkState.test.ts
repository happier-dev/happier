import { describe, expect, it } from 'vitest';

import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import { filterWorkflowOwnedWorkStateItems } from './ownedWorkState.js';

function workState(items: SessionWorkStateV1['items'], primaryItemId?: string | null): SessionWorkStateV1 {
  return {
    v: 1,
    backendId: 'claude',
    updatedAt: 1000,
    items,
    ...(primaryItemId !== undefined ? { primaryItemId } : {}),
  };
}

function taskItem(id: string, vendorRef: string, extra?: Partial<SessionWorkStateV1['items'][number]>) {
  return {
    id,
    kind: 'task' as const,
    origin: 'vendor' as const,
    status: 'active' as const,
    title: `Task ${id}`,
    vendorRef,
    updatedAt: 1000,
    ...extra,
  };
}

describe('filterWorkflowOwnedWorkStateItems', () => {
  it('drops items whose vendorRef is a workflow-owned tool-use id', () => {
    const snapshot = workState([
      taskItem('task:wf_agent', 'wf_agent'),
      taskItem('task:plain', 'plain_subagent'),
    ]);
    const result = filterWorkflowOwnedWorkStateItems(snapshot, new Set(['wf_agent']));
    expect(result.items.map((i) => i.vendorRef)).toEqual(['plain_subagent']);
  });

  it('drops items whose parentId is workflow-owned (sidechain rows)', () => {
    const snapshot = workState([
      taskItem('task:child', 'child', { parentId: 'wf_parent' }),
      taskItem('task:other', 'other'),
    ]);
    const result = filterWorkflowOwnedWorkStateItems(snapshot, new Set(['wf_parent']));
    expect(result.items.map((i) => i.vendorRef)).toEqual(['other']);
  });

  it('keeps the goal and todo rows untouched (only workflow-owned task rows are removed)', () => {
    const goal = { id: 'goal:claude', kind: 'goal' as const, origin: 'vendor' as const, status: 'active' as const, title: 'Ship', updatedAt: 1000 };
    const todo = { id: 'todo:1', kind: 'todo' as const, origin: 'vendor' as const, status: 'pending' as const, title: 'Step', updatedAt: 1000 };
    const snapshot = workState([goal, todo, taskItem('task:wf', 'wf_agent')]);
    const result = filterWorkflowOwnedWorkStateItems(snapshot, new Set(['wf_agent']));
    expect(result.items.map((i) => i.id)).toEqual(['goal:claude', 'todo:1']);
  });

  it('returns the same snapshot when no ids are owned (cheap no-op)', () => {
    const snapshot = workState([taskItem('task:a', 'a')]);
    const result = filterWorkflowOwnedWorkStateItems(snapshot, new Set());
    expect(result).toBe(snapshot);
  });

  it('clears primaryItemId when the primary item was filtered out', () => {
    const snapshot = workState([taskItem('task:wf', 'wf_agent'), taskItem('task:keep', 'keep')], 'task:wf');
    const result = filterWorkflowOwnedWorkStateItems(snapshot, new Set(['wf_agent']));
    expect(result.items.map((i) => i.id)).toEqual(['task:keep']);
    expect(result.primaryItemId).toBeNull();
  });

  it('preserves primaryItemId when it survives the filter', () => {
    const snapshot = workState([taskItem('task:wf', 'wf_agent'), taskItem('task:keep', 'keep')], 'task:keep');
    const result = filterWorkflowOwnedWorkStateItems(snapshot, new Set(['wf_agent']));
    expect(result.primaryItemId).toBe('task:keep');
  });
});
