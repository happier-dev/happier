import { describe, expect, it } from 'vitest';
import { normalizeRelationshipUpdatedUpdateBody } from './relationshipUpdate';

describe('normalizeRelationshipUpdatedUpdateBody', () => {
    it('returns null for non-objects', () => {
        expect(normalizeRelationshipUpdatedUpdateBody(null, { currentUserId: 'me' })).toBeNull();
        expect(normalizeRelationshipUpdatedUpdateBody('x', { currentUserId: 'me' })).toBeNull();
    });

    it('accepts rich relationship update shape', () => {
        const res = normalizeRelationshipUpdatedUpdateBody(
            {
                fromUserId: 'a',
                toUserId: 'b',
                status: 'friend',
                timestamp: 123,
                action: 'accept',
            },
            { currentUserId: 'me' },
        );

        expect(res).toEqual(
            expect.objectContaining({
                fromUserId: 'a',
                toUserId: 'b',
                status: 'friend',
                timestamp: 123,
                action: 'accept',
            }),
        );
    });

    it('preserves optional rich-shape fields', () => {
        const res = normalizeRelationshipUpdatedUpdateBody(
            {
                fromUserId: 'a',
                toUserId: 'b',
                status: 'friend',
                timestamp: 123,
                action: 'accept',
                fromUser: { id: 'a' },
                toUser: { id: 'b' },
            },
            { currentUserId: 'me' },
        );

        expect(res).toEqual({
            fromUserId: 'a',
            toUserId: 'b',
            status: 'friend',
            timestamp: 123,
            action: 'accept',
            fromUser: { id: 'a' },
            toUser: { id: 'b' },
        });
    });

    it('maps legacy server shape (uid/status/timestamp) using currentUserId', () => {
        const res = normalizeRelationshipUpdatedUpdateBody(
            { uid: 'other', status: 'requested', timestamp: 55 },
            { currentUserId: 'me' },
        );

        expect(res).toEqual({
            fromUserId: 'me',
            toUserId: 'other',
            status: 'requested',
            timestamp: 55,
        });
    });

    it('rejects legacy shape without currentUserId', () => {
        const res = normalizeRelationshipUpdatedUpdateBody(
            { uid: 'other', status: 'requested', timestamp: 55 },
            { currentUserId: null },
        );
        expect(res).toBeNull();
    });

    it('rejects legacy shape when required fields are malformed', () => {
        expect(
            normalizeRelationshipUpdatedUpdateBody(
                { uid: 'other', status: 123, timestamp: 55 },
                { currentUserId: 'me' },
            ),
        ).toBeNull();
        expect(
            normalizeRelationshipUpdatedUpdateBody(
                { uid: 'other', status: 'requested', timestamp: '55' },
                { currentUserId: 'me' },
            ),
        ).toBeNull();
    });
});
