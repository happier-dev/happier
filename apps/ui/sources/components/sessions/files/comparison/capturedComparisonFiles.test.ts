import { describe, expect, it } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { buildCapturedComparisonFiles } from './capturedComparisonFiles';

describe('captured Files evidence projection', () => {
    it('keeps renamed paths, every missing file and supplied partial bytes without mutable capabilities', () => {
        const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'commit', commit: 'oid' },
            repository: { rootPath: '/repo' }, endpoints: { before: 'before', after: 'after' },
            inventory: { state: 'incomplete', reasons: ['page_failed'], files: [
                { path: 'new.ts', previousPath: 'old.ts', changeKind: 'renamed', binary: false, generated: false, lockfile: false,
                    evidence: { state: 'available', unifiedDiff: 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n' }, occurrences: [] },
                { path: 'partial.ts', changeKind: 'modified', binary: null, generated: false, lockfile: false,
                    evidence: { state: 'unavailable', reason: 'patch_truncated', unifiedDiff: '@@ -1 +1 @@\n-old\n+partial\n' }, occurrences: [] },
                { path: 'missing.png', changeKind: 'added', binary: null, generated: false, lockfile: false,
                    evidence: { state: 'unavailable', reason: 'patch_unavailable' }, occurrences: [] },
            ] } });
        const result = buildCapturedComparisonFiles(comparison);
        expect(result.files.map((file) => file.fullPath)).toEqual(['new.ts', 'partial.ts', 'missing.png']);
        expect(result.files[0]).toMatchObject({ oldPath: 'old.ts', status: 'renamed', linesAdded: 1, linesRemoved: 1 });
        expect(result.files[1]).toMatchObject({ isComplete: false, linesAdded: 1, linesRemoved: 1 });
        expect(result.files[2]?.isBinary).toBeUndefined();
        expect(result.diffByPath.get('partial.ts')).toContain('+partial');
        expect(result.diffByPath.has('missing.png')).toBe(true);
        expect(result.diffByPath.get('missing.png')).toBeNull();
        expect([...result.unavailableByPath]).toEqual([['partial.ts', 'patch_truncated'], ['missing.png', 'patch_unavailable']]);
        expect(result.snapshot.capabilities).toBeUndefined();
        expect(result.snapshot.branch.head).toBeNull();
        expect(result.snapshot.projectKey).toBe(comparison.id);
    });
});
