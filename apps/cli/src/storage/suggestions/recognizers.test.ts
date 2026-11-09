import { mkdtemp, mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import { vi } from 'vitest';
import { createStorageSuggestions, isEmptyStorageFolder, recognizeStorageCandidate, readStorageScanHints, storageCandidateRepositoryFacts, type StorageRecognitionFacts } from './recognizers';
import type { StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';

// Genuine OS boundary: preserve real reads while observing the indexed-file syscall budget.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const fixtures: string[] = [];
const size = { allocatedBytes: 4096, freesBytes: 4096, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false };
async function fixture() { const home = await realpath(await mkdtemp(join(tmpdir(), 'happier-suggestions-'))); fixtures.push(home); return home; }
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('verified storage recognizers', () => {
  it('treats a repository containing a standalone cwd as in use, without claiming every repository below a parent cwd', () => {
    const use = { reliable: true, paths: [], cwdPaths: ['/projects/one'] };
    expect(storageCandidateRepositoryFacts('/projects/one/node_modules', ['/projects/one'], use).repositoryInUse).toBe(true);
    expect(storageCandidateRepositoryFacts('/projects/one/node_modules', ['/projects/one'],
      { ...use, cwdPaths: ['/projects'] }).repositoryInUse).toBe(false);
  });

  it('projects scan descriptors from the recognizer table and positive ignored-path evidence', async () => {
    const home = await fixture(); const repo = join(home, 'project');
    const facts: StorageRecognitionFacts = { protection: { homeDir: home }, now: Date.now(), suggestUnusedAfterDays: 30,
      readIgnoredPaths: async () => ['dist/', 'source/'] };
    const hints = await readStorageScanHints({ root: home, facts, repositoryRoots: [repo] });
    expect(hints.atomicRules).toContainEqual({ names: ['node_modules'], manifests: ['package.json'] });
    const builds = hints.atomicRules?.filter(rule => rule.names?.includes('dist'));
    expect(builds).toHaveLength(1);
    expect(builds?.[0]?.paths).toEqual([join(repo, 'dist')]);
    expect(hints.priorityHints).toContain(join(repo, 'dist'));
    const unavailable = await readStorageScanHints({ root: home,
      facts: { ...facts, readIgnoredPaths: async () => null }, repositoryRoots: [repo] });
    expect(unavailable.atomicRules?.some(rule => rule.names?.includes('dist'))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('does not treat an exact non-UTF8 child as absent or empty', async context => {
    const home = await fixture(); const child = Buffer.concat([Buffer.from(`${home}/`), Buffer.from([0xff])]);
    try { await writeFile(child, 'important'); } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EILSEQ') {
        context.skip('Filesystem rejects non-UTF8 names'); return;
      }
      throw error;
    }
    await writeFile(child.toString('utf8'), 'replacement-twin');
    await rm(child.toString('utf8'));
    expect(await isEmptyStorageFolder(home)).toBe(false);
  });
  it('does not stat ordinary indexed files, while still verifying eligible old downloads', async () => {
    const home = await fixture(); const ordinary = join(home, 'ordinary.bin'); const download = join(home, 'Downloads', 'old.zip');
    await mkdir(join(home, 'Downloads')); await writeFile(ordinary, 'bytes'); await writeFile(download, 'archive');
    const now = Date.now(); const facts = { protection: { homeDir: home }, now, suggestUnusedAfterDays: 30 };
    const stat = vi.mocked(fsPromises.lstat); stat.mockClear();
    try {
      const candidate = { path: ordinary, kind: 'file' as const, size, lastChangedAt: now - 31 * 86_400_000 };
      expect(await recognizeStorageCandidate(candidate, facts)).toBeNull();
      expect(stat).not.toHaveBeenCalled();
      expect(await recognizeStorageCandidate({ ...candidate, path: download }, facts)).toMatchObject({ recognizerId: 'old-download', verdict: 'caution' });
      expect(stat).toHaveBeenCalled();
    } finally { stat.mockClear(); }
  });
  it('rejects kind-ineligible indexed files before checking every offered suggestion root', async () => {
    const home = await fixture(); const now = Date.now();
    const catalog: StorageItemV1[] = Array.from({ length: 22 }, (_, index) => ({
      itemId: `cache-${index}`, path: join(home, `cache-${index}`), title: 'Cache', kind: 'category-item', categoryId: 'caches',
      size, verdict: 'safe', reason: { code: 'reinstalls' }, evidence: ['managed_cache_root'], collectable: true,
    }));
    await Promise.all(catalog.map(item => mkdir(item.path)));
    const download = join(home, 'Downloads', 'old.zip'); await mkdir(join(home, 'Downloads')); await writeFile(download, 'archive');
    const files = 128;
    const candidates = [...Array.from({ length: files }, (_, index) => ({ path: join(home, 'ordinary', `file-${index}`),
      kind: 'file' as const, size, lastChangedAt: now })),
      { path: download, kind: 'file' as const, size, lastChangedAt: now - 31 * 86_400_000 }];
    const suggestions = createStorageSuggestions({ readCatalogItems: async () => catalog,
      readProtectionFacts: () => ({ homeDir: home }), now: () => now,
      readCompletedScan: async () => ({ status: 'complete', scope: 'whole-disk', candidates }) });
    const { Session } = await import('node:inspector'); const profiler = new Session(); profiler.connect();
    const post = (method: string, params: Record<string, unknown> = {}) => new Promise<void>((done, fail) =>
      profiler.post(method, params, error => error ? fail(error) : done()));
    try {
      // V8 observes the real function executions; internal recognition and path
      // decisions remain unmodified, and no per-entry timing threshold is used.
      await post('Profiler.enable'); await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
      const result = await suggestions.list({ callerKind: 'person' });
      const coverage = await new Promise<import('node:inspector').Profiler.TakePreciseCoverageReturnType>((done, fail) =>
        profiler.post('Profiler.takePreciseCoverage', (error, value) => error ? fail(error) : done(value)));
      const containment = coverage.result.filter(script => script.url.endsWith('/storage/storagePath.ts'))
        .flatMap(script => script.functions).find(fn => fn.functionName === 'storagePathContains');
      expect(containment).toBeDefined();
      if (process.env.STO19_PROFILE === '1') console.log(JSON.stringify({ qa: 'sto19-recognizer-eligibility',
        ordinaryFiles: files, offeredRoots: catalog.length, containmentCalls: containment!.ranges[0].count }));
      expect(result.items).toContainEqual(expect.objectContaining({ path: download, evidence: expect.arrayContaining(['recognizer:old-download']) }));
      // Ordinary files have no overlap decision to make; their number cannot
      // multiply containment work by the already-offered roots.
      expect(containment!.ranges[0].count).toBeLessThan(files);
    } finally { await post('Profiler.stopPreciseCoverage'); profiler.disconnect(); }
  });
  it('requires a real sibling manifest and an unused repository for node_modules', async () => {
    const home = await fixture(); const repo = join(home, 'project'); const path = join(repo, 'node_modules'); await mkdir(path, { recursive: true });
    const facts: StorageRecognitionFacts = { protection: { homeDir: home }, now: Date.now(), suggestUnusedAfterDays: 30 };
    const candidate = { path, size, repositoryRoot: repo, repositoryInUse: false };
    expect(await recognizeStorageCandidate(candidate, facts)).toBeNull();
    await writeFile(join(repo, 'package.json'), '{}');
    expect(await recognizeStorageCandidate(candidate, facts)).toMatchObject({ verdict: 'safe', reason: { code: 'reinstalls' } });
    expect(await recognizeStorageCandidate({ ...candidate, repositoryInUse: true }, facts)).toBeNull();
    expect(await recognizeStorageCandidate({ path, size }, facts)).toBeNull();
  });
  it('requires SCM evidence for build output and never mistakes nonignored source for an artifact', async () => {
    const home = await fixture(); const repo = join(home, 'project'); const path = join(repo, 'dist'); await mkdir(path, { recursive: true });
    await writeFile(join(repo, 'package.json'), '{}');
    const candidate = { path, size, repositoryRoot: repo, repositoryInUse: false };
    const facts: StorageRecognitionFacts = { protection: { homeDir: home }, now: Date.now(), suggestUnusedAfterDays: 30, readIgnoredPaths: async () => [] };
    expect(await recognizeStorageCandidate(candidate, facts)).toBeNull();
    expect(await recognizeStorageCandidate(candidate, { ...facts, readIgnoredPaths: async () => ['dist/'] })).toMatchObject({ verdict: 'safe', reason: { code: 'rebuilds' } });
    expect(await recognizeStorageCandidate(candidate, { ...facts, readIgnoredPaths: async () => null })).toBeNull();
  });
  it('uses current catalog verdicts and account declined facts; only agents omit a matching decline', async () => {
    const home = await fixture(); const path = join(home, 'cache'); await mkdir(path);
    let item: StorageItemV1 = { itemId: 'cache', path, title: 'Cache', kind: 'category-item', categoryId: 'caches', size,
      verdict: 'safe', reason: { code: 'reinstalls' }, evidence: ['managed_cache_root'], collectable: true };
    const suggestions = createStorageSuggestions({ readCatalogItems: async () => [item], readProtectionFacts: () => ({ homeDir: home }),
      readDeclined: values => new Set(values.filter(value => value.size.allocatedBytes === 4096).map(value => value.itemId)) });
    expect((await suggestions.list({ callerKind: 'person' })).items).toHaveLength(1);
    expect(await suggestions.list({ callerKind: 'agent' })).toMatchObject({ items: [], declinedCount: 1 });
    item = { ...item, size: { ...size, allocatedBytes: 8192 } };
    expect((await suggestions.list({ callerKind: 'automation' })).items).toHaveLength(1);
    item = { ...item, verdict: 'keep' };
    expect((await suggestions.list({ callerKind: 'person' })).items).toHaveLength(0);
  });
  it('verifies the full ecosystem table against real filesystem facts, rather than names alone', async () => {
    const home = await fixture(); const repo = join(home, 'repo'); await mkdir(repo);
    const rows = [
      ['node_modules', 'package.json', 'node-modules'], ['.next', 'package.json', 'build-output'], ['dist', 'package.json', 'build-output'],
      ['target', 'Cargo.toml', 'build-output'], ['build', 'CMakeLists.txt', 'build-output'], ['DerivedData', 'package.json', 'build-output'],
      ['Pods', 'Podfile', 'cocoapods'], ['Carthage/Build', 'Cartfile', 'carthage-build'], ['__pycache__', 'pyproject.toml', 'python-project-cache'],
      ['.pytest_cache', 'pyproject.toml', 'python-project-cache'], ['.tox', 'pyproject.toml', 'python-project-cache'], ['.turbo', 'package.json', 'turbo-cache'], ['.ccache', 'CMakeLists.txt', 'project-compiler-cache'],
    ];
    for (const [name, manifest, recognizerId] of rows) {
      const project = join(repo, recognizerId, name.replaceAll('/', '-')); const path = join(project, name);
      await mkdir(path, { recursive: true }); await writeFile(join(project, manifest), '{}'); await writeFile(join(path, 'artifact'), 'bytes');
      const result = await recognizeStorageCandidate({ path, size, repositoryRoot: project, repositoryInUse: false }, {
        protection: { homeDir: home }, now: Date.now(), suggestUnusedAfterDays: 30, readIgnoredPaths: async () => [name] });
      expect(result?.recognizerId, name).toBe(recognizerId);
    }
  });
  it('verifies OS package/download/cache locations and old-item policy with real directory fixtures', async () => {
    const home = await fixture(); const now = Date.now(); const local = join(home, 'Local'); const osTemp = join(home, 'os-temp');
    const rows = [
      ['.npm/_cacache', 'npm-cache'], ['.local/share/pnpm/store', 'pnpm-store'], ['.cache/yarn', 'yarn-cache'], ['.cache/uv', 'python-download-cache'], ['.cache/pip', 'python-download-cache'],
      ['.gradle/caches', 'gradle-cache'], ['.cargo/registry', 'cargo-cache'], ['Library/Caches/Homebrew', 'homebrew-cache'], ['Library/Developer/Xcode/DerivedData', 'xcode-derived-data'],
      ['Library/Developer/Xcode/Archives', 'xcode-archives'], ['Library/Developer/Xcode/iOS DeviceSupport', 'ios-device-support'], ['Library/Logs/DiagnosticReports', 'crash-reports'],
      ['Library/Application Support/MobileSync/Backup', 'ios-backups'], ['Library/Developer/CoreSimulator/Devices', 'core-simulator-devices'], ['.m2/repository', 'maven-repository'],
      ['.rustup/toolchains', 'rustup-toolchains'], ['.pub-cache', 'pub-cache'], ...(process.platform === 'linux' ? [['.cache/unknown-tool', 'linux-cache-child']] : []),
      ['Local/Temp/old-job', 'windows-old-temp'], ['os-temp/job', 'macos-temporary'],
    ];
    for (const [name, recognizerId] of rows) {
      const path = join(home, name); await mkdir(path, { recursive: true }); await writeFile(join(path, 'data'), 'bytes');
      const result = await recognizeStorageCandidate({ path, size, lastChangedAt: now - 31 * 86_400_000 }, {
        protection: { homeDir: home, env: { ...process.env, XDG_CACHE_HOME: join(home, '.cache'), LOCALAPPDATA: local } }, now, suggestUnusedAfterDays: 30, osTemporaryRoots: [osTemp] });
      expect(result?.recognizerId, name).toBe(recognizerId);
    }
    const download = join(home, 'Downloads', 'old.zip'); await mkdir(join(home, 'Downloads')); await writeFile(download, 'archive');
    const facts = { protection: { homeDir: home }, now, suggestUnusedAfterDays: 30 };
    expect((await recognizeStorageCandidate({ path: download, size, lastChangedAt: now - 31 * 86_400_000 }, facts))?.verdict).toBe('caution');
    expect(await recognizeStorageCandidate({ path: download, size, lastChangedAt: 0 }, facts)).toBeNull();
    expect((await recognizeStorageCandidate({ path: download, size, lastChangedAt: 1000 }, facts))?.verdict).toBe('caution');
    expect(await recognizeStorageCandidate({ path: download, size, lastChangedAt: now }, facts)).toBeNull();
    const docker = join(home, '.cache', 'docker'); await mkdir(docker);
    expect(await recognizeStorageCandidate({ path: docker, size }, facts)).toBeNull();
  });
  it('recognizes only the content cache under relocated Windows npm data', async () => {
    const home = await fixture(); const local = join(home, 'relocated-local');
    const npmRoot = join(local, 'npm-cache'); const cache = join(npmRoot, '_cacache');
    const installed = join(local, 'npm', 'node_modules'); const other = join(npmRoot, 'user-data');
    for (const path of [cache, installed, other]) {
      await mkdir(path, { recursive: true }); await writeFile(join(path, 'data'), 'bytes');
    }
    const facts: StorageRecognitionFacts = { protection: { homeDir: home, env: { ...process.env, LOCALAPPDATA: local } },
      now: Date.now(), suggestUnusedAfterDays: 30 };
    expect(await recognizeStorageCandidate({ path: cache, size }, facts)).toMatchObject({
      recognizerId: 'npm-cache', verdict: 'safe', evidence: ['verified_cache_location'],
    });
    for (const path of [npmRoot, installed, other]) expect(await recognizeStorageCandidate({ path, size }, facts), path).toBeNull();
    const hints = await readStorageScanHints({ root: home, facts, repositoryRoots: [] });
    expect(hints.priorityHints).toContain(cache);
    expect(hints.priorityHints).not.toContain(npmRoot);
  });
  it('requires a verified browser profile and keeps credentials while rebuilding only caches', async () => {
    const home = await fixture(); const profile = join(home, 'browser', 'Default'); await mkdir(profile, { recursive: true }); await writeFile(join(profile, 'Preferences'), '{}');
    const facts = { protection: { homeDir: home }, now: Date.now(), suggestUnusedAfterDays: 30 };
    for (const name of ['Cache', 'Code Cache', 'GPUCache', 'CacheStorage', 'Cookies', 'Local Storage']) {
      const path = join(profile, name); await mkdir(path); await writeFile(join(path, 'data'), 'bytes');
      const result = await recognizeStorageCandidate({ path, size, browserProfileRoot: profile }, facts);
      expect(result?.verdict ?? null, name).toBe(['Cookies', 'Local Storage'].includes(name) ? null : 'safe');
    }
    expect(await recognizeStorageCandidate({ path: join(profile, 'Cache'), size }, facts)).toBeNull();
  });
  it('reads each repository ignore set once and collapses rechecked nested empty folders only from a completed whole-disk snapshot', async () => {
    const home = await fixture(); const repo = join(home, 'repo'); await mkdir(repo); await writeFile(join(repo, 'package.json'), '{}');
    const candidates = ['dist', '.next', 'empty', 'empty/child'].map(name => ({ nodeId: join(repo, name), path: join(repo, name), size, repositoryRoot: repo, repositoryInUse: false }))
      .sort((left, right) => right.path.length - left.path.length);
    for (const candidate of candidates) await mkdir(candidate.path, { recursive: true });
    await writeFile(join(repo, 'dist', 'bytes'), 'data'); await writeFile(join(repo, '.next', 'bytes'), 'data');
    await writeFile(join(repo, 'empty', '.DS_Store'), 'metadata');
    let reads = 0;
    const service = createStorageSuggestions({ readCatalogItems: async () => [], readProtectionFacts: () => ({ homeDir: home }),
      readCompletedScan: async () => ({ status: 'complete', scope: 'whole-disk', candidates }), readIgnoredPaths: async () => { reads += 1; return ['dist/', '.next/']; } });
    const listed = await service.list({ callerKind: 'person' });
    expect(reads).toBe(1); expect(listed.items.map(item => item.path).sort()).toEqual([join(repo, '.next'), join(repo, 'dist'), join(repo, 'empty')].sort());
    expect(listed.items.every(item => item.itemId === item.path)).toBe(true);
    await writeFile(join(repo, 'empty', 'child', 'important'), 'data');
    expect((await service.list({ callerKind: 'person' })).items.map(item => item.path)).not.toContain(join(repo, 'empty'));
    expect((await createStorageSuggestions({ readCatalogItems: async () => [], readProtectionFacts: () => ({ homeDir: home }) }).list({ callerKind: 'person' })).items).toEqual([]);
  });
});
