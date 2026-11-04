import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { readGitComparisonFiles } from './readGitComparisonFiles';
import { captureScmComparison, deleteCapturedScmComparison, readCapturedScmComparison } from './captureScmComparison';
import { configuration } from '@/configuration';
import type { ScmComparison } from '@happier-dev/protocol';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';

const writes = vi.hoisted(() => [] as Array<{ file: string; chunks: number[] }>);

// Observe real filesystem reads: decoding a whole diff in readFile builds a rope
// that the comparison parser then flattens into another repository-sized string.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
        const [file, data, options] = args;
        const record = { file: String(file), chunks: [] as number[] };
        writes.push(record);
        if (typeof data === 'string') record.chunks.push(Buffer.byteLength(data));
        if (data && typeof data === 'object' && !ArrayBuffer.isView(data)
            && (Symbol.asyncIterator in data || Symbol.iterator in data)) {
            const observed = async function* () {
                for await (const chunk of data) {
                    record.chunks.push(Buffer.byteLength(chunk));
                    yield chunk;
                }
            };
            return actual.writeFile(file, observed(), options);
        }
        return actual.writeFile(...args);
    }) };
});

describe('SCM evidence allocation contracts', () => {
    const directories: string[] = [];
    afterEach(async () => {
        vi.mocked(readFile).mockClear();
        writes.length = 0;
        await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
    });

    it('reads complete large UTF-8 patches without a second whole-diff string from filesystem decoding', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'happier-comparison-allocation-'));
        directories.push(cwd);
        execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
        const git = (args: string[], input: string) => execFileSync('git', args, { cwd, input, encoding: 'utf8' }).trim();
        const tree = (content: string) => {
            const blob = git(['hash-object', '-w', '--stdin'], content);
            return git(['mktree'], `100644 blob ${blob}\tlarge.txt\n`);
        };
        // Match the existing checkpoint >4 MiB output-limit regression, including
        // non-ASCII and CR content so a byte-read optimization cannot corrupt text.
        const content = Array.from({ length: 70_000 }, (_, index) => `${index}: ${'cöntent😀'.repeat(10)}\r\n`).join('');
        const before = tree('before\n');
        const after = tree(content);
        vi.mocked(readFile).mockClear();

        const result = await readGitComparisonFiles({ cwd, before, after });

        expect(result.enumerationComplete).toBe(true);
        expect(result.reasons).toEqual([]);
        expect(result.files).toHaveLength(1);
        expect(result.files[0]?.unifiedDiff).toContain(`+${content.replace(/\n(?=.)/g, '\n+')}`);
        const decodedDiffReads = vi.mocked(readFile).mock.calls.filter(([file, options]) => {
            const encoding = typeof options === 'string' ? options : options?.encoding;
            return basename(String(file)) === 'diff' && encoding != null;
        });
        expect(decodedDiffReads).toHaveLength(0);
    });

    it('reads retained evidence and its Machine fallback without filesystem string ropes', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'happier-captured-allocation-'));
        directories.push(cwd);
        execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
        const id = randomUUID().replaceAll('-', '').padEnd(64, '0');
        const comparison: ScmComparison = {
            id, source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
            inventory: { state: 'complete', reasons: [], files: [{
                path: 'large.txt', changeKind: 'modified', binary: false, generated: false, lockfile: false,
                evidence: { state: 'available', unifiedDiff: 'cöntent😀\r\n'.repeat(70_000) }, occurrences: [],
            }] },
        };
        const metadata = { source: comparison.source, sourceKey: id };
        const folder = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons', 'repository');
        await mkdir(folder, { recursive: true });
        const file = join(folder, `${id}.json`);
        directories.push(file);
        await writeFile(file, JSON.stringify({ comparison, metadata, retainedRefs: [] }));
        vi.mocked(readFile).mockClear();

        for (const sessionId of [undefined, randomUUID()]) {
            const captured = await readCapturedScmComparison({ cwd, comparisonId: id, sessionId });
            expect(captured.comparison).toEqual(comparison);
            expect(captured.metadata).toEqual(metadata);
        }
        const decodedCaptureReads = vi.mocked(readFile).mock.calls.filter(([path, options]) => {
            const encoding = typeof options === 'string' ? options : options?.encoding;
            return basename(String(path)) === `${id}.json` && encoding != null;
        });
        expect(decodedCaptureReads).toHaveLength(0);
    });

    it('persists complete captured evidence with chunks no larger than its largest file record', async () => {
        const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-write-allocation-' });
        directories.push(fixture.rootPath);
        await writeFile(join(fixture.rootPath, fixture.trackedPath), 'cöntent😀\r\n'.repeat(70_000));
        await writeFile(join(fixture.rootPath, 'other.txt'), 'other evidence\n'.repeat(70_000));
        writes.length = 0;
        const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
        try {
            expect(captured.comparison.inventory.state).toBe('complete');
            expect(captured.comparison.inventory.files).toHaveLength(2);
            const stored = await readCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id });
            expect(stored).toEqual(captured);
            const chunks = writes.filter(write => basename(write.file).startsWith('.tmp-')).flatMap(write => write.chunks);
            expect(chunks.length).toBeGreaterThan(0);
            const largestRecordBytes = Math.max(...captured.comparison.inventory.files.map(file => Buffer.byteLength(JSON.stringify(file))));
            expect(Math.max(...chunks)).toBeLessThanOrEqual(largestRecordBytes);
        } finally {
            await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId: captured.comparison.id });
        }
    });
});
