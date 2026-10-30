import { describe, expect, it } from 'vitest';

import { createConnectedServiceContinuationApplicationCorrelation } from './connectedServiceContinuationApplicationCorrelation';

const originKey = {
  sessionId: 'session-origin',
  serviceId: 'openai-codex',
  groupId: 'codex',
  profileId: 'codex3',
  generation: 1224,
} as const;

async function settleValue<T>(
  correlation: ReturnType<typeof createConnectedServiceContinuationApplicationCorrelation<T>>,
  key: Parameters<typeof correlation.settle>[0],
): Promise<T | null> {
  let settled: T | null = null;
  await correlation.settle(key, async (continuation) => {
    settled = continuation;
  });
  return settled;
}

describe('connected-service continuation application correlation', () => {
  it('settles an accepted interrupted origin only for the exact successful application target', async () => {
    const correlation = createConnectedServiceContinuationApplicationCorrelation<string>();

    expect(correlation.register(originKey, 'origin-turn')).toBe(true);
    await expect(settleValue(correlation, { ...originKey, sessionId: 'session-sibling' })).resolves.toBeNull();
    await expect(settleValue(correlation, { ...originKey, serviceId: 'claude-subscription' })).resolves.toBeNull();
    await expect(settleValue(correlation, { ...originKey, groupId: 'other-group' })).resolves.toBeNull();
    await expect(settleValue(correlation, { ...originKey, profileId: 'codex4' })).resolves.toBeNull();
    await expect(settleValue(correlation, { ...originKey, generation: 1225 })).resolves.toBeNull();

    await expect(settleValue(correlation, originKey)).resolves.toBe('origin-turn');
    await expect(settleValue(correlation, originKey)).resolves.toBeNull();
  });

  it('retains the exact origin until Pending acknowledges terminal custody', async () => {
    const correlation = createConnectedServiceContinuationApplicationCorrelation<string>();
    const localIds: string[] = [];

    expect(correlation.register(originKey, 'origin-turn')).toBe(true);
    await expect(correlation.settle(originKey, async (continuation) => {
      localIds.push(`pending:${continuation}`);
      throw new Error('pending_enqueue_no_ack');
    })).rejects.toThrow('pending_enqueue_no_ack');

    await expect(correlation.settle(originKey, async (continuation) => {
      localIds.push(`pending:${continuation}`);
    })).resolves.toBe(true);
    await expect(correlation.settle(originKey, async () => {})).resolves.toBe(false);
    expect(localIds).toEqual(['pending:origin-turn', 'pending:origin-turn']);
    expect(correlation.register(originKey, 'same-generation-after-custody')).toBe(true);
    await expect(settleValue(correlation, originKey)).resolves.toBe('same-generation-after-custody');
  });

  it('carries the latest recovery context without imposing once-per-target admission', async () => {
    const correlation = createConnectedServiceContinuationApplicationCorrelation<string>();

    await expect(settleValue(correlation, originKey)).resolves.toBeNull();
    expect(correlation.register(originKey, 'origin-turn')).toBe(true);
    expect(correlation.register(originKey, 'later-origin')).toBe(true);
    await expect(settleValue(correlation, originKey)).resolves.toBe('later-origin');
    await expect(settleValue(correlation, originKey)).resolves.toBeNull();
    expect(correlation.register(originKey, 'same-generation-after-consume')).toBe(true);
  });

  it('correlates every independently interrupted origin without letting a stale sibling block an exact origin', async () => {
    const correlation = createConnectedServiceContinuationApplicationCorrelation<string>();
    const winner = { ...originKey, sessionId: 'session-winner', generation: 1225 } as const;
    const joinedOrigin = { ...originKey, sessionId: 'session-joined', generation: 1225 } as const;
    const staleSibling = {
      ...originKey,
      sessionId: 'session-stale',
      profileId: 'codex3',
      generation: 1224,
    } as const;

    expect(correlation.register(winner, 'winner-origin')).toBe(true);
    expect(correlation.register(joinedOrigin, 'joined-origin')).toBe(true);
    expect(correlation.register(staleSibling, 'stale-origin')).toBe(true);

    await expect(settleValue(correlation, { ...staleSibling, profileId: 'codex4', generation: 1225 })).resolves.toBeNull();
    await expect(settleValue(correlation, winner)).resolves.toBe('winner-origin');
    await expect(settleValue(correlation, joinedOrigin)).resolves.toBe('joined-origin');
    await expect(settleValue(correlation, winner)).resolves.toBeNull();
    await expect(settleValue(correlation, joinedOrigin)).resolves.toBeNull();
  });

  it('retires an abandoned older target only within the same session, service, and group', async () => {
    const correlation = createConnectedServiceContinuationApplicationCorrelation<string>();
    const newerKey = {
      ...originKey,
      profileId: 'codex4',
      generation: 1225,
    } as const;
    const siblingSessionKey = { ...originKey, sessionId: 'session-sibling' } as const;
    const otherServiceKey = { ...originKey, serviceId: 'claude-subscription' } as const;
    const otherGroupKey = { ...originKey, groupId: 'other-group' } as const;

    expect(correlation.register(originKey, 'origin-1224')).toBe(true);
    expect(correlation.register(siblingSessionKey, 'sibling-origin')).toBe(true);
    expect(correlation.register(otherServiceKey, 'other-service-origin')).toBe(true);
    expect(correlation.register(otherGroupKey, 'other-group-origin')).toBe(true);
    expect(correlation.register(newerKey, 'origin-1225')).toBe(true);

    await expect(settleValue(correlation, originKey)).resolves.toBeNull();
    await expect(settleValue(correlation, newerKey)).resolves.toBe('origin-1225');
    await expect(settleValue(correlation, siblingSessionKey)).resolves.toBe('sibling-origin');
    await expect(settleValue(correlation, otherServiceKey)).resolves.toBe('other-service-origin');
    await expect(settleValue(correlation, otherGroupKey)).resolves.toBe('other-group-origin');
  });
});
