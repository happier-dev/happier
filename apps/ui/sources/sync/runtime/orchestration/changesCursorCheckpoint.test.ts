import { describe, expect, it } from 'vitest';
import { decideChangesCursorCheckpoint } from './changesCursorCheckpoint';

describe('decideChangesCursorCheckpoint', () => {
    it('writes the approved cursor synchronously before returning success', () => {
        const writes: string[] = [];

        const result = decideChangesCursorCheckpoint({
            currentCursor: '1',
            approvedCursor: '2',
            shouldAdvance: true,
            scope: 'server-a',
            storage: {
                saveChangesCursor: (cursor) => {
                    writes.push(cursor);
                },
            },
        });

        expect(writes).toEqual(['2']);
        expect(result).toEqual({ status: 'advanced', cursor: '2' });
    });

    it('does not report success when the durable write fails', () => {
        const result = decideChangesCursorCheckpoint({
            currentCursor: '1',
            approvedCursor: '2',
            shouldAdvance: true,
            scope: 'server-a',
            storage: {
                saveChangesCursor: () => {
                    throw new Error('disk full');
                },
            },
        });

        expect(result).toEqual({ status: 'storage-write-failed', cursor: '1' });
    });

    it('refuses unapproved cursor candidates without writing', () => {
        const writes: string[] = [];

        const result = decideChangesCursorCheckpoint({
            currentCursor: '1',
            approvedCursor: '2',
            shouldAdvance: false,
            scope: 'server-a',
            storage: {
                saveChangesCursor: (cursor) => {
                    writes.push(cursor);
                },
            },
        });

        expect(writes).toEqual([]);
        expect(result).toEqual({ status: 'refused', cursor: '1' });
    });
});
