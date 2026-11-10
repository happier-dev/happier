import { describe, expect, it } from 'vitest';

import {
    SCM_LOG_QUERY_MAX_LENGTH,
    ScmLogListRequestSchema,
    ScmLogListResponseSchema,
} from './index.js';

/**
 * `scm.log.list` bounded-query expansion (Universal Search US-05).
 *
 * Compatibility shape:
 * - the request gains one bounded optional `query` field (additive-open; older daemons
 *   ignore it) and the response gains one optional `queryApplied` echo so a client can
 *   distinguish "the daemon searched" from "the daemon ignored the query and returned a
 *   recent page". Absence of the echo is the unsupported signal; it can never falsely
 *   report a successful search.
 * - every shape shipped before this expansion must keep parsing unchanged.
 */
describe('ScmLogList wire contract with bounded commit query', () => {
    it('keeps ref selection closed and distinct from pinned ranges, with explicit resolved evidence', () => {
        const revisionRangeFromRef = { baseOid: 'a'.repeat(40), headRef: 'refs/heads/feature' };
        expect(ScmLogListRequestSchema.parse({ cwd: '/repo', revisionRangeFromRef })).toMatchObject({ revisionRangeFromRef });
        for (const other of [{ query: 'feature' }, { range: 'incoming' },
            { revisionRange: { kind: 'revisionRange', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) } }]) {
            expect(ScmLogListRequestSchema.safeParse({ cwd: '/repo', revisionRangeFromRef, ...other }).success).toBe(false);
        }
        expect(ScmLogListRequestSchema.safeParse({ cwd: '/repo', revisionRangeFromRef: { ...revisionRangeFromRef, repository: '/other' } }).success).toBe(false);
        expect(ScmLogListResponseSchema.parse({ success: true, entries: [], revisionRange: {
            kind: 'revisionRange', ...revisionRangeFromRef, headOid: 'b'.repeat(40), historyComplete: true,
        } })).toMatchObject({ revisionRange: { headRef: revisionRangeFromRef.headRef } });
    });
    it('admits only exact immutable range endpoints and preserves explicit completeness evidence', () => {
        const revisionRange = { kind: 'revisionRange', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(64) };
        expect(ScmLogListRequestSchema.parse({ cwd: '/repo', revisionRange }).revisionRange).toEqual(revisionRange);
        for (const invalid of [
            { ...revisionRange, baseOid: 'HEAD' },
            { ...revisionRange, headOid: 'b'.repeat(41) },
            { ...revisionRange, repository: '/other' },
        ]) expect(ScmLogListRequestSchema.safeParse({ cwd: '/repo', revisionRange: invalid }).success).toBe(false);
        for (const selector of [{ query: '[skip ci]' }, { range: 'incoming' }]) {
            expect(ScmLogListRequestSchema.safeParse({ cwd: '/repo', revisionRange, ...selector }).success).toBe(false);
        }
        const evidence = { ...revisionRange, historyComplete: false, nextSkip: 50 };
        expect(ScmLogListResponseSchema.parse({ success: true, entries: [], revisionRange: evidence }).revisionRange).toEqual(evidence);
        expect(ScmLogListResponseSchema.parse({ success: true, entries: [] }).revisionRange).toBeUndefined();
    });

    it('accepts the legacy request/response shape without any query field', () => {
        const request = ScmLogListRequestSchema.parse({ cwd: '/repo', limit: 50, skip: 0 });
        expect(request.cwd).toBe('/repo');

        const response = ScmLogListResponseSchema.parse({ success: true, entries: [] });
        expect(response.success).toBe(true);
        expect(response.queryApplied).toBeUndefined();
    });

    it('accepts a bounded query on the request and echoes queryApplied on the response', () => {
        const request = ScmLogListRequestSchema.parse({ cwd: '/repo', limit: 20, query: 'fix login' });
        expect(request.query).toBe('fix login');

        const response = ScmLogListResponseSchema.parse({ success: true, entries: [], queryApplied: true });
        expect(response.queryApplied).toBe(true);
    });

    it('accepts only the fixed incoming range and its explicit producer acknowledgement', () => {
        expect(ScmLogListRequestSchema.parse({ cwd: '/repo', range: 'incoming' }).range).toBe('incoming');
        expect(ScmLogListRequestSchema.safeParse({ cwd: '/repo', range: 'other-ref' }).success).toBe(false);
        expect(ScmLogListResponseSchema.parse({ success: true, entries: [], rangeApplied: true }).rangeApplied).toBe(true);
        expect(ScmLogListResponseSchema.parse({ success: true, entries: [] }).rangeApplied).toBeUndefined();
    });

    it('rejects a query beyond the published bound', () => {
        const tooLong = 'a'.repeat(SCM_LOG_QUERY_MAX_LENGTH + 1);
        expect(ScmLogListRequestSchema.safeParse({ cwd: '/repo', query: tooLong }).success).toBe(false);
        expect(SCM_LOG_QUERY_MAX_LENGTH).toBeGreaterThan(0);
    });

    it('accepts a query exactly at the published bound', () => {
        const atBound = 'a'.repeat(SCM_LOG_QUERY_MAX_LENGTH);
        expect(ScmLogListRequestSchema.safeParse({ cwd: '/repo', query: atBound }).success).toBe(true);
    });

    it('rejects unknown request and response fields at the SCM routing boundary', () => {
        expect(ScmLogListRequestSchema.safeParse({
            cwd: '/repo',
            query: 'fix login',
            routeToAnotherWorkspace: true,
        }).success).toBe(false);

        expect(ScmLogListResponseSchema.safeParse({
            success: true,
            entries: [],
            queryApplied: true,
            authoritativeScope: 'all-refs',
        }).success).toBe(false);
    });

    it('rejects unknown fields on commit identities returned by the SCM owner', () => {
        expect(ScmLogListResponseSchema.safeParse({
            success: true,
            entries: [{
                sha: 'a'.repeat(40),
                shortSha: 'a'.repeat(12),
                authorName: 'Ada Lovelace',
                authorEmail: 'ada@example.com',
                timestamp: 1,
                subject: 'fix: login',
                body: '',
                activationTarget: 'another-repository',
            }],
            queryApplied: true,
        }).success).toBe(false);
    });
});
