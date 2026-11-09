import { MachineStoragePolicyV1Schema, type DiskNodeV1, type StorageItemV1, type StorageSizeV1, type StorageReasonV1, type StorageEvidenceV1 } from '@happier-dev/protocol/storage/storageV1';
import type { StorageProtectionFacts } from '../protection/protectedPaths';
import { classifyPath, classifyPaths } from '../protection/protectedPaths';
import { lstat, readdir, stat } from 'node:fs/promises';
import { storagePathBasename as basename, storagePathDirname as dirname, storagePathJoin as join,
  createStoragePathIndex, storagePathsEqual as canonicalAbsolutePathsEqual, storagePathContains, storagePathToFs } from '../storagePath';
import type { NativeDiskScanRequest } from '../measure/nativeDiskMeasure';
import type { StoragePathUse } from '../categories/types';

export type StorageSuggestionGroup = 'can-be-rebuilt' | 'old-and-unused' | 'outside-happier';
export type StorageRecognitionCandidate = Readonly<{
  /** Native index identity, not a recognizer-generated item identity. */
  nodeId?: string;
  /** Trusted native kind permits cheap rule selection before any per-file OS read. */
  kind?: DiskNodeV1['kind'];
  path: string;
  size: StorageSizeV1;
  lastChangedAt?: number;
  repositoryRoot?: string;
  /** An authenticated live-work owner supplies this; absent/unknown never proves unused. */
  repositoryInUse?: boolean;
  browserProfileRoot?: string;
}>;
/** Scan discovery and retained summary projection use the same live repository facts. */
export function storageCandidateRepositoryFacts(path: string, repositoryRoots: readonly string[],
  use: StoragePathUse | undefined): Pick<StorageRecognitionCandidate, 'repositoryRoot' | 'repositoryInUse'> {
  const repositoryRoot = repositoryRoots.filter(root => storagePathContains(root, path))
    .sort((left, right) => right.length - left.length)[0];
  const repositoryInUse = repositoryRoot && use?.reliable === true
    ? use.paths.some(path => storagePathContains(repositoryRoot, path) || storagePathContains(path, repositoryRoot))
      || (use.cwdPaths ?? []).some(cwd => storagePathContains(repositoryRoot, cwd)) : undefined;
  return { repositoryRoot, repositoryInUse };
}
export type StorageRecognitionFacts = Readonly<{
  protection: StorageProtectionFacts;
  now: number;
  suggestUnusedAfterDays: number;
  /** OS-native temporary locations, supplied by the environment boundary. */
  osTemporaryRoots?: readonly string[];
  /** Current invocation's already relisted empty descendants, from the completed index. */
  verifiedEmptyFolders?: ReadonlySet<string>;
  readIgnoredPaths?: (repositoryRoot: string) => Promise<readonly string[] | null>;
}>;
export type StorageRecognitionResult = Readonly<{
  recognizerId: string; group: StorageSuggestionGroup; verdict: 'safe' | 'caution'; reason: StorageReasonV1; evidence: StorageEvidenceV1[];
}>;
type RecognitionRule = Readonly<{
  id: string;
  names?: readonly string[];
  manifests?: readonly string[];
  parentName?: string;
  manifestParentLevel?: number;
  ignored?: boolean;
  unusedRepository?: boolean;
  paths?: (facts: StorageRecognitionFacts) => readonly string[];
  children?: boolean;
  browser?: boolean;
  old?: boolean;
  empty?: boolean;
  verdict: 'safe' | 'caution';
  code: StorageReasonV1['code'];
}>;
const homePaths = (...parts: string[]) => (facts: StorageRecognitionFacts) => parts.map(part => join(facts.protection.homeDir, part));
const cacheBase = (facts: Pick<StorageRecognitionFacts, 'protection'>) => (facts.protection.env ?? process.env).XDG_CACHE_HOME ?? join(facts.protection.homeDir, '.cache');
const localAppData = (facts: Pick<StorageRecognitionFacts, 'protection'>) => (facts.protection.env ?? process.env).LOCALAPPDATA ?? join(facts.protection.homeDir, 'AppData', 'Local');
const downloadsRoot = (facts: Pick<StorageRecognitionFacts, 'protection'>) => facts.protection.knownFolders?.Downloads ?? join(facts.protection.homeDir, 'Downloads');

