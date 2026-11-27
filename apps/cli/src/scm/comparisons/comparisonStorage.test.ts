import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { ScmComparisonCaptureInputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { readStoredScmComparison, writeStoredScmComparison, resolveStoredScmComparisonPath } from './comparisonStorage';
import { createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { captureScmComparison as captureComparison, deleteCapturedScmComparison as deleteComparison, readCapturedScmComparison as readComparison,
  readCapturedScmComparisonFile as readComparisonFile, readCapturedScmComparisonIndex as readComparisonIndex,
  readCapturedScmComparisonPage as readComparisonPage } from './captureScmComparison';
import { runWithScmAccountScope } from '../accountScope';

const testAccountId = 'comparison-storage-account';
function withAccount<Args extends readonly unknown[], Result>(effect: (...args: Args) => Result) {
  return (...args: Args): Result => runWithScmAccountScope(testAccountId, () => effect(...args));
}
const captureScmComparison = withAccount(captureComparison);
const deleteCapturedScmComparison = withAccount(deleteComparison);
const readCapturedScmComparison = withAccount(readComparison);
const readCapturedScmComparisonFile = withAccount(readComparisonFile);
const readCapturedScmComparisonIndex = withAccount(readComparisonIndex);
const readCapturedScmComparisonPage = withAccount(readComparisonPage);

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
  it('isolates the same immutable comparison identity by its requester Account', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-account-storage-' });
    const requester = `${fixture.rootPath}-requester`;
    const member = `${fixture.rootPath}-member`;
    let comparisonId: string | undefined;
    let memberCaptured = false;
    let memberDeleted = false;
    try {
      await fs.writeFile(join(fixture.rootPath, fixture.trackedPath), 'Account-owned evidence\n');
      const captured = await runWithScmAccountScope(requester, () => captureComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } }));
      comparisonId = captured.comparison.id;
      const request = { cwd: fixture.rootPath, comparisonId };
      const retained = await readStoredScmComparison(resolveStoredScmComparisonPath({
        activeServerDir: configuration.activeServerDir, comparisonId, accountId: requester,
      }));
      expect(retained.retainedRefs.length).toBeGreaterThan(0);
      expect(await runWithScmAccountScope(member, () => readComparison(request)).catch(() => null)).toBeNull();
      const independentlyCaptured = await runWithScmAccountScope(member, () => captureComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } }));
      memberCaptured = true;
      expect(independentlyCaptured.comparison.id).toBe(comparisonId);
      await runWithScmAccountScope(member, () => deleteComparison(request));
      memberDeleted = true;
      for (const pin of retained.retainedRefs) {
        expect(runScmExecutable(fixture.rootPath, 'git', ['rev-parse', '--verify', pin.ref])).toBe(pin.oid);
      }
      expect(await runWithScmAccountScope(requester, () => readComparison(request)))
        .toMatchObject({ comparison: { id: comparisonId } });
    } finally {
      if (comparisonId) for (const account of [requester, ...(memberCaptured && !memberDeleted ? [member] : [])]) {
        await runWithScmAccountScope(account, () => deleteComparison({ cwd: fixture.rootPath, comparisonId: comparisonId! }));
      }
      await fs.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });
  it('reads only caller-demanded rows from a 9,119-file seekable capture', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-demand-storage-' });
    let comparisonId: string | undefined;
    try {
      await fs.writeFile(join(fixture.rootPath, fixture.trackedPath), 'demanded immutable bytes\n');
      const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
      comparisonId = captured.comparison.id;
      const path = resolveStoredScmComparisonPath({ activeServerDir: configuration.activeServerDir, comparisonId, accountId: testAccountId });
      const stored = await readStoredScmComparison(path);
      const selected = stored.comparison.inventory.files[0]!;
      const input = ScmComparisonCaptureInputSchema.parse({ cwd: fixture.rootPath, comparisonId,
        source: { kind: 'workingTree' }, projection: { kind: 'index', limit: 13 } });
      const measure = async (count: number) => {
        const files = Array.from({ length: count }, (_, index) => ({ ...selected, path: `src/file-${index}.ts` }));
        await writeStoredScmComparison(path, { ...stored, comparison: { ...stored.comparison,
          inventory: { ...stored.comparison.inventory, files } } });
        return countReadBytes(async () => {
          const page = await readCapturedScmComparisonPage({ cwd: input.cwd, comparisonId: input.comparisonId!,
            projection: input.projection! });
          expect(page.success).toBe(true);
          if (!page.success) throw new Error(page.error);
          expect(page.page).toEqual({ totalFiles: count, nextCursor: count > 13 ? 13 : null });
          expect(page.comparison.inventory.files.map(file => file.path)).toEqual(files.slice(0, 13).map(file => file.path));
          expect(JSON.stringify(page)).not.toContain('unifiedDiff');
        });
      };
      const small = await measure(13);
      const large = await measure(9_119);
      expect(large, 'unrequested records must not multiply demand-page filesystem reads').toBeLessThan(small * 2);
    } finally {
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await fs.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

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
      const path = resolveStoredScmComparisonPath({ activeServerDir: configuration.activeServerDir, comparisonId, accountId: testAccountId });
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

  it('rejects unsupported JSON comparison containers without rewriting their bytes', async () => {
    const fixture = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'scm-legacy-storage-' });
    let comparisonId: string | undefined;
    try {
      await fs.writeFile(join(fixture.rootPath, fixture.trackedPath), 'legacy immutable bytes\n');
      const captured = await captureScmComparison({ cwd: fixture.rootPath, source: { kind: 'workingTree' } });
      comparisonId = captured.comparison.id;
      const path = resolveStoredScmComparisonPath({ activeServerDir: configuration.activeServerDir, comparisonId, accountId: testAccountId });
      const stored = await readStoredScmComparison(path);
      const legacy = JSON.stringify(stored);
      await fs.writeFile(path, legacy);
      await expect(readCapturedScmComparison({ cwd: fixture.rootPath, comparisonId }))
        .rejects.toMatchObject({ code: 'DIFF_UNAVAILABLE' });
      expect(await fs.readFile(path, 'utf8')).toBe(legacy);
      await writeStoredScmComparison(path, stored);
      expect(await readCapturedScmComparison({ cwd: fixture.rootPath, comparisonId })).toEqual(captured);
      expect(await readStoredScmComparison(path)).toEqual(stored);
    } finally {
      vi.restoreAllMocks();
      if (comparisonId) await deleteCapturedScmComparison({ cwd: fixture.rootPath, comparisonId });
      await fs.rm(fixture.rootPath, { recursive: true, force: true });
    }
  });

});
