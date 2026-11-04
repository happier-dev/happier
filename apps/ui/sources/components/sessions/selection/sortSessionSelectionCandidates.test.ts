import { describe, expect, it } from 'vitest';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { sortSessionSelectionCandidates } from './sortSessionSelectionCandidates';

describe('Session chooser ordering', () => {
    const sessions = [
        { id: 'same', serverId: 'home-a', createdAt: 1000, updatedAt: 1000 },
        { id: 'same', serverId: 'home-b', createdAt: 2000, updatedAt: 2000 },
        { id: 'latest', serverId: 'home-c', createdAt: 3000, updatedAt: 3000 },
    ];
    it('keeps the focused tuple first, then known MRU tuples, then existing activity order', () => {
        const result = sortSessionSelectionCandidates(sessions, {
            focusedSession: { serverId: 'home-a', sessionId: 'same' },
            mruOrder: [sessionAddressKey({ serverId: 'home-b', sessionId: 'same' })],
        });
        expect(result.map(session => session.serverId)).toEqual(['home-a', 'home-b', 'home-c']);
        expect(sortSessionSelectionCandidates(sessions).map(session => session.serverId))
            .toEqual(['home-c', 'home-b', 'home-a']);
    });
    it('lets navigation resolve legacy recent keys without interpreting ambiguous Home/session delimiters', () => {
        const result = sortSessionSelectionCandidates(sessions, { mruOrder: ['home-a:same', 'missing'] });
        expect(result.map(session => session.serverId)).toEqual(['home-a', 'home-c', 'home-b']);
    });
});
