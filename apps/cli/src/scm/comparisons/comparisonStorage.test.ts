import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { readStoredScmComparison, writeStoredScmComparison } from './comparisonStorage';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { captureScmComparison, deleteCapturedScmComparison, readCapturedScmComparison,
  readCapturedScmComparisonFile, readCapturedScmComparisonIndex, readCapturedScmComparisonPage } from './captureScmComparison';

type ReadObserver = Readonly<{ mock: Readonly<{ results: ReadonlyArray<Readonly<{ type: string; value: unknown }>> }> }>;
async function observedBytes(fileReads: readonly ReadObserver[], handleReads: readonly ReadObserver[]): Promise<number> {
  let bytesRead = 0;
  for (const spy of fileReads) for (const result of spy.mock.results) {
    if (result.type !== 'return') continue;
    const value: unknown = await result.value;
    if (typeof value === 'string') bytesRead += Buffer.byteLength(value);
    else if (Buffer.isBuffer(value)) bytesRead += value.byteLength;
  }
  for (const spy of handleReads) for (const result of spy.mock.results) {
    if (result.type !== 'return') continue;
    const value: unknown = await result.value;
    if (value && typeof value === 'object' && 'bytesRead' in value && typeof value.bytesRead === 'number') bytesRead += value.bytesRead;
  }
  return bytesRead;
}

async function countReadBytes(consume: () => Promise<void>): Promise<number> {
  const handles: ReadObserver[] = [];
  const readFiles: ReadObserver[] = [];
  const originalOpen = fs.open;
  const files = vi.spyOn(fs, 'readFile');
  const opens = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    handles.push(vi.spyOn(handle, 'read'));
    readFiles.push(vi.spyOn(handle, 'readFile'));
    return handle;
  });
  try { await consume(); return await observedBytes([files, ...readFiles], handles); }
  finally { opens.mockRestore(); files.mockRestore(); vi.restoreAllMocks(); }
}