/** Shortcut and recognizer paths share the same daemon authority. Historical paths are not existence facts. */
export async function resolveStorageScanShortcuts(facts: Pick<StorageRecognitionFacts, 'protection'>, knownPaths: readonly string[] = []) {
  const platform = facts.protection.platform ?? process.platform;
  const cache = platform === 'darwin' ? join(facts.protection.homeDir, 'Library', 'Caches')
    : platform === 'win32' ? localAppData(facts) : cacheBase(facts);
  const candidates = [{ kind: 'downloads' as const, path: downloadsRoot(facts) }, { kind: 'cache' as const, path: cache },
    ...knownPaths.map(path => ({ kind: 'folder' as const, path }))];
  const pathIndex = createStoragePathIndex(candidates, candidate => candidate.path, platform);
  const unique = candidates.filter(candidate => pathIndex.exact(candidate.path) === candidate);
  const folders = await Promise.all(unique.map(async candidate => {
    try { return (await stat(storagePathToFs(candidate.path))).isDirectory(); }
    // Shortcut candidates are optional; an unusable folder must not prevent
    // the measured Storage inventory or its valid peer shortcuts from loading.
    catch { return false; }
  }));
  return unique.filter((_candidate, index) => folders[index]);
}
const pythonManifests = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
const projectManifests = ['package.json', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Makefile', ...pythonManifests];

/** One verified table; OS cache paths come from the same home/environment facts as protection. */
export const STORAGE_RECOGNIZERS: readonly RecognitionRule[] = [
  { id: 'node-modules', names: ['node_modules'], manifests: ['package.json'], unusedRepository: true, verdict: 'safe', code: 'reinstalls' },
  { id: 'build-output', names: ['.next', 'dist', 'target', 'build', 'DerivedData'], manifests: projectManifests, ignored: true, unusedRepository: true, verdict: 'safe', code: 'rebuilds' },
  { id: 'cocoapods', names: ['Pods'], manifests: ['Podfile'], unusedRepository: true, verdict: 'safe', code: 'reinstalls' },
  { id: 'carthage-build', names: ['Build'], parentName: 'Carthage', manifestParentLevel: 2, manifests: ['Cartfile', 'Cartfile.resolved'], unusedRepository: true, verdict: 'safe', code: 'rebuilds' },
  { id: 'python-project-cache', names: ['__pycache__', '.pytest_cache', '.tox'], manifests: pythonManifests, unusedRepository: true, verdict: 'safe', code: 'rebuilds' },
  { id: 'turbo-cache', names: ['.turbo'], manifests: ['package.json'], unusedRepository: true, verdict: 'safe', code: 'rebuilds' },
  { id: 'project-compiler-cache', names: ['.ccache'], manifests: projectManifests, unusedRepository: true, verdict: 'safe', code: 'rebuilds' },
  { id: 'npm-cache', paths: facts => [join(facts.protection.homeDir, '.npm/_cacache'), join(localAppData(facts), 'npm-cache/_cacache')], verdict: 'safe', code: 'reinstalls' },
  { id: 'pnpm-store', paths: facts => [join(facts.protection.homeDir, '.local/share/pnpm/store'), join(facts.protection.homeDir, 'Library/pnpm/store'), join(localAppData(facts), 'pnpm/store')], verdict: 'safe', code: 'reinstalls' },
  { id: 'yarn-cache', paths: facts => [join(cacheBase(facts), 'yarn'), join(facts.protection.homeDir, 'Library/Caches/Yarn'), join(localAppData(facts), 'Yarn/Cache')], verdict: 'safe', code: 'reinstalls' },
  { id: 'python-download-cache', paths: facts => ['uv', 'pip'].flatMap(name => [join(cacheBase(facts), name), join(facts.protection.homeDir, 'Library/Caches', name), join(localAppData(facts), name, 'Cache')]), verdict: 'safe', code: 'reinstalls' },
  { id: 'gradle-cache', paths: homePaths('.gradle/caches'), verdict: 'safe', code: 'reinstalls' },
  { id: 'cargo-cache', paths: homePaths('.cargo/registry', '.cargo/git'), verdict: 'safe', code: 'reinstalls' },
  { id: 'homebrew-cache', paths: homePaths('Library/Caches/Homebrew'), verdict: 'safe', code: 'downloads_again' },
  { id: 'xcode-derived-data', paths: homePaths('Library/Developer/Xcode/DerivedData'), verdict: 'safe', code: 'rebuilds' },
  { id: 'xcode-archives', paths: homePaths('Library/Developer/Xcode/Archives'), verdict: 'caution', code: 'not_rebuildable' },
  { id: 'ios-device-support', paths: homePaths('Library/Developer/Xcode/iOS DeviceSupport'), verdict: 'safe', code: 'downloads_again' },
  { id: 'crash-reports', paths: facts => [join(facts.protection.homeDir, 'Library/Logs/DiagnosticReports'), join(localAppData(facts), 'CrashDumps')], verdict: 'safe', code: 'old' },
  { id: 'ios-backups', paths: facts => [join(facts.protection.homeDir, 'Library/Application Support/MobileSync/Backup'), join(facts.protection.env?.APPDATA ?? join(facts.protection.homeDir, 'AppData/Roaming'), 'Apple Computer/MobileSync/Backup')], verdict: 'caution', code: 'not_rebuildable' },
  { id: 'old-download', paths: facts => [downloadsRoot(facts)], children: true, old: true, verdict: 'caution', code: 'not_rebuildable' },
  { id: 'core-simulator-devices', paths: homePaths('Library/Developer/CoreSimulator/Devices'), verdict: 'caution', code: 'not_rebuildable' },
  { id: 'maven-repository', paths: homePaths('.m2/repository'), verdict: 'safe', code: 'reinstalls' },
  { id: 'rustup-toolchains', paths: homePaths('.rustup/toolchains'), verdict: 'caution', code: 'downloads_again' },
  { id: 'pub-cache', paths: homePaths('.pub-cache'), verdict: 'safe', code: 'reinstalls' },
  { id: 'browser-cache', names: ['Cache', 'Code Cache', 'GPUCache', 'CacheStorage'], browser: true, verdict: 'safe', code: 'rebuilds' },
  { id: 'linux-cache-child', paths: facts => (facts.protection.platform ?? process.platform) === 'linux' ? [cacheBase(facts)] : [], children: true, verdict: 'caution', code: 'not_rebuildable' },
  { id: 'windows-old-temp', paths: facts => facts.protection.env?.LOCALAPPDATA || (facts.protection.platform ?? process.platform) === 'win32' ? [join(localAppData(facts), 'Temp')] : [], children: true, old: true, verdict: 'safe', code: 'old' },
  { id: 'macos-temporary', paths: facts => facts.osTemporaryRoots ?? ((facts.protection.platform ?? process.platform) === 'darwin' ? ['/private/var/folders'] : []), children: true, verdict: 'caution', code: 'not_rebuildable' },
  { id: 'empty-folder', empty: true, verdict: 'safe', code: 'rebuilds' },
];

/** Scan summaries describe verified artifacts, independently of cleanup permission.
 * Names/manifests come from the same table; ignored outputs require the SCM owner's
 * positive path evidence. The native walker verifies manifests without a second walk.
 */
export async function readStorageScanHints(input: Readonly<{ root: string; facts: StorageRecognitionFacts;
  repositoryRoots: readonly string[] }>): Promise<Pick<NativeDiskScanRequest, 'atomicRules' | 'priorityHints'>> {
  const atomicRules: NonNullable<NativeDiskScanRequest['atomicRules']>[number][] = [];
  const priorityHints = new Set<string>();
  const ignored = await Promise.all(input.repositoryRoots.filter(root => storagePathContains(input.root, root)
    || storagePathContains(root, input.root)).map(async root => ({ root, paths: await input.facts.readIgnoredPaths?.(root) ?? [] })));
  for (const rule of STORAGE_RECOGNIZERS) {
    if (rule.empty || rule.old || rule.browser || rule.children) continue;
    const named = rule.names === undefined ? {} : { names: rule.names };
    const manifest = rule.manifests === undefined ? {} : { manifests: rule.manifests,
      ...(rule.manifestParentLevel === undefined ? {} : { manifestParentLevel: rule.manifestParentLevel }) };
    const parent = rule.parentName === undefined ? {} : { parentName: rule.parentName };
    if (rule.ignored) {
      const paths = ignored.flatMap(repository => repository.paths.map(path => join(repository.root, path.replace(/[\\/]+$/u, ''))))
        .filter(path => rule.names?.includes(basename(path)) && storagePathContains(input.root, path));
      if (paths.length) { atomicRules.push({ ...named, ...manifest, ...parent, paths }); paths.forEach(path => priorityHints.add(path)); }
    } else if (rule.paths) {
      const paths = rule.paths(input.facts).filter(path => storagePathContains(input.root, path));
      if (paths.length) { atomicRules.push({ paths }); paths.forEach(path => priorityHints.add(path)); }
    } else if (rule.names && rule.manifests) {
      atomicRules.push({ ...named, ...manifest, ...parent });
    }
  }
  return { atomicRules, priorityHints: [...priorityHints] };
}

function absent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
async function names(path: string): Promise<readonly Buffer[] | null> {
  try { return await readdir(storagePathToFs(path), { encoding: 'buffer' }); } catch (error) { if (absent(error) || (error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') return null; throw error; }
}
async function hasManifest(parent: string, manifests: readonly string[]): Promise<string | null> {
  for (const name of manifests) {
    try { const entry = await lstat(storagePathToFs(join(parent, name))); if (entry.isFile() && !entry.isSymbolicLink()) return name; }
    catch (error) { if (!absent(error)) throw error; }
  }
  return null;
}
function contained(root: string, path: string): boolean {
  return storagePathContains(root, path);
}
/** Direct folder relist only. No scan or recursive filesystem walk is manufactured here. */
export async function isEmptyStorageFolder(path: string, verifiedEmptyFolders: ReadonlySet<string> = new Set()): Promise<boolean> {
  const children = await names(path);
  if (!children) return false;
  for (const name of children) {
    const child = await lstat(storagePathToFs(join(path, name)));
    if (child.isSymbolicLink()) return false;
    if (child.isDirectory() && verifiedEmptyFolders.has(join(path, name))) continue;
    if (!child.isFile() || !['.DS_Store', 'Thumbs.db', 'desktop.ini'].some(metadata => name.equals(Buffer.from(metadata)))) return false;
  }
  return true;
}
function canRecognizeStorageCandidate(candidate: StorageRecognitionCandidate, facts: StorageRecognitionFacts): boolean {
  if (candidate.size.atLeast || candidate.repositoryInUse === true) return false;
  return candidate.kind === undefined || candidate.kind === 'folder'
    || STORAGE_RECOGNIZERS.some(rule => rule.old && rule.paths?.(facts).some(path => rule.children
      ? canonicalAbsolutePathsEqual(dirname(candidate.path), path) : canonicalAbsolutePathsEqual(candidate.path, path)));
}
export async function recognizeStorageCandidate(candidate: StorageRecognitionCandidate, facts: StorageRecognitionFacts): Promise<StorageRecognitionResult | null> {
  if (!canRecognizeStorageCandidate(candidate, facts)) return null;
  let entry; try { entry = await lstat(storagePathToFs(candidate.path)); } catch (error) { if (absent(error)) return null; throw error; }
  if (entry.isSymbolicLink()) return null;
  const protection = await classifyPath(candidate.path, { ...facts.protection, browserProfileRoots: [
    ...(facts.protection.browserProfileRoots ?? []), ...(candidate.browserProfileRoot ? [candidate.browserProfileRoot] : [])] });
  if (protection.tier === 'keep' || protection.tier === 'forbidden') return null;
  // Docker owns its data. Specific failed recognizers never gain authority from the empty-folder fallback.
  if (['docker', 'containers'].includes(basename(candidate.path).toLowerCase())) return null;
  const specificName = STORAGE_RECOGNIZERS.some(rule => rule.names?.includes(basename(candidate.path)));
  for (const rule of STORAGE_RECOGNIZERS) {
    if (rule.empty && specificName) continue;
    if (rule.names && !rule.names.includes(basename(candidate.path))) continue;
    if (rule.parentName && basename(dirname(candidate.path)) !== rule.parentName) continue;
    if (rule.paths && !rule.paths(facts).some(path => rule.children
      ? canonicalAbsolutePathsEqual(dirname(candidate.path), path) : canonicalAbsolutePathsEqual(candidate.path, path))) continue;
    if (rule.unusedRepository && (!candidate.repositoryRoot || candidate.repositoryInUse !== false || !contained(candidate.repositoryRoot, candidate.path))) continue;
    if (!entry.isDirectory() && !rule.old) continue;
    const evidence: StorageEvidenceV1[] = [];
    if (rule.manifests) {
      let parent = candidate.path;
      for (let level = 0; level < (rule.manifestParentLevel ?? 1); level += 1) parent = dirname(parent);
      const manifest = await hasManifest(parent, rule.manifests);
      if (!manifest) continue;
      evidence.push(`manifest:${manifest}`);
    }
    if (rule.ignored) {
      if (!candidate.repositoryRoot || !facts.readIgnoredPaths) continue;
      const ignored = await facts.readIgnoredPaths(candidate.repositoryRoot);
      if (!ignored?.some(path => contained(join(candidate.repositoryRoot!, path), candidate.path))) continue;
      evidence.push('scm_ignored');
    }
    if (rule.browser) {
      const profile = candidate.browserProfileRoot;
      if (!profile || !contained(profile, candidate.path) || !await hasManifest(profile, ['Preferences', 'prefs.js'])) continue;
      evidence.push('browser_profile_cache');
    }
    if (rule.old) {
      const changed = candidate.lastChangedAt;
      if (changed === undefined || !Number.isFinite(changed) || changed <= 0 || changed > facts.now - facts.suggestUnusedAfterDays * 86_400_000) continue;
      evidence.push('unused_after_policy');
    }
    if (rule.empty && !await isEmptyStorageFolder(candidate.path, facts.verifiedEmptyFolders)) continue;
    if (rule.unusedRepository) evidence.push('repository_not_in_use');
    if (rule.paths) evidence.push('verified_cache_location');
    if (rule.empty) evidence.push('empty_folder_relisted');
    return { recognizerId: rule.id, group: 'outside-happier',
      verdict: protection.tier === 'caution' ? 'caution' : rule.verdict,
      reason: protection.tier === 'caution' ? protection.reason : { code: rule.code }, evidence };
  }
  return null;
}
export type CompletedStorageSuggestionScan = Readonly<{
  /** The index supplies descendants before parents without materializing the whole tree. */
  status: 'complete'; scope: 'whole-disk'; candidates: Iterable<StorageRecognitionCandidate>;
}>;
export type StorageSuggestionsDeps = Readonly<{
  readCatalogItems: () => Promise<readonly StorageItemV1[]>;
  readProtectionFacts: () => StorageProtectionFacts | Promise<StorageProtectionFacts>;
  readCompletedScan?: () => Promise<CompletedStorageSuggestionScan | null>;
  readIgnoredPaths?: StorageRecognitionFacts['readIgnoredPaths'];
  readDeclined?: (items: readonly StorageItemV1[]) => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  volumeForPath?: (path: string) => string | undefined;
  now?: () => number;
  suggestUnusedAfterDays?: () => number;
}>;
type StorageSuggestionListOptions = Readonly<{ callerKind: 'person' | 'agent' | 'automation'; group?: StorageSuggestionGroup; quickestForVolume?: string }>;
type Suggestion = Readonly<{ item: StorageItemV1; group: StorageSuggestionGroup }>;
export function createStorageSuggestions(deps: StorageSuggestionsDeps) {
  async function project(items: readonly StorageItemV1[], protection: StorageProtectionFacts): Promise<Suggestion[]> {
    const candidates: Suggestion[] = [];
    const eligible = items.filter(item => item.collectable && !item.size.atLeast && (item.verdict === 'safe' || item.verdict === 'caution'));
    const classifications = await classifyPaths(eligible.map(item => ({ path: item.path,
      ...(item.categoryId === undefined ? {} : { managedItemPath: item.path }) })), protection);
    for (const [index, item] of eligible.entries()) {
      const classified = classifications[index];
      if (classified.tier === 'keep' || classified.tier === 'forbidden') continue;
      candidates.push({ item: { ...item, ...(classified.tier === 'caution' ? { verdict: 'caution', reason: classified.reason } : {}) },
        group: item.categoryId === undefined ? 'outside-happier'
          : ['rebuilds', 'reinstalls', 'downloads_again'].includes(item.reason.code) ? 'can-be-rebuilt' : 'old-and-unused' });
    }
    return candidates;
  }
  async function select(candidates: readonly Suggestion[], options: StorageSuggestionListOptions) {
    const selected = candidates.filter(({ item, group }) => (!options.group || options.group === group)
      && (!options.quickestForVolume || item.verdict === 'safe' && deps.volumeForPath?.(item.path) === options.quickestForVolume));
    const declined = options.callerKind !== 'person' && selected.length > 0
      ? await deps.readDeclined?.(selected.map(({ item }) => item)) : undefined;
    const items: StorageItemV1[] = []; let declinedCount = 0;
    for (const { item } of selected) {
      if (declined?.has(item.itemId)) { declinedCount += 1; continue; }
      items.push(item);
    }
    return { items: items.sort((left, right) => right.size.freesBytes - left.size.freesBytes || left.path.localeCompare(right.path)), declinedCount };
  }
  return {
    /** Keep recognition as-of sizedAt while refreshing protection and Account declines. */
    async projectSnapshot(items: readonly StorageItemV1[], options: StorageSuggestionListOptions) {
      return select(await project(items, await deps.readProtectionFacts()), options);
    },
    async list(options: StorageSuggestionListOptions) {
    const [catalog, protection, scan] = await Promise.all([deps.readCatalogItems(), deps.readProtectionFacts(), deps.readCompletedScan?.() ?? null]);
    const candidates = await project(catalog, protection);
    // A completed whole-disk index is the only producer of outside-Happier candidates.
    if (scan?.status === 'complete' && scan.scope === 'whole-disk') {
      const ignoredByRepository = new Map<string, Promise<readonly string[] | null>>();
      const verifiedEmptyFolders = new Set<string>();
      const facts: StorageRecognitionFacts = { protection, now: deps.now?.() ?? Date.now(),
        suggestUnusedAfterDays: deps.suggestUnusedAfterDays?.() ?? MachineStoragePolicyV1Schema.parse({}).suggestUnusedAfterDays,
        verifiedEmptyFolders,
        readIgnoredPaths: deps.readIgnoredPaths ? repositoryRoot => {
          let read = ignoredByRepository.get(repositoryRoot);
          if (!read) { read = deps.readIgnoredPaths!(repositoryRoot); ignoredByRepository.set(repositoryRoot, read); }
          return read;
        } : undefined };
      for (const candidate of scan.candidates) {
        if (!canRecognizeStorageCandidate(candidate, facts)) continue;
        if (candidates.some(value => contained(value.item.path, candidate.path))) continue;
        const recognized = await recognizeStorageCandidate(candidate, facts);
        if (!recognized) continue;
        if (recognized.recognizerId === 'empty-folder') {
          verifiedEmptyFolders.add(candidate.path);
          for (let index = candidates.length - 1; index >= 0; index -= 1) {
            if (contained(candidate.path, candidates[index].item.path)
              && candidates[index].item.evidence.includes('empty_folder_relisted')) candidates.splice(index, 1);
          }
        }
        candidates.push({ group: recognized.group, item: {
          itemId: candidate.nodeId ?? candidate.path, kind: 'suggestion', path: candidate.path,
          title: basename(candidate.path), size: candidate.size, verdict: recognized.verdict, reason: recognized.reason,
          evidence: [`recognizer:${recognized.recognizerId}`, ...recognized.evidence], collectable: true,
          ...(candidate.lastChangedAt !== undefined ? { lastChangedAt: candidate.lastChangedAt } : {}),
        } });
      }
    }
    return select(candidates, options);
  } };
}
