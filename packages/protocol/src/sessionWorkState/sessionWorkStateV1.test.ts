import { describe, expect, it } from 'vitest';

import {
  readDisplayableSessionWorkStateV1,
  readSessionWorkStateV1FromMetadata,
  writeSessionWorkStateV1ToMetadata,
} from './sessionWorkStateV1.js';
import { buildVendorSessionWorkStateItemId } from './sessionWorkStateItemIds.js';

const snapshot = {
  v: 1,
  backendId: 'codex-app-server',
  agentId: 'codex',
  updatedAt: 100,
  primaryItemId: 'goal:vendor-thread',
  items: [
    {
      id: 'goal:vendor-thread',
      kind: 'goal',
      origin: 'vendor',
      status: 'active',
      title: 'Implement work-state substrate',
      backendId: 'codex-app-server',
      agentId: 'codex',
      vendorRef: 'vendor-thread',
      updatedAt: 100,
    },
  ],
  providerExtra: {
    owner: 'codex',
  },
} as const;

describe('SessionWorkStateV1', () => {
  it('reads displayable work state and preserves unknown envelope fields', () => {
    expect(readDisplayableSessionWorkStateV1(snapshot)).toEqual(snapshot);
  });

  it('drops malformed items but rejects snapshots with no displayable known items', () => {
    expect(readDisplayableSessionWorkStateV1({
      ...snapshot,
      items: [
        {
          id: 'future:item',
          kind: 'future-kind',
          origin: 'vendor',
          status: 'active',
          title: 'Future item',
        },
        snapshot.items[0],
      ],
    })?.items).toEqual([snapshot.items[0]]);

    expect(readDisplayableSessionWorkStateV1({
      ...snapshot,
      items: [
        {
          id: 'future:item',
          kind: 'future-kind',
          origin: 'vendor',
          status: 'active',
          title: 'Future item',
        },
      ],
    })).toBeNull();
  });

  it('reads and writes the canonical metadata.sessionWorkStateV1 field', () => {
    expect(readSessionWorkStateV1FromMetadata({ sessionWorkStateV1: snapshot })).toEqual(snapshot);

    expect(writeSessionWorkStateV1ToMetadata({ path: '/tmp/project' }, snapshot)).toEqual({
      path: '/tmp/project',
      sessionWorkStateV1: snapshot,
    });

    expect(writeSessionWorkStateV1ToMetadata({
      path: '/tmp/project',
      sessionWorkStateV1: snapshot,
    }, null)).toEqual({
      path: '/tmp/project',
    });
  });

  it('builds stable vendor item ids without source-specific branching', () => {
    expect(buildVendorSessionWorkStateItemId('goal', 'thread-123')).toBe('goal:thread-123');
  });
});
