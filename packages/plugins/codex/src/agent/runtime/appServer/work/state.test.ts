import { describe, expect, it } from 'vitest';

import {
  mergeCodexGoalIntoSessionWorkStateMetadata,
  removeCodexGoalFromSessionWorkStateMetadata,
} from './state';

describe('Codex app-server goal work-state projection', () => {
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

  it('removes owned Codex goal items when the native payload is malformed', () => {
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

    expect(metadata.sessionWorkStateV1.items).toEqual([]);
    expect(metadata.sessionWorkStateV1.primaryItemId).toBeNull();
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
