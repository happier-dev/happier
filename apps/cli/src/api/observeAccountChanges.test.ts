import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowAccountRunActionOwner } from '@happier-dev/protocol/actions';
import { WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows';

// Boundary fixture: Socket.IO delivery and HTTP storage are the two external
// carriers; the connection supervisor, Account observer and Run owner stay real.
const wire = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
  };
  const socket = {
    connected: false,
    io: { timeout() {}, on() {}, off() {} },
    on(event: string, listener: (...args: unknown[]) => void) {
      const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group);
    },
    off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); },
    connect() { socket.connected = true; emit('connect'); },
    disconnect() { socket.connected = false; emit('disconnect', 'client disconnect'); },
    removeAllListeners() { listeners.clear(); },
    offAny() {},
  };
  return { socket, emit, post: vi.fn(), io: vi.fn(() => socket) };
});
vi.mock('socket.io-client', () => ({ io: wire.io }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: wire.post } };
});

import { createWorkflowRunStorageClient, type WorkflowRunStorageOperation } from '@/daemon/workflows/workflowRunStorageClient';
import { observeAccountChanges } from './observeAccountChanges';

describe('Entity-scoped Account observation cost', () => {
  it('wakes only addressed readers and preserves coarse and reconnect recovery', async () => {
    vi.useFakeTimers();
    const scopes = Array.from({ length: 64 }, (_, index) => index < 32 ? `approval-${index}` : `workflow-run:${index}`);
    const reads = scopes.map(() => vi.fn());
    const coarseRead = vi.fn();
    const onError = vi.fn();
    const observers = scopes.map((entityId, index) => observeAccountChanges({
      token: 'account-token', serverUrl: 'https://exact-home.test', entityId,
    }, { onChange: reads[index]!, onError }));
    observers.push(observeAccountChanges({ token: 'account-token', serverUrl: 'https://exact-home.test' },
      { onChange: coarseRead, onError }));
    const emitChange = (body: unknown) => wire.emit('update', { id: 'wake', seq: 1, createdAt: 1, body });
    const readCount = () => reads.reduce((sum, read) => sum + read.mock.calls.length, 0);
    const clearReads = () => { for (const read of reads) read.mockClear(); coarseRead.mockClear(); };
    try {
      await vi.advanceTimersByTimeAsync(0);
      clearReads();
      for (let index = 0; index < 100; index++) {
        emitChange({ t: 'account-change', changeKinds: ['machine'], entityIds: [`machine-${index}`] });
      }
      expect(readCount()).toBe(0);
      expect(coarseRead).toHaveBeenCalledTimes(100);
      for (const index of [0, 32]) {
        emitChange({ t: 'account-change', changeKinds: [index === 0 ? 'artifact' : 'account'], entityIds: [scopes[index]] });
      }
      expect(readCount()).toBe(2);
      expect(reads[0]).toHaveBeenCalledTimes(1);
      expect(reads[32]).toHaveBeenCalledTimes(1);
      clearReads();
      emitChange({ t: 'update-artifact', artifactId: 'other' });
      emitChange({ t: 'delete-artifact', artifactId: 'other' });
      expect(readCount()).toBe(0);
      emitChange({ t: 'update-artifact', artifactId: scopes[0] });
      emitChange({ t: 'delete-artifact', artifactId: scopes[1] });
      expect(readCount()).toBe(2);
      expect(reads[0]).toHaveBeenCalledTimes(1);
      expect(reads[1]).toHaveBeenCalledTimes(1);
      for (const body of [
        { t: 'account-change' },
        { t: 'account-change', entityIds: ['other'] },
        { t: 'account-change', changeKinds: ['artifact'] },
        { t: 'account-change', changeKinds: ['future-kind'], entityIds: ['other'] },
      ]) {
        clearReads();
        emitChange(body);
        expect(readCount()).toBe(scopes.length);
        expect(coarseRead).toHaveBeenCalledTimes(1);
      }
      clearReads();
      wire.emit('connect');
      expect(readCount()).toBe(scopes.length);
      expect(coarseRead).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await Promise.all(observers.map(observer => observer.dispose()));
      vi.useRealTimers();
    }
  });
});

