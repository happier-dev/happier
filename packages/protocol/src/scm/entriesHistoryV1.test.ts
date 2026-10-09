import { describe, expect, it } from 'vitest';
import * as scm from './index.js';

describe('entry history contract', () => {
    it('admits literal paths and closes all request and result objects', () => {
        expect(scm.ScmHistoryEntriesInputV1Schema).toBeDefined();
        const input = { cwd: '/repo', folder: '', paths: ['', ':(glob)*', '-dash', 'line\nbreak', 'space '] };
        expect(scm.ScmHistoryEntriesInputV1Schema.safeParse(input).success).toBe(true);
        for (const path of ['../escape', '/absolute', 'C:/absolute', 'a/../escape', 'a\\..\\escape', 'a\0b', './a', 'a//b']) {
            expect(scm.ScmHistoryEntriesInputV1Schema.safeParse({ ...input, paths: [path] }).success).toBe(false);
        }
        expect(scm.ScmHistoryEntriesInputV1Schema.safeParse({ ...input, extra: true }).success).toBe(false);
        expect(scm.ScmHistoryEntriesInputV1Schema.safeParse({ ...input, backendPreference: { kind: 'prefer', backendId: 'git', extra: true } }).success).toBe(false);
        expect(scm.ScmHistoryEntriesInputV1Schema.safeParse({ ...input, folder: 'dir', paths: ['directory/other'] }).success).toBe(false);
        expect(scm.ScmHistoryEntriesInputV1Schema.safeParse({ ...input, headOid: 'branch' }).success).toBe(false);
        const result = { success: true, headOid: 'a'.repeat(40), entries: [{ path: 'a', kind: 'none' }, { path: 'b', kind: 'unavailable', reason: 'shallow_history' }] };
        expect(scm.ScmHistoryEntriesResponseSchema.safeParse(result).success).toBe(true);
        expect(scm.ScmHistoryEntriesResponseSchema.safeParse({ ...result, entries: [{ path: 'a', kind: 'none', commit: {} }] }).success).toBe(false);
        expect(scm.ScmHistoryEntriesResponseSchema.safeParse({ ...result, entries: [{ path: 'a', kind: 'unavailable' }] }).success).toBe(false);
        expect(scm.ScmHistoryEntriesResponseSchema.safeParse({ ...result, entries: [{ path: 'a', kind: 'commit', commit: { oid: 'a'.repeat(40), subject: 'hello', authorName: 'Author', committedAt: 123, email: 'private' } }] }).success).toBe(false);
    });
});