describe('captured comparison selective storage reads', () => {
  it('reads an index and one file without reading unrelated retained patch bytes', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-selective-storage-' });
    let comparisonId: string | undefined;
    try {
      await fs.writeFile(join(fixture.rootPath, fixture.trackedPath), 'selected immutable bytes\n');
      await fs.writeFile(join(fixture.rootPath, 'unrelated.txt'), 'other patch line\n'.repeat(150_000));
      const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
      comparisonId = captured.comparison.id;
      const expected = captured.comparison.inventory.files.find(file => file.path === fixture.trackedPath)!;
      const unrelatedBytes = Buffer.byteLength(captured.comparison.inventory.files.find(file => file.path === 'unrelated.txt')!.evidence.unifiedDiff!);
      const handleReads: ReadObserver[] = [];
      const handleReadFiles: ReadObserver[] = [];
      // Observe genuine filesystem boundaries while keeping storage and schemas real.
      const originalOpen = fs.open;
      const fileReads = vi.spyOn(fs, 'readFile');
      const opens = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args);
        handleReads.push(vi.spyOn(handle, 'read'));
        handleReadFiles.push(vi.spyOn(handle, 'readFile'));
        return handle;
      });
      try {
        const input = { cwd: fixture.rootPath, comparisonId };
        const index = await readCapturedScmComparisonIndex(input);
        expect(index.comparison.inventory.files).toHaveLength(captured.comparison.inventory.files.length);
        expect(index.comparison.inventory.files.every(file => file.evidence.state === 'deferred')).toBe(true);
        const opened = await readCapturedScmComparisonFile({ ...input, path: fixture.trackedPath });
        expect(opened.comparison.inventory.files).toEqual([expected]);
        expect(opened.files).toHaveLength(1);
        const page = await readCapturedScmComparisonPage({ ...input,
          projection: { kind: 'index', cursor: captured.comparison.inventory.files.length - 1 } });
        expect(page.success).toBe(true);
        if (!page.success) throw new Error(page.error);
        expect(page.page).toEqual({ totalFiles: captured.comparison.inventory.files.length, nextCursor: null });
        expect(page.comparison.inventory.files.map(file => file.path)).toEqual([captured.comparison.inventory.files.at(-1)!.path]);
        const bytesRead = await observedBytes([fileReads, ...handleReadFiles], handleReads);
        expect(bytesRead, 'index and selected-file reads must exclude the unrelated retained patch').toBeLessThan(unrelatedBytes);
      } finally { opens.mockRestore(); fileReads.mockRestore(); vi.restoreAllMocks(); }
      expect(await readCapturedScmComparison({ cwd: fixture.rootPath, comparisonId })).toEqual(captured);
    } finally {
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await fs.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  it('reads a late page and selected path without parsing earlier index records', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-page-storage-' });
    let comparisonId: string | undefined;
    try {
      await fs.writeFile(join(fixture.rootPath, fixture.trackedPath), 'selected immutable bytes\n');
      const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
      comparisonId = captured.comparison.id;
      const path = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons', 'repository', comparisonId + '.json');
      const stored = await readStoredScmComparison(path);
      const selected = stored.comparison.inventory.files[0]!;
      const measure = async (prefixCount: number) => {
        const files = Array.from({ length: prefixCount }, (_, position) => ({ ...selected, path: `prefix/${position}.txt` }));
        files.push(selected);
        await writeStoredScmComparison(path, { ...stored, comparison: { ...stored.comparison,
          inventory: { ...stored.comparison.inventory, files } } });
        return countReadBytes(async () => {
          const page = await readCapturedScmComparisonPage({ cwd: fixture.rootPath, comparisonId: comparisonId!,
            projection: { kind: 'index', cursor: prefixCount } });
          expect(page.success).toBe(true);
          if (!page.success) throw new Error(page.error);
          expect(page.page).toEqual({ totalFiles: files.length, nextCursor: null });
          expect(page.comparison.inventory.files.map(file => file.path)).toEqual([selected.path]);
          const opened = await readCapturedScmComparisonFile({ cwd: fixture.rootPath, comparisonId: comparisonId!, path: selected.path });
          expect(opened.comparison.inventory.files).toEqual([selected]);
        });
      };
      const small = await measure(4);
      const large = await measure(256);
      expect(large, '64 times more earlier index records must not multiply selected page/file bytes').toBeLessThan(small * 2);
    } finally {
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await fs.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

  it('promotes legacy JSON after a successful read and preserves readable bytes when publication fails', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-legacy-storage-' });
    let comparisonId: string | undefined;
    try {
      await fs.writeFile(join(fixture.rootPath, fixture.trackedPath), 'legacy immutable bytes\n');
      const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
      comparisonId = captured.comparison.id;
      const path = join(configuration.activeServerDir, 'runtime', 'scm', 'comparisons', 'repository', comparisonId + '.json');
      const stored = await readStoredScmComparison(path);
      const legacy = JSON.stringify(stored);
      await fs.writeFile(path, legacy);
      // A genuine filesystem publication failure must not lose readable evidence.
      const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('injected write refusal'), { code: 'EACCES' }));
      try {
        expect(await readCapturedScmComparison({ cwd: fixture.rootPath, comparisonId })).toEqual(captured);
        expect(await fs.readFile(path, 'utf8')).toBe(legacy);
      } finally { rename.mockRestore(); }
      // A Session lookup may admit the repository-scoped fallback. Promotion
      // must stay in that admitted namespace so a second lookup remains readable.
      const fallbackInput = { cwd: fixture.rootPath, comparisonId, sessionId: 'legacy-repository-fallback' };
      expect(await readCapturedScmComparison(fallbackInput)).toEqual(captured);
      expect((await fs.readFile(path)).subarray(0, 1).toString()).not.toBe('{');
      expect(await readCapturedScmComparison(fallbackInput)).toEqual(captured);
      expect(await readStoredScmComparison(path)).toEqual(stored);
    } finally {
      vi.restoreAllMocks();
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await fs.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

});
