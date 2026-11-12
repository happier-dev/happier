import { afterEach, describe, expect, it } from 'vitest';

import { registerSessionTranscriptDerivedCacheClear } from '@/sync/runtime/sessionTranscriptDerivedCaches';
import { readEvictedSessionTranscript } from '@/sync/domains/state/sessionTranscriptDiskCache';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';

import { createMessagesDomain } from './messages';

function createHarness(initial: any = {}) {
    let state: any = {
        sessions: {},
        sessionPending: {},
        sessionMessages: {},
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

function buildSessionRow(sessionId: string) {
    return {
        id: sessionId,
        createdAt: 1,
        active: false,
        activeAt: 1,
        metadataVersion: 1,
        metadata: null,
        permissionMode: null,
        permissionModeUpdatedAt: 0,
    };
}

function userMessage(id: string, seq: number, text: string) {
    return {
        id,
        seq,
        localId: null,
        createdAt: 1000 + seq,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text },
    } as any;
}

describe('messages domain: evictSessionMessages', () => {
    const unregisterFns: Array<() => void> = [];

    afterEach(() => {
        while (unregisterFns.length > 0) {
            unregisterFns.pop()?.();
        }
    });

    it('hydrating a persisted baseline restores reducer identity so the first-open refetch does not duplicate rows', async () => {
        await prepareWarmCacheEncryptionKey();
        const scope = { serverId: 'server-a', accountId: 'account-a' } as any;
        const { get, domain } = createHarness({
            sessions: { 'rehydrate-s1': buildSessionRow('rehydrate-s1') },
            sessionLocalStateScope: scope,
        });

        domain.applyMessages('rehydrate-s1', [userMessage('w1', 1, 'hello')]);
        domain.applyMessagesLoaded('rehydrate-s1');
        const originalIds = (get().sessionMessages['rehydrate-s1'].messageIdsOldestFirst as string[]).slice();
        expect(originalIds).toHaveLength(1);

        domain.evictSessionMessages('rehydrate-s1');
        const baseline = readEvictedSessionTranscript(scope, 'rehydrate-s1');
        expect(baseline).not.toBeNull();
        domain.hydrateSessionMessages('rehydrate-s1', baseline!);
        expect((get().sessionMessages['rehydrate-s1'].messageIdsOldestFirst as string[]).length).toBe(1);

        // The first-open fetch re-applies the same wire rows. The reducer must recognize them
        // through the hydrated baseline's identity maps instead of allocating duplicates.
        domain.applyMessages('rehydrate-s1', [userMessage('w1', 1, 'hello')]);

        const entry = get().sessionMessages['rehydrate-s1'];
        expect((entry.messageIdsOldestFirst as string[]).length).toBe(1);
        expect((entry.messageIdsOldestFirst as string[])).toEqual(originalIds);
    });

    it('hydrated tool calls keep receiving late tool results after eviction and reopen', async () => {
        await prepareWarmCacheEncryptionKey();
        const scope = { serverId: 'server-a', accountId: 'account-a' } as any;
        const { get, domain } = createHarness({
            sessions: { 'tool-hydrate-s1': buildSessionRow('tool-hydrate-s1') },
            sessionLocalStateScope: scope,
        });

        const toolCallWire = {
            id: 'wire-agent-1',
            localId: null,
            createdAt: 100,
            isSidechain: false,
            role: 'agent',
            content: [{
                type: 'tool-call',
                id: 'tool-use-1',
                name: 'Agent',
                input: { description: 'long-running task' },
                description: null,
            }],
        } as any;
        domain.applyMessages('tool-hydrate-s1', [toolCallWire]);
        domain.applyMessagesLoaded('tool-hydrate-s1');

        domain.evictSessionMessages('tool-hydrate-s1');
        const baseline = readEvictedSessionTranscript(scope, 'tool-hydrate-s1');
        expect(baseline).not.toBeNull();
        domain.hydrateSessionMessages('tool-hydrate-s1', baseline!);

        // The long-running tool finishes after the session was evicted and reopened: the
        // late result must update the hydrated tool-call row, not be silently dropped.
        const toolResultWire = {
            id: 'wire-agent-2',
            localId: null,
            createdAt: 200,
            isSidechain: false,
            role: 'agent',
            content: [{
                type: 'tool-result',
                tool_use_id: 'tool-use-1',
                content: 'done after reopen',
                is_error: false,
            }],
        } as any;
        domain.applyMessages('tool-hydrate-s1', [toolResultWire]);

        const entry = get().sessionMessages['tool-hydrate-s1'];
        const toolRow = (entry.messageIdsOldestFirst as string[])
            .map((id: string) => entry.messagesById[id])
            .find((message: any) => message?.kind === 'tool-call');
        expect(toolRow).toBeDefined();
        expect(toolRow.tool.state).toBe('completed');
        expect(String(toolRow.tool.result)).toContain('done after reopen');
    });

    it('removes the sessionMessages entry entirely so a re-open follows the first-open load pipeline', () => {
        const { get, domain } = createHarness({
            sessions: { s1: buildSessionRow('s1'), s2: buildSessionRow('s2') },
        });

        domain.applyMessages('s1', [userMessage('m1', 1, 'hello')]);
        domain.applyMessagesLoaded('s1');
        domain.applyMessages('s2', [userMessage('m2', 1, 'other')]);
        domain.applyMessagesLoaded('s2');

        expect(get().sessionMessages.s1.isLoaded).toBe(true);

        domain.evictSessionMessages('s1');

        // Entry is gone entirely (transcript, reducerState, aggregate), not reset-in-place.
        expect(get().sessionMessages.s1).toBeUndefined();
        // Other sessions keep their entries (referentially untouched).
        expect(get().sessionMessages.s2.isLoaded).toBe(true);
        expect(Object.keys(get().sessionMessages.s2.messagesById)).toHaveLength(1);

        // Re-opening behaves like a first open: not loaded until the pipeline marks it.
        expect(get().sessionMessages.s1?.isLoaded).not.toBe(true);
        domain.applyMessagesLoaded('s1');
        expect(get().sessionMessages.s1.isLoaded).toBe(true);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toEqual([]);
    });

    it('clears per-session derived transcript caches through the shared release seam', () => {
        const cleared: string[] = [];
        unregisterFns.push(registerSessionTranscriptDerivedCacheClear((sessionId) => {
            cleared.push(sessionId);
        }));

        const { domain } = createHarness({ sessions: { s1: buildSessionRow('s1') } });
        domain.applyMessages('s1', [userMessage('m1', 1, 'hello')]);
        domain.applyMessagesLoaded('s1');

        domain.evictSessionMessages('s1');
        expect(cleared).toEqual(['s1']);
    });

    it('persists the evicted transcript to the disk cache before dropping it', async () => {
        await prepareWarmCacheEncryptionKey();
        const scope = { serverId: 'server-a', accountId: 'account-a' } as any;
        const { get, domain } = createHarness({
            sessions: { s1: buildSessionRow('s1') },
            sessionLocalStateScope: scope,
        });
        domain.applyMessages('s1', [userMessage('m1', 1, 'hello')]);
        domain.applyMessagesLoaded('s1');
        // The reducer owns committed message ids, so compare against the store's own ids.
        const persistedIds = (get().sessionMessages.s1.messageIdsOldestFirst as string[]).slice();

        domain.evictSessionMessages('s1');

        // The store entry is gone, but the disk copy keeps the transcript for warm re-open.
        expect(get().sessionMessages.s1).toBeUndefined();
        expect(readEvictedSessionTranscript(scope, 's1')?.map((m: any) => m.id)).toEqual(persistedIds);
    });

    it('is a no-op for sessions without a hydrated entry', () => {
        const cleared: string[] = [];
        unregisterFns.push(registerSessionTranscriptDerivedCacheClear((sessionId) => {
            cleared.push(sessionId);
        }));

        const { get, domain } = createHarness();
        const before = get().sessionMessages;

        domain.evictSessionMessages('missing');

        expect(get().sessionMessages).toBe(before);
        expect(cleared).toEqual([]);
    });
});
