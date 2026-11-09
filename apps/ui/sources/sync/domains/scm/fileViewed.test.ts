import { describe, expect, it } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { isScmFileViewedCurrentHead } from './fileViewed';

const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'pullRequest', locator: {
    providerId: 'example', repository: 'owner/repo', number: 17,
} }, repository: { rootPath: '/repo' }, endpoints: { before: 'before', after: 'head' },
inventory: { state: 'complete', files: [], reasons: [] }, freshness: 'current' });

describe('source Viewed current-head selection', () => {
    it('admits the captured after endpoint, reserves unknown while reading, and excludes a newer head', () => {
        expect(isScmFileViewedCurrentHead(comparison, { status: 'ready', headOid: 'head', errorCode: null })).toBe(true);
        expect(isScmFileViewedCurrentHead(comparison, { status: 'loading', headOid: null, errorCode: null })).toBe(true);
        expect(isScmFileViewedCurrentHead(comparison, { status: 'ready', headOid: 'new-head', errorCode: null })).toBe(false);
        expect(isScmFileViewedCurrentHead({ ...comparison, freshness: 'stale' },
            { status: 'idle', headOid: null, errorCode: null })).toBe(false);
    });
});
