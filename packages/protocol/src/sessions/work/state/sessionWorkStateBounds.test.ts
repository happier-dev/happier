import { describe, expect, it } from 'vitest';

import { boundSessionWorkStateItemsV1 } from './sessionWorkStateBounds.js';
import type { SessionWorkStateItemV1 } from './sessionWorkStateV1.js';

function item(id: string): SessionWorkStateItemV1 {
  return {
    id,
    kind: 'todo',
    origin: 'vendor',
    status: 'pending',
    title: id,
    updatedAt: 1,
  };
}

describe('boundSessionWorkStateItemsV1', () => {
  it('returns an explicit truncation marker when item limits omit work-state items', () => {
    const bounded = boundSessionWorkStateItemsV1({
      items: [item('todo:1'), item('todo:2'), item('todo:3')],
      maxItems: 2,
    });

    expect(bounded).toEqual({
      items: [item('todo:1'), item('todo:2')],
      truncated: {
        reason: 'item_limit',
        omittedCount: 1,
      },
    });
  });

  it('does not mark snapshots as truncated when the item list fits the limit', () => {
    const bounded = boundSessionWorkStateItemsV1({
      items: [item('todo:1'), item('todo:2')],
      maxItems: 2,
    });

    expect(bounded).toEqual({
      items: [item('todo:1'), item('todo:2')],
    });
  });
});
