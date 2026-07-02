import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    buildReviewCommentTextSnapshotHashes,
    REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES_V1,
} from '@happier-dev/protocol';

import { resolveReviewCommentSnapshot } from './snapshots';

describe('resolveReviewCommentSnapshot', () => {
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

    it('uses server-compatible bidi minified and truncation metadata', async () => {
        const root = join(tmpdir(), `happier-review-snapshot-policy-${Date.now()}-${Math.random()}`);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(
            join(root, 'src', 'policy.ts'),
            [
                'const bidi = "\u061C";',
                'x'.repeat(5000),
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
            truncated: true,
            truncationReason: 'line_too_long',
            likelyMinified: true,
        });
        expect(longLineSnapshot?.kind).toBe('text');
        if (longLineSnapshot?.kind === 'text') {
            expect(longLineSnapshot.selectedLines[0]!.length).toBeLessThanOrEqual(
                REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES_V1,
            );
        }
        expect(mediumLineSnapshot).toMatchObject({
            kind: 'text',
            truncated: true,
            truncationReason: 'line_too_long',
            likelyMinified: true,
        });
        expect(mediumLineSnapshot?.kind).toBe('text');
        if (mediumLineSnapshot?.kind === 'text') {
            expect(mediumLineSnapshot.beforeContext.every(
                (line) => line.length <= REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES_V1,
            )).toBe(true);
        }
    });
});
