import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { act } from 'react-test-renderer';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { sessionMessageReplyKey } from '@/sync/api/session/sessionMessageReplyApi';
import { useSessionReturnedAnswers } from '@/sync/store/hooks';

afterEach(standardCleanup);

function message(id: string, request?: string, text = 'An ordinary arrival', outcome: 'answer' | 'pass' = 'answer'): NormalizedMessage {
    return {
        id, localId: id, createdAt: 20, role: 'user', isSidechain: false, content: { type: 'text', text },
        ...(request ? { meta: { happierInputAuthorityV1: { v: 1, producer: 'sessionAction',
            permission: { admittedPermissionCeiling: 'read-only' }, caller: { kind: 'host' },
            returnedAnswer: { requestSessionId: 'receiver', requestLocalId: request, outcome,
                delivery: 'wake', senderSessionId: 'receiver' } } } } : {}),
    };
}

function resetStore() {
    const previous = storage.getState();
    onTestFinished(() => storage.setState(previous, true));
    storage.setState({ sessionMessages: {}, sessions: {} });
}

function authoritative(row: NormalizedMessage): NormalizedMessage & { isAuthoritativeUpdate: true } {
    return { ...row, isAuthoritativeUpdate: true };
}

describe('returned answers: transcript-owned request subscriptions', () => {
    it('projects readable answers as a single line and leaves passes and unreadable bodies empty', async () => {
        resetStore();
        const unreadable = message('u', 'unreadable', 'Hidden source text');
        unreadable.meta = { ...unreadable.meta, displayText: '' };
        storage.getState().applyMessages('source', [message('a', 'answer', '**Confirmed**\n\n  replay'),
            message('p', 'pass', 'The requested session passed without an answer.', 'pass'),
            unreadable]);
        const keys = ['answer', 'pass', 'unreadable'].map(localId => sessionMessageReplyKey({ sessionId: 'receiver', localId }));
        const hook = await renderHook(() => useSessionReturnedAnswers('source', keys));
        try {
            expect(hook.getCurrent().map(entry => [entry.answer.outcome, entry.snippet])).toEqual([
                ['answer', 'Confirmed replay'], ['pass', ''], ['answer', ''],
            ]);
        } finally { await hook.unmount(); }
    });

    it('does at most one transcript walk for an unrelated arrival with 20 Ask records and 1000 rows, with zero record renders', async () => {
        resetStore();
        const rows = Array.from({ length: 1_000 }, (_, index) => message(`row-${index}`));
        storage.getState().applyMessages('source', [...rows, message('answer', 'request-0', 'The exact answer')]);
        // Count actual reads of retained transcript rows, without replacing any parser/store logic.
        let retainedRowReads = 0;
        const byId = storage.getState().sessionMessages.source.messagesById;
        for (const row of Object.values(byId)) {
            const meta = row.meta;
            Object.defineProperty(row, 'meta', { configurable: true, get: () => { retainedRowReads += 1; return meta; } });
        }
        const renders = Array.from({ length: 20 }, () => 0);
        const hooks = [];
        for (let index = 0; index < renders.length; index += 1) {
            hooks.push(await renderHook(() => {
                renders[index] += 1;
                return useSessionReturnedAnswers('source', [sessionMessageReplyKey({ sessionId: 'receiver', localId: `request-${index}` })]);
            }));
        }
        try {
            expect(hooks[0].getCurrent()[0]?.snippet).toBe('The exact answer');
            const before = hooks.map(hook => hook.getCurrent());
            const beforeRenders = [...renders];
            retainedRowReads = 0;
            await act(async () => { storage.getState().applyMessages('source', [message('unrelated')]); });
            expect(retainedRowReads).toBeLessThanOrEqual(Object.keys(byId).length);
            expect(retainedRowReads).toBe(0);
            expect(renders).toEqual(beforeRenders);
            for (const [index, hook] of hooks.entries()) expect(hook.getCurrent()).toBe(before[index]);
            await act(async () => { storage.getState().applyMessages('source', [message('other-answer', 'request-1', 'Only the second Ask changes')]); });
            expect(hooks[1].getCurrent()[0]?.snippet).toBe('Only the second Ask changes');
            expect(hooks[0].getCurrent()).toBe(before[0]);
            expect(renders[0]).toBe(beforeRenders[0]);
            expect(renders[1]).toBeGreaterThan(beforeRenders[1]);
        } finally {
            for (const hook of hooks) await hook.unmount();
        }
    });

    it('admits retained history once, reuses equal projections and removes corrected or withdrawn return metadata', async () => {
        resetStore();
        const answer = message('a', 'one', 'Retained answer');
        storage.getState().applyMessages('source', [answer]);
        storage.getState().applyMessagesLoaded('source');
        storage.setState(state => ({ sessionMessages: { ...state.sessionMessages, source: {
            ...state.sessionMessages.source, returnedAnswersByRequest: undefined,
        } } }));
        const keys = ['one', 'two'].map(localId => sessionMessageReplyKey({ sessionId: 'receiver', localId }));
        const hook = await renderHook(() => useSessionReturnedAnswers('source', keys));
        try {
            expect(hook.getCurrent()).toEqual([]);
            await act(async () => { storage.getState().applyMessagesLoaded('source'); });
            expect(hook.getCurrent()[0]?.snippet).toBe('Retained answer');
            const admitted = hook.getCurrent();
            const index = storage.getState().sessionMessages.source.returnedAnswersByRequest;
            await act(async () => { storage.getState().applyMessages('source', [answer]); });
            expect(hook.getCurrent()).toBe(admitted);
            expect(storage.getState().sessionMessages.source.returnedAnswersByRequest).toBe(index);
            await act(async () => { storage.getState().applyMessages('source', [authoritative(message('a', 'two', 'Corrected binding'))]); });
            expect(hook.getCurrent().map(entry => [entry.answer.requestLocalId, entry.snippet])).toEqual([['two', 'Corrected binding']]);
            await act(async () => { storage.getState().applyMessages('source', [authoritative(message('a'))]); });
            expect(hook.getCurrent()).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('selects exact request identity, updates corrected rows and retires answers with replacement/reset/eviction', async () => {
        resetStore();
        storage.getState().applyMessages('source', [message('a', 'one', '**First**\nanswer'), message('b', 'two', 'Second answer')]);
        const hook = await renderHook(() => useSessionReturnedAnswers('source', [sessionMessageReplyKey({ sessionId: 'receiver', localId: 'one' })]));
        try {
            expect(hook.getCurrent().map(entry => entry.snippet)).toEqual(['First answer']);
            await act(async () => { storage.getState().applyMessages('source', [authoritative(message('a', 'one', 'Corrected answer'))]); });
            expect(hook.getCurrent().map(entry => entry.snippet)).toEqual(['Corrected answer']);
            await act(async () => { storage.getState().replaceSessionMessages('source', [message('c', 'two')]); });
            expect(hook.getCurrent()).toEqual([]);
            await act(async () => { storage.getState().applyMessages('source', [message('d', 'one', 'Reopened answer')]); });
            expect(hook.getCurrent()[0]?.snippet).toBe('Reopened answer');
            await act(async () => { storage.getState().resetSessionMessages('source'); });
            expect(hook.getCurrent()).toEqual([]);
            await act(async () => { storage.getState().applyMessages('source', [message('e', 'one', 'Last answer')]); });
            expect(hook.getCurrent()[0]?.snippet).toBe('Last answer');
            await act(async () => { storage.getState().evictSessionMessages('source'); });
            expect(hook.getCurrent()).toEqual([]);
        } finally { await hook.unmount(); }
    });
});
