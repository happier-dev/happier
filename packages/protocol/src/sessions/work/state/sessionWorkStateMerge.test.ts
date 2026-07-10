import { describe, expect, it } from 'vitest';

import { mergeSessionWorkStateMetadataV1, mergeSessionWorkStateV1 } from './sessionWorkStateMerge.js';

function readItems(value: unknown): readonly unknown[] {
  if (!value || typeof value !== 'object' || !('items' in value)) {
    return [];
  }
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe('mergeSessionWorkStateMetadataV1', () => {
  it('replaces owned item families while preserving unknown future items and envelope fields', () => {
    const merged = mergeSessionWorkStateMetadataV1({
      metadata: {
        sessionWorkStateV1: {
          v: 1,
          backendId: 'codex-app-server',
          updatedAt: 50,
          futureEnvelopeField: true,
          items: [
            {
              id: 'todo:opencode:old',
              kind: 'todo',
              origin: 'vendor',
              status: 'active',
              title: 'Old OpenCode task',
            },
            {
              id: 'future:item',
              kind: 'future-kind',
              origin: 'vendor',
              status: 'active',
              title: 'Future item',
              futureItemField: 'kept',
            },
          ],
        },
      },
      nextOwned: {
        v: 1,
        backendId: 'codex-app-server',
        updatedAt: 100,
        items: [
          {
            id: 'goal:codex:main',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Current goal',
            updatedAt: 100,
          },
        ],
      },
      ownedItemIdPrefixes: ['todo:opencode:'],
    });

    const workState = merged.sessionWorkStateV1;
    expect(workState).toMatchObject({
      v: 1,
      backendId: 'codex-app-server',
      updatedAt: 100,
      futureEnvelopeField: true,
    });
    expect(readItems(workState)).toEqual([
      {
        id: 'future:item',
        kind: 'future-kind',
        origin: 'vendor',
        status: 'active',
        title: 'Future item',
        futureItemField: 'kept',
      },
      {
        id: 'goal:codex:main',
        kind: 'goal',
        origin: 'vendor',
        status: 'active',
        title: 'Current goal',
        updatedAt: 100,
      },
    ]);
  });

  it('keeps an active task primary when the goal source publishes alongside it (MED-2)', () => {
    // A task/todo source previously made the active task primary.
    const existing = {
      v: 1,
      backendId: 'claude',
      updatedAt: 10,
      primaryItemId: 'task:active',
      items: [
        {
          id: 'task:active',
          kind: 'task',
          origin: 'vendor',
          status: 'active',
          title: 'Active task',
          backendId: 'claude',
          updatedAt: 10,
        },
      ],
    };
    // The goal source publishes its OWN snapshot forcing primaryItemId to the goal.
    const merged = mergeSessionWorkStateV1({
      existing,
      nextOwned: {
        v: 1,
        backendId: 'claude',
        updatedAt: 20,
        primaryItemId: 'goal:claude',
        items: [
          {
            id: 'goal:claude',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Pursue the goal',
            backendId: 'claude',
            updatedAt: 20,
          },
        ],
      },
      ownedSourceFamilies: ['goal:derived:claude.goal'],
    });

    // The badge must NOT flip to the goal: the active task outranks the active goal,
    // deterministically and regardless of which source published last.
    expect(merged.primaryItemId).toBe('task:active');
    expect(merged.items.map((item) => readRecord(item).id)).toEqual(['task:active', 'goal:claude']);
  });

  it('is independent of source publish order (goal-first vs task-first)', () => {
    const goalSnapshot = {
      v: 1,
      backendId: 'claude',
      updatedAt: 5,
      primaryItemId: 'goal:claude',
      items: [{ id: 'goal:claude', kind: 'goal', origin: 'vendor', status: 'active', title: 'Goal', backendId: 'claude', updatedAt: 5 }],
    } as const;
    const taskSnapshot = {
      v: 1,
      backendId: 'claude',
      updatedAt: 6,
      primaryItemId: 'task:active',
      items: [{ id: 'task:active', kind: 'task', origin: 'vendor', status: 'active', title: 'Task', backendId: 'claude', updatedAt: 6 }],
    } as const;

    // goal published first, then task.
    const goalThenTask = mergeSessionWorkStateV1({
      existing: mergeSessionWorkStateV1({ existing: undefined, nextOwned: goalSnapshot, ownedSourceFamilies: ['goal:derived:claude.goal'] }),
      nextOwned: taskSnapshot,
      ownedSourceFamilies: ['task:derived:claude.task'],
    });
    // task published first, then goal.
    const taskThenGoal = mergeSessionWorkStateV1({
      existing: mergeSessionWorkStateV1({ existing: undefined, nextOwned: taskSnapshot, ownedSourceFamilies: ['task:derived:claude.task'] }),
      nextOwned: goalSnapshot,
      ownedSourceFamilies: ['goal:derived:claude.goal'],
    });

    expect(goalThenTask.primaryItemId).toBe('task:active');
    expect(taskThenGoal.primaryItemId).toBe('task:active');
  });
});
