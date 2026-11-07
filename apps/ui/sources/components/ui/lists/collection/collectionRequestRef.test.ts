import { describe, expect, it } from 'vitest';
import type { SessionPendingRequest, SessionPendingRequestLists } from '@happier-dev/session-core/pending';
import { createCollectionSessionRequestRef, resolveCollectionSessionRequest } from './collectionRequestRef';

const permission: SessionPendingRequest = {
    id: 'request', turnId: 'turn-a', tool: 'Bash', kind: 'permission',
    arguments: { command: 'git status' }, createdAt: 1,
};
const target = { serverId: 'home-a', sessionId: 'session' };
const ref = createCollectionSessionRequestRef(target, permission);
const lists = (request: SessionPendingRequest): SessionPendingRequestLists => ({ permissionRequests: [request], userActionRequests: [] });

describe('collection request identity', () => {
    it('qualifies only the compact identity, never borrowing another Home or copying extra body fields', () => {
        const held = { ...ref, arguments: { private: 'not a row field' } };
        expect(createCollectionSessionRequestRef({ serverId: 'home-b', sessionId: 'other' }, held))
            .toEqual({ serverId: 'home-b', sessionId: 'other', kind: 'permission', requestId: 'request', turnId: 'turn-a' });
    });

    it('returns only the actual pending request on the exact Home, Session and turn', () => {
        expect(resolveCollectionSessionRequest(ref, target, lists(permission))).toEqual({ kind: 'current', request: permission });
        expect(resolveCollectionSessionRequest(ref, { ...target, serverId: 'home-b' }, lists(permission))).toEqual({ kind: 'unavailable' });
        expect(resolveCollectionSessionRequest(ref, { ...target, sessionId: 'other' }, lists(permission))).toEqual({ kind: 'unavailable' });
        const replacement = { ...permission, turnId: 'turn-b' };
        expect(resolveCollectionSessionRequest(ref, target, lists(replacement))).toEqual({
            kind: 'replaced', replacement: createCollectionSessionRequestRef(target, replacement),
        });
        // A historical reference cannot borrow the witness of a current request with the same id.
        const { turnId: _turn, ...historical } = ref;
        expect(resolveCollectionSessionRequest(historical, target, lists(permission)).kind).toBe('replaced');
    });

    it('settles the exact request without lending another question or permission its controls', () => {
        expect(resolveCollectionSessionRequest(ref, target, { permissionRequests: [], userActionRequests: [] })).toEqual({ kind: 'settled' });
        const question: SessionPendingRequest = { ...permission, kind: 'user_action', tool: 'AskUserQuestion' };
        expect(resolveCollectionSessionRequest(ref, target, { permissionRequests: [], userActionRequests: [question] })).toEqual({ kind: 'settled' });
        const historical: SessionPendingRequest = { id: 'old', kind: 'permission', tool: 'Bash', arguments: {}, createdAt: null };
        expect(resolveCollectionSessionRequest(createCollectionSessionRequestRef(target, historical), target, lists(historical)))
            .toEqual({ kind: 'current', request: historical });
    });
});
