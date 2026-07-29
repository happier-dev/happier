import { describe, expect, it } from 'vitest';

import {
  mergeCodexGoalIntoSessionWorkStateMetadata,
  removeCodexGoalFromSessionWorkStateMetadata,
} from './state';
import { normalizeCodexGoalWritableStatus } from './goalCodec';

describe('Codex app-server goal work-state projection', () => {
  it('keeps the writable native status set deliberately narrower than the readable set', () => {
    expect(['active', 'paused', 'complete'].map((status) => (
      normalizeCodexGoalWritableStatus(status as 'active' | 'paused' | 'complete')
    ))).toEqual(['active', 'paused', 'complete']);
    expect(normalizeCodexGoalWritableStatus('blocked')).toBeNull();
  });

  it.each([
    ['active', 'active', undefined],
    ['paused', 'paused', undefined],
    ['complete', 'complete', undefined],
    ['blocked', 'blocked', 'blocked'],
    ['usageLimited', 'blocked', 'usageLimited'],
    ['budgetLimited', 'blocked', 'budgetLimited'],
  ] as const)('projects readable native status %s without losing its reason', (nativeStatus, status, statusReason) => {
    const metadata = mergeCodexGoalIntoSessionWorkStateMetadata({}, {
      threadId: 'thread-status',
      objective: 'Keep the native meaning',
      status: nativeStatus,
      createdAt: 1_776_272_400,
      updatedAt: 1_776_272_460,
    });

    expect(metadata.sessionWorkStateV1.items[0]).toMatchObject({
      status,
      ...(statusReason ? { statusReason } : {}),
      createdAt: 1_776_272_400_000,
      updatedAt: 1_776_272_460_000,
    });
  });

  it('projects native Codex goals into canonical session work-state goal items', () => {
    const metadata = mergeCodexGoalIntoSessionWorkStateMetadata({}, {
      threadId: 'thread-1',
      objective: 'Ship plugin support',
      status: 'budgetLimited',
      tokenBudget: 1000,
      tokensUsed: 25,
      timeUsedSeconds: 3,
      createdAt: '2026-05-13T10:00:00.000Z',
      updatedAt: '2026-05-13T10:05:00.000Z',
    });

    expect(metadata.sessionWorkStateV1).toMatchObject({
      v: 1,
      backendId: 'codex',
      updatedAt: Date.parse('2026-05-13T10:05:00.000Z'),
      primaryItemId: 'goal:thread-1',
      items: [{
        id: 'goal:thread-1',
        kind: 'goal',
        origin: 'vendor',
        status: 'blocked',
        statusReason: 'budgetLimited',
        title: 'Ship plugin support',
        backendId: 'codex',
        vendorRef: 'thread-1',
        tokenBudget: 1000,
        tokensUsed: 25,
        timeUsedSeconds: 3,
        createdAt: Date.parse('2026-05-13T10:00:00.000Z'),
        updatedAt: Date.parse('2026-05-13T10:05:00.000Z'),
      }],
    });
  });

  it('leaves the last valid goal intact when a native update payload is malformed', () => {
    const metadataWithGoal = mergeCodexGoalIntoSessionWorkStateMetadata({}, {
      threadId: 'thread-1',
      objective: 'Ship plugin support',
      status: 'active',
      updatedAt: '2026-05-13T10:05:00.000Z',
    });

    const metadata = mergeCodexGoalIntoSessionWorkStateMetadata(metadataWithGoal, {
      threadId: 'thread-1',
      objective: '',
      status: 'active',
      updatedAt: '2026-05-13T10:10:00.000Z',
    });

    expect(metadata.sessionWorkStateV1.items).toEqual(metadataWithGoal.sessionWorkStateV1.items);
    expect(metadata.sessionWorkStateV1.primaryItemId).toBe('goal:thread-1');
  });

  it.each([
    ['invalid ISO timestamp', 'not-a-date'],
    ['fractional numeric timestamp', 1_715_594_400.5],
    ['out-of-range numeric timestamp', 8_640_000_000_001],
  ])('rejects a present but %s createdAt timestamp from the predecessor wire contract', (_label, createdAt) => {
    const metadataWithGoal = mergeCodexGoalIntoSessionWorkStateMetadata({}, {
      threadId: 'thread-1',
      objective: 'Keep the valid goal',
      status: 'active',
      updatedAt: 1_715_594_700,
    });

    const metadata = mergeCodexGoalIntoSessionWorkStateMetadata(metadataWithGoal, {
      threadId: 'thread-1',
      objective: 'Reject malformed creation time',
      status: 'paused',
      createdAt,
      updatedAt: 1_715_594_701,
    });

    expect(metadata.sessionWorkStateV1.items).toEqual(metadataWithGoal.sessionWorkStateV1.items);
  });

  it('arbitrates updates and clear tombstones monotonically so stale data cannot resurrect a goal', () => {
    const newest = mergeCodexGoalIntoSessionWorkStateMetadata({}, {
      threadId: 'thread-1',
      objective: 'Newest goal',
      status: 'active',
      updatedAt: 1_776_272_460,
    });
    const afterStaleUpdate = mergeCodexGoalIntoSessionWorkStateMetadata(newest, {
      threadId: 'thread-1',
      objective: 'Stale goal',
      status: 'paused',
      updatedAt: 1_776_272_400,
    });
    const cleared = removeCodexGoalFromSessionWorkStateMetadata(afterStaleUpdate, {
      threadId: 'thread-1',
    });
    const afterLateEqualUpdate = mergeCodexGoalIntoSessionWorkStateMetadata(cleared, {
      threadId: 'thread-1',
      objective: 'Late equal update',
      status: 'active',
      updatedAt: 1_776_272_460,
    });
    const afterNewerUpdate = mergeCodexGoalIntoSessionWorkStateMetadata(afterLateEqualUpdate, {
      threadId: 'thread-1',
      objective: 'Legitimately recreated goal',
      status: 'active',
      updatedAt: 1_776_272_461,
    });

    expect(afterStaleUpdate.sessionWorkStateV1.items[0]).toMatchObject({ title: 'Newest goal' });
    expect(cleared.sessionWorkStateV1.items).toEqual([]);
    expect(afterLateEqualUpdate.sessionWorkStateV1.items).toEqual([]);
    expect(afterNewerUpdate.sessionWorkStateV1.items[0]).toMatchObject({
      title: 'Legitimately recreated goal',
      updatedAt: 1_776_272_461_000,
    });
  });

  it('removes legacy Codex goal item ids without touching unrelated work-state items', () => {
    const metadata = removeCodexGoalFromSessionWorkStateMetadata({
      sessionWorkStateV1: {
        v: 1,
        backendId: 'codex',
        updatedAt: 123,
        primaryItemId: 'task:keep',
        items: [
          {
            id: 'goal:codex:thread',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Legacy goal',
            backendId: 'codex',
            vendorRef: 'thread',
            updatedAt: 123,
          },
          {
            id: 'task:keep',
            kind: 'task',
            origin: 'agent',
            status: 'active',
            title: 'Keep task',
            updatedAt: 124,
          },
        ],
      },
    });

    expect(metadata.sessionWorkStateV1.items).toEqual([{
      id: 'task:keep',
      kind: 'task',
      origin: 'agent',
      status: 'active',
      title: 'Keep task',
      updatedAt: 124,
    }]);
    expect(metadata.sessionWorkStateV1.primaryItemId).toBe('task:keep');
  });
});
