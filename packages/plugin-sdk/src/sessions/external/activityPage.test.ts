import { describe, expect, it } from 'vitest';
import {
    ExternalSessionActivityPageBudgetError,
    pageExternalSessionCandidatesByActivity,
    type ExternalSessionActivityPosition,
} from './index.js';

const entry = (remoteSessionId: string, updatedAtMs: number): ExternalSessionActivityPosition => ({ remoteSessionId, updatedAtMs });

describe('external-session activity pages', () => {
    it('orders ties by code unit and continues after a removed row without rereading earlier rows', async () => {
        const entries = [entry('z', 1), entry('a', 3), entry('B', 3), entry('new', 4)];
        const read: string[] = [];
        const readRows = async (rows: readonly ExternalSessionActivityPosition[]) => {
            read.push(...rows.map((row) => row.remoteSessionId));
            return rows;
        };
        const first = await pageExternalSessionCandidatesByActivity({ entries, limit: 2, readRows });
        expect(first.candidates.map((row) => row.remoteSessionId)).toEqual(['new', 'B']);
        const second = await pageExternalSessionCandidatesByActivity({
            entries: entries.filter((row) => row.remoteSessionId !== 'B'), after: first.next, limit: 2, readRows,
        });
        expect(second.candidates.map((row) => row.remoteSessionId)).toEqual(['a', 'z']);
        expect(second.next).toBeNull();
        expect(read).toEqual(['new', 'B', 'a', 'z']);
    });

    it('fills a page past excluded rows and stops expensive reads when the page is full', async () => {
        const entries = Array.from({ length: 1_000 }, (_, index) => entry(String(index), 1_000 - index));
        const page = await pageExternalSessionCandidatesByActivity({
            entries, limit: 2,
            readRows: async (rows) => rows.map((row) => Number(row.remoteSessionId) < 3 ? null : row),
        });
        expect(page.candidates.map((row) => row.remoteSessionId)).toEqual(['3', '4']);
        expect(page.rowsRead).toBe(5);
        expect(page.next).toEqual(entries[4]);
    });

    it('resumes at the candidate excluded by the caller result budget', async () => {
        const entries = [entry('a', 3), entry('b', 2), entry('c', 1)];
        const first = await pageExternalSessionCandidatesByActivity({
            entries, limit: 3, readRows: async (rows) => rows,
            fits: (rows) => rows.length <= 1,
        });
        const second = await pageExternalSessionCandidatesByActivity({
            entries, after: first.next, limit: 3, readRows: async (rows) => rows,
        });
        expect(first.candidates).toEqual([entries[0]]);
        expect(second.candidates).toEqual(entries.slice(1));
        await expect(pageExternalSessionCandidatesByActivity({
            entries, limit: 3, readRows: async (rows) => rows, fits: () => false,
        })).rejects.toBeInstanceOf(ExternalSessionActivityPageBudgetError);
    });

    it('does not publish a page when cancelled during its read', async () => {
        const controller = new AbortController();
        const reason = new Error('stopped');
        await expect(pageExternalSessionCandidatesByActivity({
            entries: [entry('a', 1)], limit: 1, signal: controller.signal,
            readRows: async (rows) => { controller.abort(reason); return rows; },
        })).rejects.toBe(reason);
    });
});