describe('Account-fed Workflow wait through the existing CLI transport', () => {
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
  it.each(['update', 'reconnect'] as const)('observes %s with no periodic reads or Machine relay', async (source) => {
    vi.useFakeTimers();
    const runId = '11111111-1111-4111-8111-111111111111';
    const run = WorkflowRunSummaryV1Schema.parse({
      attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
      id: runId, ownerAccountId: 'account-a', sourceArtifactId: null, visibleTeamId: null,
      origin: { kind: 'direct' }, state: 'running', revision: 1, machineId: 'offline-machine',
      workflowCustodyState: 'pending', originDeliveryAckRevision: null,
      availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    let paused = false;
    const operations: string[] = [];
    wire.post.mockImplementation(async (_url: string, body: Readonly<{ operation: string }>) => {
      operations.push(body.operation);
      return { status: 200, data: { observation: paused ? 'paused' : 'waiting', ...(paused ? { matchedCondition: 'paused' } : {}),
        run: { ...run, state: paused ? 'paused' : 'running', attentionRequired: false } } };
    });
    const storage = createWorkflowRunStorageClient({ token: 'account-token', serverHttpBaseUrl: 'https://exact-home.test' });
    const owner = createWorkflowAccountRunActionOwner({
      storage: {
        ...storage,
        // The same opaque storage adapter used by createCliActionDeps.
        execute: (operation, options) => storage.execute(operation as WorkflowRunStorageOperation, options),
      },
      definitions: { get: async () => { throw new Error('wait_does_not_read_definitions'); } },
      resolveEncryption: async () => { throw new Error('structural_wait_does_not_need_keys'); },
      resolveAccountId: async () => 'account-a', normalizeAbsolutePath: () => null, randomBytes: (length) => new Uint8Array(length),
    });
    const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {} });
    await vi.advanceTimersByTimeAsync(0);
    const initialReads = operations.length;
    expect(initialReads).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(operations).toHaveLength(initialReads);
    paused = true;
    if (source === 'update') wire.emit('update', { id: 'wake', seq: 1, createdAt: 1, body: { t: 'account-change' } });
    else wire.emit('connect'); // The decision was missed offline; reconnect fetches current facts.
    await expect(pending).resolves.toMatchObject({ observation: 'paused', run: { machineId: 'offline-machine' } });
    expect(operations.every((operation) => operation === 'wait')).toBe(true);
    expect(wire.socket.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(wire.io).toHaveBeenCalledWith('https://exact-home.test', expect.objectContaining({
      auth: expect.objectContaining({ clientType: 'user-scoped', token: 'account-token' }),
    }));
  });

  it('streams terminal catch-up over the Account socket until this observer is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const runId = '11111111-1111-4111-8111-111111111111';
      let run = WorkflowRunSummaryV1Schema.parse({
        failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        id: runId, ownerAccountId: 'account-a', sourceArtifactId: null, visibleTeamId: null,
        origin: { kind: 'direct' }, state: 'running', revision: 1, machineId: 'offline-machine',
        attentionRequired: false, workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      });
      wire.post.mockImplementation(async () => ({ status: 200, data: {
        observation: run.state === 'succeeded' ? 'terminal' : 'waiting',
        ...(run.state === 'succeeded' ? { matchedCondition: 'terminal' } : {}), run,
      } }));
      const storage = createWorkflowRunStorageClient({ token: 'account-token', serverHttpBaseUrl: 'https://exact-home.test' });
      const owner = createWorkflowAccountRunActionOwner({
        storage: { ...storage, execute: (operation, options) => storage.execute(operation as WorkflowRunStorageOperation, options) },
        definitions: { get: async () => { throw new Error('watch_does_not_read_definitions'); } },
        resolveEncryption: async () => { throw new Error('summary_watch_does_not_need_keys'); },
        resolveAccountId: async () => 'account-a', normalizeAbsolutePath: () => null,
        randomBytes: (length) => new Uint8Array(length),
      });
      const snapshots: unknown[] = [];
      const pending = owner.execute({ actionId: 'workflow.run.wait', input: { runId }, context: {
        signal: controller.signal, onWaitSnapshot: snapshot => { snapshots.push(snapshot); },
      } });
      const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toEqual([{ run }]);
      const initialReads = wire.post.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(wire.post.mock.calls).toHaveLength(initialReads);
      run = { ...run, state: 'succeeded', revision: 2 };
      wire.emit('connect'); // Re-read terminal facts missed while disconnected.
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshots).toEqual([expect.objectContaining({ run: expect.objectContaining({ state: 'running' }) }), { run }]);
      expect(wire.socket.connected).toBe(true);
      controller.abort();
      await cancelled;
      expect(wire.socket.connected).toBe(false);
      const finalReads = wire.post.mock.calls.length;
      wire.emit('update', { id: 'late', seq: 2, createdAt: 2, body: { t: 'account-change' } });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(wire.post.mock.calls).toHaveLength(finalReads);
      expect(wire.post.mock.calls.every(([, body]) => body.operation === 'wait')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); }
  });
});
