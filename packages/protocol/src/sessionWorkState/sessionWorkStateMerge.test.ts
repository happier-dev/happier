import { describe, expect, it } from 'vitest';

import { mergeSessionWorkStateMetadataV1 } from './sessionWorkStateMerge.js';

function readItems(value: unknown): readonly unknown[] {
  if (!value || typeof value !== 'object' || !('items' in value)) {
    return [];
  }
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
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
});
