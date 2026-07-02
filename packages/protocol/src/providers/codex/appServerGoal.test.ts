import { describe, expect, it } from 'vitest';

import { normalizeCodexAppServerGoalToSessionWorkStateItem } from './appServerGoal.js';

describe('normalizeCodexAppServerGoalToSessionWorkStateItem', () => {
  it('projects native Codex goals into canonical work-state goal items', () => {
    expect(normalizeCodexAppServerGoalToSessionWorkStateItem({
      backendId: 'codex',
      goal: {
        threadId: 'thread-1',
        objective: 'Ship plugin support',
        status: 'budgetLimited',
        tokenBudget: 1000,
        tokensUsed: 25,
        timeUsedSeconds: 3,
        createdAt: '2026-05-13T10:00:00.000Z',
        updatedAt: '2026-05-13T10:05:00.000Z',
      },
    })).toEqual({
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
    });
  });

  it('returns null for malformed native goal payloads', () => {
    expect(normalizeCodexAppServerGoalToSessionWorkStateItem({
      backendId: 'codex',
      goal: {
        threadId: 'thread-1',
        objective: '',
        status: 'active',
        updatedAt: '2026-05-13T10:05:00.000Z',
      },
    })).toBeNull();
  });
});
