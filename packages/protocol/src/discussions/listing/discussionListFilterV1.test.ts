import { describe, expect, it } from 'vitest';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { compileDiscussionListFilterV1, DiscussionListFilterV1Schema } from './discussionListFilterV1.js';

describe('Discussion list filters', () => {
    it('ANDs independent attention and unread conditions with source state', () => {
        const match = compileDiscussionListFilterV1({ state: 'active', attention: 'needs_you', unreadOnly: true });
        expect(match({ state: 'active', needsYou: true, unread: true })).toBe('match');
        expect(match({ state: 'active', needsYou: true, unread: false })).toBe('miss');
        expect(match({ state: 'active', unread: true })).toBe('unavailable');
        expect(match({ state: 'archived', unread: true })).toBe('miss');
        expect(compileDiscussionListFilterV1({ state: 'archived', attention: 'any', unreadOnly: false })({ state: 'archived' })).toBe('match');
    });

    it('refuses cross-entity/current unknown writes and keeps future saved narrowing, which narrows no list', () => {
        expect(DiscussionListFilterV1Schema.safeParse({ state: 'active', attention: 'any', unreadOnly: false, view: 'running' }).success).toBe(false);
        const stored = { state: 'active', attention: 'any', unreadOnly: false, futureField: true };
        const read = createStoredReadSchema(DiscussionListFilterV1Schema).parse(stored);
        expect(read).toEqual(stored);
        expect(compileDiscussionListFilterV1(read)({ state: 'active' })).toBe('match');
    });
});
