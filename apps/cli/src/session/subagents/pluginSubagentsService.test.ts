import { describe, expect, it, vi } from 'vitest';

import { createHostSubagentStore } from './hostSubagentStore';
import { createPluginSubagentsService } from './pluginSubagentsService';
import type { PluginSubagentDurableCustody, PluginSubagentDurableSummary } from './pluginSubagentsService';
import { PluginError } from '@happier-dev/plugin-sdk';

const identity = {
  pluginId: 'acme.agent', contributionId: 'assistant', immutableGenerationId: 'gen-1', parentSessionId: 'session-1',
} as const;

function createDurableCustody(): PluginSubagentDurableCustody {
  const records = new Map<string, PluginSubagentDurableSummary>();
  const operations = new Map<string, { fingerprint: string; summary: PluginSubagentDurableSummary }>();
  return {
    availability: () => ({ status: 'available' }),
    normalizeGroupId: (groupId) => groupId,
    async list(options) {
      return [...records.entries()]
        .filter(([key]) => key.startsWith(`${options.scope}\u0000`))
        .map(([, summary]) => summary);
    },
    async mutate(input) {
      const key = JSON.stringify([input.scope, input.operationId]);
      const fingerprint = JSON.stringify(input, (name, value) => name === 'signal' ? undefined : value);
      const operation = operations.get(key);
      if (operation) {
        if (operation.fingerprint !== fingerprint) throw new PluginError({ code: 'plugin_subagent_operation_conflict', message: 'conflict' });
        return operation.summary;
      }
      if ([...operations.keys()].filter((candidate) => JSON.parse(candidate)[0] === input.scope).length >= 4_096) {
        throw new PluginError({ code: 'plugin_subagent_idempotency_capacity_exceeded', message: 'capacity' });
      }
      const recordKey = `${input.scope}\u0000${input.subagentId}`;
      const existing = records.get(recordKey);
      if (existing && ['completed', 'failed', 'aborted'].includes(existing.status) && existing.status !== input.status) {
        throw new PluginError({ code: 'plugin_subagent_terminal_regression', message: 'terminal' });
      }
      const summary: PluginSubagentDurableSummary = Object.freeze({
        id: input.subagentId,
        parentSessionId: identity.parentSessionId,
        ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
        status: input.status,
        revision: String(Number(existing?.revision ?? 0) + 1),
        updatedAtMs: Date.now(),
      });
      records.set(recordKey, summary);
      operations.set(key, { fingerprint, summary });
      return summary;
    },
    async retire() {},
  };
}

