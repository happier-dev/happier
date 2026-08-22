import { afterEach, describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import {
    buildSessionNavigationCursor,
    type SessionNavigationCursor,
    type SessionNavigationCursorIdentity,
} from './sessionNavigationCursor';
import {
    clearSessionNavigationCursor,
    publishSessionNavigationCursor,
    readSessionNavigationCursor,
    resetSessionNavigationCursorForTests,
    subscribeToSessionNavigationCursor,
    useSessionNavigationCursor,
} from './sessionNavigationCursorStore';
import type { SessionListLikeItem } from './sessionNavigationOrder';

const session = (id: string, serverId: string): SessionListLikeItem => ({ type: 'session', serverId, sessionId: id });

function identityFor(sourceScopeKey: string): SessionNavigationCursorIdentity {
    return { origin: 'session-list', sourceScopeKey, storageKind: 'all' };
}

function cursorFor(sourceScopeKey: string, sessionIds: readonly string[]): SessionNavigationCursor {
    const cursor = buildSessionNavigationCursor({
        identity: identityFor(sourceScopeKey),
        items: sessionIds.map((id) => session(id, 'server-a')),
        nowMs: 1_000,
    });
    if (!cursor) throw new Error('expected a navigable cursor fixture');
    return cursor;
}

afterEach(() => {
    resetSessionNavigationCursorForTests();
});

describe('session navigation cursor store', () => {
    it('replaces the stored cursor when the source scope key changes', () => {
        publishSessionNavigationCursor(cursorFor('scope-a', ['alpha', 'beta']));
        publishSessionNavigationCursor(cursorFor('scope-b', ['gamma', 'delta']));

        const stored = readSessionNavigationCursor();
        expect(stored?.identity.sourceScopeKey).toBe('scope-b');
        expect(stored?.entries.map((entry) => entry.sessionKey)).toEqual(['server-a:gamma', 'server-a:delta']);
    });

    it('reports the stored cursor to a subscriber and stops after unsubscribe', () => {
        const seen: (string | null)[] = [];
        const unsubscribe = subscribeToSessionNavigationCursor(() => {
            seen.push(readSessionNavigationCursor()?.identity.sourceScopeKey ?? null);
        });

        publishSessionNavigationCursor(cursorFor('scope-a', ['alpha', 'beta']));
        clearSessionNavigationCursor();
        unsubscribe();
        publishSessionNavigationCursor(cursorFor('scope-c', ['epsilon', 'zeta']));

        expect(seen).toEqual(['scope-a', null]);
        expect(readSessionNavigationCursor()?.identity.sourceScopeKey).toBe('scope-c');
    });

    it('exposes the published cursor through the hook reader', async () => {
        const cursor = cursorFor('scope-a', ['alpha', 'beta']);
        publishSessionNavigationCursor(cursor);

        const hook = await renderHook(() => useSessionNavigationCursor());
        expect(hook.getCurrent()).toBe(cursor);

        await hook.unmount();
    });

    it('resets the stored cursor for tests', () => {
        publishSessionNavigationCursor(cursorFor('scope-a', ['alpha', 'beta']));
        expect(readSessionNavigationCursor()).not.toBeNull();

        resetSessionNavigationCursorForTests();

        expect(readSessionNavigationCursor()).toBeNull();
    });
});
