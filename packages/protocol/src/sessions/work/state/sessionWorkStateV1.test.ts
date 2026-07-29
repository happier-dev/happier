import { describe, expect, it } from 'vitest';

import {
  SessionWorkStateGoalCapabilitiesV1Schema,
  SessionWorkStateStatusReasonV1Schema,
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
  it('accepts every frozen provider-neutral blocked status reason', () => {
    expect(['blocked', 'usageLimited', 'budgetLimited', 'interrupted'].map((reason) => (
      SessionWorkStateStatusReasonV1Schema.parse(reason)
    ))).toEqual(['blocked', 'usageLimited', 'budgetLimited', 'interrupted']);
  });

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

  it('parses provider-derived goal capabilities (additive, all-optional, passthrough)', () => {
    expect(SessionWorkStateGoalCapabilitiesV1Schema.parse({ canEdit: true, canClear: true })).toEqual({
      canEdit: true,
      canClear: true,
    });
    // Forward-compatible passthrough: unknown capability flags survive.
    expect(SessionWorkStateGoalCapabilitiesV1Schema.parse({ canStop: false, future: 1 })).toEqual({
      canStop: false,
      future: 1,
    });
    expect(SessionWorkStateGoalCapabilitiesV1Schema.parse({})).toEqual({});
  });

  it('preserves goalCapabilities on a goal work-state item through the displayable read', () => {
    const withCapabilities = {
      ...snapshot,
      items: [
        {
          ...snapshot.items[0],
          goalCapabilities: { canEdit: true, canClear: true },
        },
      ],
    };
    expect(readDisplayableSessionWorkStateV1(withCapabilities)?.items[0]?.goalCapabilities).toEqual({
      canEdit: true,
      canClear: true,
    });
  });
});