describe('createPluginSubagentsService', () => {
  it('fails observation capability closed when the host has no durable custody owner', async () => {
    const store = createHostSubagentStore();
    const service = createPluginSubagentsService({ store, identity, isCurrent: () => true });
    expect(service.capabilities().observe).toEqual({ status: 'unavailable', code: 'plugin_subagent_durable_custody_unavailable' });
    await expect(service.observe({ observationId: 'child', status: 'running' }))
      .rejects.toMatchObject({ code: 'plugin_subagent_durable_custody_unavailable' });
    expect(await store.list()).toEqual([]);
  });

  it('accepts provider observations while keeping custody correlation and revisions host-owned', async () => {
    const store = createHostSubagentStore();
    const custody = createDurableCustody();
    const mutate = vi.spyOn(custody, 'mutate');
    const service = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody: custody });
    const listener = vi.fn();
    const subscription = service.watch({}, listener);
    const input = { observationId: 'provider-task-1', groupId: 'workers', status: 'running' as const };
    const first = await service.observe(input);
    const replay = await service.observe(input);
    const recreated = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody: custody });
    const reconnectReplay = await recreated.observe(input);
    await Promise.resolve();

    expect(replay).toMatchObject({ id: first.id, status: first.status });
    expect(reconnectReplay).toEqual(first);
    expect(first).not.toHaveProperty('revision');
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expect.not.stringContaining(input.observationId),
    }));
    expect(new Set(mutate.mock.calls.slice(0, 3).map(([call]) => call.operationId))).toHaveProperty('size', 1);
    expect(mutate.mock.calls[0]?.[0]).not.toHaveProperty('expectedRevision');
    expect((await service.list()).items).toEqual([first]);
    expect(await service.get(first.id)).toEqual(first);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'snapshot' }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'upserted', item: first }));
    expect(service.capabilities()).toEqual({
      list: { status: 'available' }, observe: { status: 'available' }, watch: { status: 'available' },
    });
    subscription.dispose();
  });

  it('qualifies observations by owner, rejects terminal regression, and rejects legacy ledger inputs', async () => {
    const store = createHostSubagentStore();
    const custody = createDurableCustody();
    const firstService = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody: custody });
    const first = await firstService.observe({ observationId: 'child', status: 'completed' });
    const secondService = createPluginSubagentsService({
      store,
      identity: { ...identity, pluginId: 'other.plugin' },
      isCurrent: () => true,
      durableCustody: custody,
    });

    await expect(firstService.observe({ observationId: 'child', status: 'running' }))
      .rejects.toMatchObject({ code: 'plugin_subagent_terminal_regression' });
    await expect(firstService.observe({
      observationId: 'legacy',
      status: 'running',
      operationId: 'author-receipt',
      expectedRevision: '1',
      parentSessionId: 'session-2',
    } as never)).rejects.toMatchObject({ code: 'plugin_subagent_input_invalid' });
    const other = await secondService.observe({ observationId: 'child', status: 'failed' });
    expect(other.id).not.toBe(first.id);
    expect(await firstService.get(first.id)).toEqual(first);
    expect(await firstService.get(other.id)).toBeNull();
    expect((await firstService.list()).items).toEqual([first]);
  });

  it('fails closed for retired generations before touching the store', async () => {
    const store = createHostSubagentStore();
    const service = createPluginSubagentsService({ store, identity, isCurrent: () => false, durableCustody: createDurableCustody() });
    expect(service.capabilities().observe).toEqual({ status: 'unavailable', code: 'plugin_generation_retired' });
    await expect(service.observe({ observationId: 'child', status: 'running' }))
      .rejects.toMatchObject({ code: 'plugin_generation_retired' });
    expect(await store.list()).toEqual([]);
  });

  it('rechecks generation currency at serialized write dispatch', async () => {
    const store = createHostSubagentStore();
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const service = createPluginSubagentsService({ store, identity, isCurrent, durableCustody: createDurableCustody() });
    await expect(service.observe({ observationId: 'child', status: 'running' }))
      .rejects.toMatchObject({ code: 'plugin_generation_retired' });
    expect(await store.list()).toEqual([]);
  });

  it('rechecks generation currency after asynchronous reads and durable replay lookup', async () => {
    let current = true;
    const canonicalStore = createHostSubagentStore();
    const delayedStore = Object.freeze({
      ...canonicalStore,
      async get(input: Parameters<typeof canonicalStore.get>[0]) {
        current = false;
        return await canonicalStore.get(input);
      },
    });
    const readService = createPluginSubagentsService({
      store: delayedStore,
      identity,
      isCurrent: () => current,
      durableCustody: createDurableCustody(),
    });
    await expect(readService.get('missing')).rejects.toMatchObject({ code: 'plugin_generation_retired' });

    current = true;
    const replayCustody: PluginSubagentDurableCustody = {
      availability: () => ({ status: 'available' }),
      normalizeGroupId: (groupId) => groupId,
      async list() { return []; },
      async mutate() {
        current = false;
        return Object.freeze({
            id: 'cached',
            parentSessionId: identity.parentSessionId,
            status: 'running',
            revision: '1',
            updatedAtMs: 1,
        });
      },
      async retire() {},
    };
    const replayService = createPluginSubagentsService({
      store: canonicalStore,
      identity,
      isCurrent: () => current,
      durableCustody: replayCustody,
    });
    await expect(replayService.observe({
      observationId: 'cached',
      status: 'running',
    })).rejects.toMatchObject({ code: 'plugin_generation_retired' });
  });

  it('paginates opaquely across the full canonical per-parent capacity', async () => {
    const store = createHostSubagentStore();
    const service = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody: createDurableCustody() });
    for (let index = 0; index < 101; index += 1) {
      await service.observe({ observationId: `child-${index}`, status: 'running' });
    }
    const first = await service.list({ limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toMatch(/^plugin_subagents_v1_/);
    await expect(service.list({ cursor: '100' })).rejects.toMatchObject({ code: 'plugin_subagent_cursor_invalid' });
    await expect(service.list({ cursor: first.nextCursor })).resolves.toMatchObject({ items: [expect.any(Object)] });
  });

  it('keeps a pagination snapshot stable when the canonical store changes between pages', async () => {
    const probeStore = createHostSubagentStore();
    const probe = createPluginSubagentsService({ store: probeStore, identity, isCurrent: () => true, durableCustody: createDurableCustody() });
    const candidates: Array<{ id: string; localId: string }> = [];
    for (let index = 0; index < 20; index += 1) {
      const localId = `inserted-${index}`;
      const candidate = await probe.observe({ observationId: localId, status: 'running' });
      candidates.push({ id: candidate.id, localId });
    }
    candidates.sort((left, right) => left.id.localeCompare(right.id));

    const store = createHostSubagentStore();
    const service = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody: createDurableCustody() });
    await service.observe({ observationId: candidates[0]!.localId, status: 'running' });
    await service.observe({ observationId: candidates.at(-1)!.localId, status: 'running' });
    const initial = await service.list({ limit: 100 });
    const first = await service.list({ limit: 1 });

    await service.observe({ observationId: candidates[10]!.localId, status: 'running' });

    const second = await service.list({ cursor: first.nextCursor, limit: 100 });
    expect([...first.items, ...second.items]).toEqual(initial.items);
  });

  it('rejects non-finite limits and accessor-hostile writes before custody', async () => {
    const store = createHostSubagentStore();
    const service = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody: createDurableCustody() });
    await expect(service.list({ limit: Number.NaN })).rejects.toMatchObject({ code: 'plugin_subagent_limit_invalid' });
    const getter = vi.fn(() => { throw new Error('must not invoke'); });
    const input = Object.defineProperty({ status: 'running' }, 'observationId', { enumerable: true, get: getter });
    await expect(service.observe(input as never)).rejects.toMatchObject({ code: 'plugin_subagent_input_invalid' });
    expect(getter).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it('rejects non-JSON detail before durable custody or canonical mutation', async () => {
    const store = createHostSubagentStore();
    const durableCustody = createDurableCustody();
    const run = vi.spyOn(durableCustody, 'mutate');
    const service = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody });

    await expect(service.observe({
      observationId: 'child',
      status: 'running',
      detail: 1n as never,
    })).rejects.toMatchObject({ code: 'plugin_subagent_input_invalid' });
    await expect(service.observe({
      observationId: 1n,
      status: 'running',
    } as never)).rejects.toMatchObject({ code: 'plugin_subagent_input_invalid' });
    await expect(service.observe({
      observationId: 'child',
      status: 'unknown',
    } as never)).rejects.toMatchObject({ code: 'plugin_subagent_input_invalid' });

    expect(run).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it('does not expose another owner or ledger revision through watch and isolates listener failures', async () => {
    const store = createHostSubagentStore();
    const custody = createDurableCustody();
    const firstService = createPluginSubagentsService({ store, identity, isCurrent: () => true, durableCustody: custody });
    const otherService = createPluginSubagentsService({
      store,
      identity: { ...identity, pluginId: 'other.plugin' },
      isCurrent: () => true,
      durableCustody: custody,
    });
    const observed: Array<{ kind: string }> = [];
    const throwing = firstService.watch({}, (event) => {
      if (event.kind === 'upserted') throw new Error('plugin listener failure');
    });
    const receiving = firstService.watch({}, (event) => observed.push(event));
    await vi.waitFor(() => expect(observed).toEqual([{ kind: 'snapshot' }]));

    await otherService.observe({ observationId: 'other', status: 'running' });
    await firstService.observe({ observationId: 'first', status: 'running' });
    await vi.waitFor(() => expect(observed.some((event) => event.kind === 'upserted')).toBe(true));

    expect(observed.at(-1)).toEqual({ kind: 'upserted', item: expect.any(Object) });
    throwing.dispose();
    receiving.dispose();
  });

});
