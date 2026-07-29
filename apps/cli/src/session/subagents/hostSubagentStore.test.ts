import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostSubagentStore } from './hostSubagentStore';

describe('host subagent projection store', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('allows owning plugins to write and exposes bounded projection reads', async () => {
        const store = createHostSubagentStore();

        const written = await store.upsert({
            actor: { kind: 'plugin', pluginId: 'happier.agent.acme', agentId: 'acme.sample' },
            input: {
                id: 'subagent-1',
                parentSessionId: 'session-1',
                origin: 'agent',
                kind: 'native',
                agentRef: { agentId: 'acme.sample' },
            },
        });

        expect(written).toMatchObject({
            id: 'subagent-1',
            parentSessionId: 'session-1',
            origin: 'agent',
            kind: 'native',
            status: 'pending',
        });
        await expect(store.list({ parentSessionId: 'session-1' })).resolves.toEqual([written]);
        await expect(store.get({ id: 'subagent-1', parentSessionId: 'session-1' })).resolves.toEqual(written);
    });

    it('rejects foreign plugin writes with a stable authority error', async () => {
        const store = createHostSubagentStore();

        await expect(store.upsert({
            actor: { kind: 'plugin', pluginId: 'happier.agent.foreign', agentId: 'foreign.plugin' },
            input: {
                id: 'subagent-1',
                parentSessionId: 'session-1',
                origin: 'agent',
                kind: 'native',
                agentRef: { agentId: 'acme.sample' },
            },
        })).rejects.toMatchObject({
            code: 'subagent_write_forbidden',
        });
    });

    it('does not let another plugin replace an existing subagent by reusing its id', async () => {
        const store = createHostSubagentStore();

        await store.upsert({
            actor: { kind: 'plugin', pluginId: 'happier.agent.plugin-a', agentId: 'plugin-a' },
            input: {
                id: 'shared-id',
                parentSessionId: 'session-1',
                origin: 'agent',
                kind: 'native',
                agentRef: { agentId: 'plugin-a' },
            },
        });

        await expect(store.upsert({
            actor: { kind: 'plugin', pluginId: 'happier.agent.plugin-b', agentId: 'plugin-b' },
            input: {
                id: 'shared-id',
                parentSessionId: 'session-1',
                origin: 'agent',
                kind: 'native',
                agentRef: { agentId: 'plugin-b' },
            },
        })).rejects.toMatchObject({
            code: 'subagent_write_forbidden',
        });
        await expect(store.get({ id: 'shared-id', parentSessionId: 'session-1' })).resolves.toMatchObject({
            agentRef: { agentId: 'plugin-a' },
        });
    });

    it('keeps plugin-origin subagents without an agent ref owned by their creating plugin', async () => {
        const store = createHostSubagentStore();

        await store.upsert({
            actor: { kind: 'plugin', pluginId: 'happier.agent.plugin-a', agentId: 'plugin-a' },
            input: {
                id: 'plugin-owned',
                parentSessionId: 'session-1',
                origin: 'plugin',
                kind: 'custom',
            },
        });

        await expect(store.upsert({
            actor: { kind: 'plugin', pluginId: 'happier.agent.plugin-b', agentId: 'plugin-b' },
            input: {
                id: 'plugin-owned',
                parentSessionId: 'session-1',
                origin: 'plugin',
                kind: 'custom',
            },
        })).rejects.toMatchObject({
            code: 'subagent_write_forbidden',
        });
        await expect(store.updateStatus({
            actor: { kind: 'plugin', pluginId: 'happier.agent.plugin-b', agentId: 'plugin-b' },
            id: 'plugin-owned',
            parentSessionId: 'session-1',
            status: 'running',
        })).rejects.toMatchObject({
            code: 'subagent_write_forbidden',
        });
        await expect(store.complete({
            actor: { kind: 'plugin', pluginId: 'happier.agent.plugin-b', agentId: 'plugin-b' },
            id: 'plugin-owned',
            parentSessionId: 'session-1',
        })).rejects.toMatchObject({
            code: 'subagent_write_forbidden',
        });
    });

    it('rejects external RPC mutations with a stable authority error', async () => {
        const store = createHostSubagentStore();

        await expect(store.upsert({
            actor: { kind: 'externalRpc' },
            input: {
                id: 'subagent-1',
                parentSessionId: 'session-1',
                origin: 'plugin',
                kind: 'custom',
            },
        })).rejects.toMatchObject({
            code: 'subagent_write_forbidden',
        });
    });

    it('caps public list results', async () => {
        const store = createHostSubagentStore({ maxListResults: 2 });

        for (const id of ['subagent-1', 'subagent-2', 'subagent-3']) {
            await store.upsert({
                actor: { kind: 'host' },
                input: {
                    id,
                    parentSessionId: 'session-1',
                    origin: 'happier',
                    kind: 'custom',
                },
            });
        }

        await expect(store.list({ parentSessionId: 'session-1' })).resolves.toEqual([
            expect.objectContaining({ id: 'subagent-1' }),
            expect.objectContaining({ id: 'subagent-2' }),
        ]);
    });

    it('honors a caller limit within the store cap', async () => {
        const store = createHostSubagentStore({ maxListResults: 3 });

        for (const id of ['subagent-1', 'subagent-2', 'subagent-3']) {
            await store.upsert({
                actor: { kind: 'host' },
                input: {
                    id,
                    parentSessionId: 'session-1',
                    origin: 'happier',
                    kind: 'custom',
                },
            });
        }

        await expect(store.list({ parentSessionId: 'session-1', limit: 1 })).resolves.toEqual([
            expect.objectContaining({ id: 'subagent-1' }),
        ]);
    });

    it('bounds long-lived watchers and expires idle subscriptions', async () => {
        vi.useFakeTimers();
        const store = createHostSubagentStore({
            maxWatchers: 1,
            watchIdleTtlMs: 100,
        });
        const onClose = vi.fn();
        const first = store.watch({ parentSessionId: 'session-1' }, vi.fn(), { onClose });

        expect(() => store.watch({ parentSessionId: 'session-1' }, vi.fn())).toThrow(expect.objectContaining({
            code: 'subagent_watch_capacity_exceeded',
        }));

        await vi.advanceTimersByTimeAsync(101);

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(() => store.watch({ parentSessionId: 'session-1' }, vi.fn())).not.toThrow();
        first.unsubscribe();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('requires parentSessionId for bare-id mutations', async () => {
        const store = createHostSubagentStore();
        await store.upsert({
            actor: { kind: 'host' },
            input: {
                id: 'subagent-1',
                parentSessionId: 'session-1',
                origin: 'happier',
                kind: 'custom',
            },
        });

        await expect(store.updateStatus({
            actor: { kind: 'host' },
            id: 'subagent-1',
            status: 'running',
        })).rejects.toMatchObject({
            code: 'subagent_parent_session_required',
        });
        await expect(store.complete({
            actor: { kind: 'host' },
            id: 'subagent-1',
        })).rejects.toMatchObject({
            code: 'subagent_parent_session_required',
        });
    });
});
