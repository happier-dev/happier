import { describe, expect, it } from 'vitest';
import { triagePagedPanelInitialState } from '@happier-dev/triage-protocol/v1';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import { reduceReleaseListV1 } from './listState.js';

describe('release Collection uses the incumbent pager with domain reconciliation', () => {
    it('retains warm rows on an equal refresh and on a later-page failure', () => {
        const row = createForgeReleaseV1Fixture();
        const page = { rows: [row], omittedRowCount: 0, projectionTruncated: false, continuation: 'next', incomplete: null };
        const initial = reduceReleaseListV1(triagePagedPanelInitialState(), { kind: 'requestStarted', token: 1 });
        const first = reduceReleaseListV1(initial, { kind: 'pageSettled', token: 1, page });
        const refresh = reduceReleaseListV1(first, { kind: 'refreshStarted', token: 2 });
        const equal = reduceReleaseListV1(refresh, { kind: 'pageSettled', token: 2, page: { ...page, rows: [createForgeReleaseV1Fixture()] } });
        expect(equal.rows).toBe(first.rows);
        const failed = reduceReleaseListV1(reduceReleaseListV1(equal, { kind: 'requestStarted', token: 3 }),
            { kind: 'pageFailed', token: 3, failure: { class: 'authentication', code: 'expired' } });
        expect(failed.rows).toBe(first.rows);
        expect(failed.failure?.class).toBe('authentication');
        const overlapping = reduceReleaseListV1(reduceReleaseListV1(equal, { kind: 'requestStarted', token: 4 }),
            { kind: 'pageSettled', token: 4, page: { ...page, rows: [{ ...row, body: 'Newer page evidence' }], continuation: null } });
        expect(overlapping.rows).toHaveLength(1);
        expect(overlapping.rows[0]?.body).toBe('Newer page evidence');
    });
});
