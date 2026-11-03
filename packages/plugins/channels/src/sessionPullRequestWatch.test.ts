import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { SessionPullRequestWatchListResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { CHANNELS_PLUGIN } from './manifest.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_STATE_INDEX_ID } from './collections.js';
import { withChannelStateSessionIdentity } from './collectionMigrations.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { sessionPullRequestBindingFixture } from './testkit/sessionPullRequestBindingFixture.js';
import { observeSessionPullRequestWatchAction } from './sessionPullRequestWatch.js';
import type { SettingsChange } from '@happier-dev/plugin-sdk/settings';

describe('portable Account PR Watch Action', () => {
    it('invalidates once for selected binding/latest changes and only the effective limit setting', async () => {
        const state = new MemoryCollection();
        const value = sessionPullRequestBindingFixture('pr-1', 'session-a', 12);
        await state.put(withChannelStateSessionIdentity(value, value.payload.target), { expectedRevision: 'absent' });
        const settingsListeners = new Set<(change: SettingsChange) => void>();
        const controller = new AbortController();
        const invalidate = vi.fn();
        const watch = vi.spyOn(state, 'watch');
        const observation = await observeSessionPullRequestWatchAction({ kind: 'get', sessionId: 'session-a' }, invalidate, {
            invokedAtMs: 1, signal: controller.signal, services: {
                storage: { account: { collection: () => state } } as unknown as PluginServices['storage'],
                actions: { execute: vi.fn() } as unknown as PluginServices['actions'],
                settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
                    get: async () => null, describe: () => [], watch: listener => {
                        settingsListeners.add(listener); return { dispose: () => { settingsListeners.delete(listener); } };
                    } }) },
            },
        });
        await vi.waitFor(() => expect(watch).toHaveBeenCalledWith({ index: 'by-connection-binding-v2',
            prefix: ['connection-1', null, 'connection'], order: 'asc' }, expect.any(Function)));
        invalidate.mockClear();
        const foreign = sessionPullRequestBindingFixture('foreign-pr', 'foreign-session', 13);
        await state.put(withChannelStateSessionIdentity(foreign, foreign.payload.target), { expectedRevision: 'absent' });
        expect(invalidate).not.toHaveBeenCalled();
        await state.put(withChannelStateSessionIdentity({ ...value, payload: { ...value.payload, enabled: true } }, value.payload.target), { expectedRevision: 1 });
        expect(invalidate).toHaveBeenCalledOnce();
        invalidate.mockClear();
        await state.put({ id: 'latest', 'record-kind': 'ingress-obligation', 'session-id': 'session-a', 'binding-id': 'pr-1' }, { expectedRevision: 'absent' });
        expect(invalidate).toHaveBeenCalledOnce();
        invalidate.mockClear();
        for (const listener of settingsListeners) listener({ scope: { kind: 'account' }, revision: '2', changedIds: ['other'], values: {} });
        expect(invalidate).not.toHaveBeenCalled();
        for (const listener of settingsListeners) listener({ scope: { kind: 'account' }, revision: '3', changedIds: ['pr-watch-fix-attempt-limit'], values: {} });
        expect(invalidate).toHaveBeenCalledOnce();
        controller.abort();
        expect(settingsListeners.size).toBe(0);
        observation.dispose();
    });
    it('pages complete distinct Session groups without reading unrelated chat bodies or repeating full groups', async () => {
        const state = new MemoryCollection();
        // An earlier physical page of tombstones must not become the Session's
        // representative and suppress its later live, disabled/off bindings.
        for (let index = 0; index < PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1; index += 1) {
            const value = sessionPullRequestBindingFixture(`deleted-${String(index).padStart(6, '0')}`, 'session-a', index + 1);
            await state.put(withChannelStateSessionIdentity({ ...value,
                payload: { ...value.payload, deletionState: 'finalizingDelete' } }, value.payload.target), { expectedRevision: 'absent' });
        }
        for (let index = 0; index <= PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1; index += 1) {
            const value = sessionPullRequestBindingFixture(`pr-${String(index).padStart(6, '0')}`, 'session-a', index + 1);
            await state.put(withChannelStateSessionIdentity(value, value.payload.target), { expectedRevision: 'absent' });
        }
        const last = sessionPullRequestBindingFixture('last-pr', 'session-b', 10_000);
        await state.put(withChannelStateSessionIdentity(last, last.payload.target), { expectedRevision: 'absent' });
        for (let index = 0; index < 1_000; index += 1) {
            const value = sessionPullRequestBindingFixture(`chat-${index}`, 'session-a', index + 1);
            if (value.payload.target.kind !== 'session') throw new Error('Expected a Session target');
            const { pullRequestLink: _link, ...target } = value.payload.target;
            await state.put(withChannelStateSessionIdentity({ ...value, payload: { ...value.payload, target } }, target), { expectedRevision: 'absent' });
        }
        const query = vi.spyOn(state, 'query');
        const execute = vi.fn(async (id: string, input: unknown) => {
            if (id !== 'session.targets.resolve' || input === null || typeof input !== 'object' || !('target' in input)) {
                throw new Error('Watch metadata only resolves exact Session addresses');
            }
            return { coverage: 'complete', addresses: [{ sessionId: input.target, serverId: 'srv_plugin_testkit' }], error: null };
        });
        const kit = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest, module: CHANNELS_PLUGIN,
            services: {
                storage: { account: { collection: (definition: { id: string }) => {
                    if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected Collection');
                    return state;
                } } } as unknown as PluginServices['storage'],
                settings: { forScope: () => ({ snapshot: async () => ({ scope: { kind: 'account' as const }, revision: '1', values: {} }),
                    get: async () => null, describe: () => [], watch: () => ({ dispose() {} }),
                    set: async () => { throw new Error('Read only'); }, reset: async () => { throw new Error('Read only'); } }) },
                actions: { execute } as unknown as PluginServices['actions'],
            },
        });
        try {
            const sessions = [];
            let cursor: string | null = null;
            do {
                const request: Record<string, JsonValue> = { kind: 'list' };
                if (cursor) request.cursor = cursor;
                const result: ReturnType<typeof SessionPullRequestWatchListResultV1Schema.parse> = SessionPullRequestWatchListResultV1Schema.parse(await kit.invokeAction('session-pull-request-watch-v1',
                    request, { surface: 'ui' }));
                if (result.kind !== 'ready') throw new Error('Expected portable Account metadata');
                sessions.push(...result.sessions);
                cursor = result.nextCursor;
            } while (cursor !== null);
            expect(sessions.map(session => session.session.sessionId)).toEqual(['session-a', 'session-b']);
            expect(sessions.map(session => session.bindings.length)).toEqual([PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 + 1, 1]);
            const pages = await Promise.all(query.mock.results.map(result => result.value));
            expect(pages.flatMap(page => page.rows).some(row => row.rowId.startsWith('chat-'))).toBe(false);
            const bindingReads = query.mock.calls.filter(([input]) => input.index === CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1
                && input.prefix?.[2] !== undefined && input.limit === PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1);
            // The complete live PR group spans two pages and is loaded once;
            // tombstones and unrelated chat bodies never enter that reader.
            expect(bindingReads.filter(([input]) => input.prefix?.[2] === 'session-a')).toHaveLength(2);
            expect(bindingReads.every(([input]) => input.prefix?.[2] === 'session-a' || input.prefix?.[2] === 'session-b')).toBe(true);
            expect(query.mock.calls.some(([input]) => input.index === CHANNEL_STATE_INDEX_ID.byKind)).toBe(false);
        } finally { await kit.dispose(); }
    });
});
