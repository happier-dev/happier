import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildReviewCommentTextSnapshotHashes } from '@happier-dev/protocol';

import { resolveReviewCommentSnapshot } from './snapshots';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { captureScmComparison } from '@/scm/comparisons/captureScmComparison';
import { runWithScmAccountScope } from '@/scm/accountScope';

// Filesystem disposal is an OS boundary; comparison capture and snapshot reading stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, rm: vi.fn(actual.rm) };
});

describe('resolveReviewCommentSnapshot', () => {
    it('retains captured evidence when temporary blob disposal fails', async () => runWithScmAccountScope('snapshot-cleanup', async () => {
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'review-snapshot-cleanup-' });
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const leaked: string[] = [];
        try {
            await writeFile(join(fixture.rootPath, fixture.trackedPath), 'captured finding evidence\n');
            const { comparison } = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree', area: 'both' } });
            const anchor = { kind: 'line' as const, filePath: fixture.trackedPath, line: 1 };
            const control = await resolveReviewCommentSnapshot({ cwd: fixture.rootPath, anchor, comparison });
            expect(control).toMatchObject({ kind: 'text', source: 'diffSide' });
            vi.mocked(rm).mockImplementationOnce(async (path) => {
                leaked.push(String(path));
                throw Object.assign(new Error('Temporary directory is busy'), { code: 'EBUSY' });
            });
            await expect(resolveReviewCommentSnapshot({ cwd: fixture.rootPath, anchor, comparison }))
                .resolves.toMatchObject({ kind: 'text', source: 'diffSide', selectedLines: control?.kind === 'text' ? control.selectedLines : [] });
        } finally {
            vi.mocked(rm).mockReset().mockImplementation(actual.rm);
            await Promise.all([...leaked, fixture.rootPath].map(path => actual.rm(path, { recursive: true, force: true })));
        }
    }));

    it('does not relocate an out-of-range selection onto the final line', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-range-${Date.now()}-${Math.random()}`);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'example.ts'), 'only line\n');
        await expect(resolveReviewCommentSnapshot({ cwd: root,
            anchor: { kind: 'range', filePath: 'example.ts', startLine: 1, endLine: 999 },
        })).resolves.toBeNull();
    });

    it('resolves text snapshots through the canonical review comment snapshot policy', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-${Date.now()}-${Math.random()}`);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(
            join(root, 'src', 'example.ts'),
            Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
            'utf8',
        );

        const snapshot = await resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'range', filePath: 'src/example.ts', startLine: 6, endLine: 7 },
            now: () => 123,
        });

        expect(snapshot).toMatchObject({
            kind: 'text',
            selectedLines: ['line 6', 'line 7'],
            beforeContext: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'],
            afterContext: ['line 8', 'line 9', 'line 10', 'line 11', 'line 12'],
            capturedAt: 123,
            fileLength: 12,
            source: 'workingTree',
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        });
        expect(snapshot?.kind).toBe('text');
        if (snapshot?.kind === 'text') {
            expect({
                selectedLinesHash: snapshot.selectedLinesHash,
                contextWindowHash: snapshot.contextWindowHash,
            }).toEqual(buildReviewCommentTextSnapshotHashes(snapshot));
        }
    });

    it('rejects snapshot anchors that escape the review scope root', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-escape-${Date.now()}-${Math.random()}`);
        await mkdir(root, { recursive: true });

        await expect(resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'file', filePath: '../outside.ts' },
            now: () => 123,
        })).resolves.toBeNull();
    });

    it('rejects snapshot anchors that escape through an intermediate symlink', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-symlink-escape-${Date.now()}-${Math.random()}`);
        const outside = join(tmpdir(), `happier-review-snapshot-outside-${Date.now()}-${Math.random()}`);
        await mkdir(root, { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n', 'utf8');
        await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

        await expect(resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'file', filePath: 'linked/secret.ts' },
            now: () => 123,
        })).resolves.toBeNull();
    });

    it('represents git submodule directories without coercing them to text snapshots', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-submodule-${Date.now()}-${Math.random()}`);
        await mkdir(join(root, 'vendor', 'library'), { recursive: true });
        await writeFile(join(root, 'vendor', 'library', '.git'), 'gitdir: ../../.git/modules/vendor/library\n', 'utf8');

        await expect(resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'submodule', filePath: 'vendor/library' },
            now: () => 123,
        })).resolves.toEqual({
            kind: 'submodule',
            filePath: 'vendor/library',
            capturedAt: 123,
        });
    });

    it('preserves long lines and derives metadata from the complete captured text', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-policy-${Date.now()}-${Math.random()}`);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(
            join(root, 'src', 'policy.ts'),
            [
                'const bidi = "\u061C";',
                `${'x'.repeat(5000)}\u202E`,
                'y'.repeat(1500),
            ].join('\n'),
            'utf8',
        );

        const bidiSnapshot = await resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'line', filePath: 'src/policy.ts', line: 1 },
            now: () => 123,
        });
        const longLineSnapshot = await resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'line', filePath: 'src/policy.ts', line: 2 },
            now: () => 123,
        });
        const mediumLineSnapshot = await resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'line', filePath: 'src/policy.ts', line: 3 },
            now: () => 123,
        });

        expect(bidiSnapshot).toMatchObject({
            kind: 'text',
            hasBidiControls: true,
        });
        expect(longLineSnapshot).toMatchObject({
            kind: 'text',
            truncated: false,
            hasBidiControls: true,
            likelyMinified: true,
        });
        expect(longLineSnapshot?.kind).toBe('text');
        if (longLineSnapshot?.kind === 'text') {
            expect(longLineSnapshot.selectedLines).toEqual([`${'x'.repeat(5000)}\u202E`]);
            expect(longLineSnapshot.selectedLinesHash).toBe(buildReviewCommentTextSnapshotHashes(longLineSnapshot).selectedLinesHash);
        }
        expect(mediumLineSnapshot).toMatchObject({
            kind: 'text',
            truncated: false,
            likelyMinified: true,
        });
        expect(mediumLineSnapshot?.kind).toBe('text');
        if (mediumLineSnapshot?.kind === 'text') {
            expect(mediumLineSnapshot.beforeContext[1]).toBe(`${'x'.repeat(5000)}\u202E`);
        }
    });

    it('captures a selected window from a file larger than the former 5 MiB cutoff', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-large-${Date.now()}-${Math.random()}`);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'large.ts'), `${'x'.repeat(5 * 1024 * 1024)}\nlast line`, 'utf8');

        const snapshot = await resolveReviewCommentSnapshot({
            cwd: root,
            anchor: { kind: 'line', filePath: 'large.ts', line: 2 },
            now: () => 123,
        });
        expect(snapshot).toMatchObject({ kind: 'text', selectedLines: ['last line'], truncated: false });
        if (snapshot?.kind === 'text') expect(snapshot.beforeContext[0]).toHaveLength(5 * 1024 * 1024);
    });
});
