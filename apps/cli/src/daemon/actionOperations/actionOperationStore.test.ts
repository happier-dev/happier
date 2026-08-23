import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationStore } from './actionOperationStore';

const scopeA = { accountId: 'account-a', machineId: 'machine-a' } as const;
const scopeB = { accountId: 'account-b', machineId: 'machine-a' } as const;

function accepted(operationId: string, createdAt: number, sessionId?: string): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId,
    revision: 1,
    actionId: 'session.spawn_new',
    state: 'accepted',
    scope: { ...scopeA, ...(sessionId ? { sessionId } : {}) },
    title: 'Create session',
    createdAt,
    cancellation: 'unsupported',
  };
}

describe('actionOperationStore', () => {
  it('publishes every monotonic revision and keeps terminal snapshots immutable', () => {
    const onRevision = vi.fn();
    const store = createActionOperationStore({ now: () => 1_000, onRevision });
    store.create(accepted('operation-1', 1_000));

    expect(store.update('operation-1', (snapshot) => ({ ...snapshot, state: 'running', startedAt: 1_010 }))).toMatchObject({
      revision: 2,
      state: 'running',
    });

    expect(store.update('operation-1', (snapshot) => ({ ...snapshot, state: 'succeeded', settledAt: 1_020, result: { ok: true } }))).toMatchObject({
      revision: 3,
      state: 'succeeded',
    });
    expect(store.update('operation-1', (snapshot) => ({ ...snapshot, state: 'failed' }))).toBeNull();
    expect(store.get('operation-1', scopeA)).toMatchObject({ revision: 3, state: 'succeeded' });
    expect(onRevision.mock.calls.map(([snapshot]) => snapshot.revision)).toEqual([1, 2, 3]);
  });

  it('keeps the canonical operation writable when best-effort revision publication throws', () => {
    const store = createActionOperationStore({
      now: () => 1_000,
      onRevision: () => { throw new Error('socket unavailable'); },
    });

    expect(() => store.create(accepted('operation-1', 1_000))).not.toThrow();
    expect(() => store.update('operation-1', (snapshot) => ({
      ...snapshot,
      state: 'running',
      startedAt: 1_010,
    }))).not.toThrow();
    expect(store.get('operation-1', scopeA)).toMatchObject({ revision: 2, state: 'running' });
  });

  it('scopes get and list', () => {
    const store = createActionOperationStore({ now: () => 1_000 });
    store.create(accepted('operation-1', 1_000, 'session-a'));

    expect(store.get('operation-1', scopeB)).toBeNull();
    expect(store.list({ sessionId: 'session-b' }, scopeA)).toEqual({ items: [], nextCursor: null });
    expect(store.list({ sessionId: 'session-a' }, scopeA).items).toHaveLength(1);
  });

  it('retains all active operations and only the newest 50 settled operations within 24 hours', () => {
    let now = 100_000_000;
    const store = createActionOperationStore({ now: () => now });
    store.create(accepted('active', now));

    for (let index = 0; index < 52; index += 1) {
      const operationId = `settled-${index}`;
      store.create(accepted(operationId, now + index));
      store.update(operationId, (snapshot) => ({ ...snapshot, state: 'running', startedAt: now + index }));
      store.update(operationId, (snapshot) => ({ ...snapshot, state: 'succeeded', settledAt: now + index }));
    }

    const listed = store.list({}, scopeA);
    expect(listed.items.filter((item) => item.state === 'succeeded')).toHaveLength(49);
    expect(store.get('active', scopeA)).toMatchObject({ state: 'accepted' });
    expect(store.get('settled-0', scopeA)).toBeNull();

    now += 24 * 60 * 60 * 1_000 + 100;
    store.prune();
    expect(store.list({}, scopeA).items).toEqual([expect.objectContaining({ operationId: 'active' })]);
  });
});
