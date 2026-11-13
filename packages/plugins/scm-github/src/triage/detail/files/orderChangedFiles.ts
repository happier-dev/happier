import type { GithubProjectedChangedFileRowV1 } from '../projection.js';

/**
 * The one source-local ordering owner for the GitHub changed-file list.
 *
 * GitHub returns changed files in an order that is stable but not useful: a
 * reader opening a pull request wants the code first, the tests that go with it
 * beside them, and the lockfile churn last. This module states that reading
 * order once, deterministically, and hands the result to the public Plugin UI
 * `List` grouping owner.
 *
 * It creates no tree, no generic ordering framework and no second file model.
 * The projector supplies only directly readable relative import declarations,
 * never patch bodies. Missing or ambiguous evidence keeps lexical ordering.
 *
 * Every rule below is a recognition rule, never a guess. A test file whose
 * source counterpart is not in this pull request stays in the test band rather
 * than being attached to a source file it merely resembles, because an invented
 * pairing changes what a reviewer believes they are reading.
 */

export type GithubChangedFileBandV1 = 'source' | 'test' | 'generated';

export type GithubOrderedChangedFileV1<TRow extends GithubProjectedChangedFileRowV1 = GithubProjectedChangedFileRowV1> = Readonly<{
  row: TRow;
  band: GithubChangedFileBandV1;
  /** The source path this test is recognizably paired with, when there is one. */
  pairedSourcePath: string | null;
}>;

export type GithubChangedFileSectionV1<TRow extends GithubProjectedChangedFileRowV1 = GithubProjectedChangedFileRowV1> = Readonly<{
  band: GithubChangedFileBandV1;
  title: string;
  rows: readonly TRow[];
}>;

const BAND_TITLES: Readonly<Record<GithubChangedFileBandV1, string>> = Object.freeze({
  source: 'Source',
  test: 'Tests',
  generated: 'Generated and lockfiles',
});

/** Directory names whose contents are produced rather than written. */
const GENERATED_SEGMENTS: ReadonlySet<string> = new Set([
  '__generated__',
  '__snapshots__',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'vendor',
]);

/** Whole file names that are machine-maintained wherever they appear. */
const GENERATED_FILE_NAMES: ReadonlySet<string> = new Set([
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock',
]);

const GENERATED_SUFFIXES: readonly string[] = Object.freeze([
  '.lock',
  '.map',
  '.min.js',
  '.min.css',
  '.snap',
]);

/** Directory names that mean "this tree is tests". */
const TEST_SEGMENTS: ReadonlySet<string> = new Set([
  '__tests__',
  'e2e',
  'spec',
  'test',
  'tests',
]);

/**
 * The test markers this recognizer accepts inside a base name.
 *
 * They are the conventions that actually appear in first-party and third-party
 * repositories; a name that carries none of them is not treated as a test on the
 * strength of resembling one.
 */
const TEST_MARKERS: readonly string[] = Object.freeze([
  '.test',
  '.spec',
  '_test',
  '-test',
  '_spec',
  '-spec',
]);

/** Separators unified and a leading `./` removed; the path itself is untouched. */
function normalizePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function segmentsOf(path: string): readonly string[] {
  return normalizePath(path).split('/').filter((segment) => segment.length > 0);
}

function baseNameOf(path: string): string {
  const segments = segmentsOf(path);
  return segments[segments.length - 1] ?? '';
}

function directoryOf(path: string): string {
  const segments = segmentsOf(path);
  return segments.slice(0, -1).join('/');
}

/**
 * The base name with its FINAL extension removed: `pump.test.ts` becomes
 * `pump.test`, and `pump.ts` becomes `pump`.
 *
 * Stripping only the last one is what makes a test marker visible: removing
 * every extension would reduce `pump.test.ts` to `pump`, and the recognizer
 * would then classify every test in the repository as source. A dotfile keeps
 * its whole name, because its leading dot is not an extension.
 */
function withoutExtension(baseName: string): string {
  const lastDot = baseName.lastIndexOf('.');
  return lastDot > 0 ? baseName.slice(0, lastDot) : baseName;
}

function isGenerated(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  const segments = normalized.split('/');
  const baseName = segments[segments.length - 1] ?? '';
  if (GENERATED_FILE_NAMES.has(baseName)) return true;
  if (GENERATED_SUFFIXES.some((suffix) => baseName.endsWith(suffix))) return true;
  if (baseName.includes('.generated.')) return true;
  return segments.slice(0, -1).some((segment) => GENERATED_SEGMENTS.has(segment));
}

function isTest(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  const segments = normalized.split('/');
  const baseName = segments[segments.length - 1] ?? '';
  const stem = withoutExtension(baseName);
  if (TEST_MARKERS.some((marker) => stem.endsWith(marker))) return true;
  return segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment));
}

export function classifyGithubChangedFile(path: string): GithubChangedFileBandV1 {
  // Generated is decided first: a snapshot inside `__tests__` is machine output,
  // and reading it as a test would put churn in the band a reviewer reads.
  if (isGenerated(path)) return 'generated';
  return isTest(path) ? 'test' : 'source';
}

/** The source base name a test base name is named after, or `null`. */
function sourceStemOfTest(path: string): string | null {
  const stem = withoutExtension(baseNameOf(path));
  const lowered = stem.toLowerCase();
  for (const marker of TEST_MARKERS) {
    if (lowered.endsWith(marker) && lowered.length > marker.length) {
      return stem.slice(0, stem.length - marker.length);
    }
  }
  return null;
}

/** Deterministic path comparison: code-unit order over the normalized path. */
function comparePaths(left: string, right: string): number {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Only complete single-line JS/TS static imports in added/context patch lines. */
export function readGithubChangedFileImportSpecifiers(path: string, patch: unknown): readonly string[] {
  if (typeof patch !== 'string' || !/\.[cm]?[jt]sx?$/u.test(path)) return [];
  const imports = new Set<string>();
  let inHunk = false;
  let inComment = false;
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith('@@')) { inHunk = true; inComment = false; continue; }
    if (!inHunk || (line[0] !== '+' && line[0] !== ' ') || line.startsWith('+++')) continue;
    const statement = line.slice(1).trim();
    if (inComment) { if (statement.includes('*/')) inComment = false; continue; }
    if (statement.startsWith('/*')) { inComment = !statement.includes('*/'); continue; }
    const match = /^import\s+(?:(?:type\s+)?[\w$*{}, \t]+\s+from\s+)?(['"])(\.{1,2}\/[^'"\r\n\\]+)\1\s*;?\s*(?:\/\/.*)?$/u.exec(statement);
    if (match?.[2]) imports.add(match[2]);
  }
  return [...imports].sort(comparePaths);
}

/** Resolve only an unambiguous changed JS/TS path; no aliases or repository scan. */
function importedSourcePath(importer: string, specifier: string, sourcePaths: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const segments = [...directoryOf(importer).split('/'), ...specifier.split('/')];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (normalized.length === 0) return null; normalized.pop(); }
    else normalized.push(segment);
  }
  const base = normalized.join('/');
  if (sourcePaths.has(base)) return base;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
  const candidates = /\.[^/]+$/u.test(base)
    ? /\.[cm]?js$/u.test(base)
      ? [base.replace(/\.js$/u, '.ts').replace(/\.mjs$/u, '.mts').replace(/\.cjs$/u, '.cts')]
      : []
    : extensions.flatMap((extension) => [base + extension, `${base}/index${extension}`]);
  const matches = candidates.filter((candidate) => sourcePaths.has(candidate));
  return matches.length === 1 ? matches[0]! : null;
}

function orderSourcePaths(rows: readonly GithubProjectedChangedFileRowV1[]): readonly string[] {
  const lexical = rows.map((row) => row.path).sort(comparePaths);
  const normalizedPaths = new Set(lexical.map(normalizePath));
  const dependencies = new Map(rows.map((row) => [row.path, new Set(
    (row.importSpecifiers ?? []).flatMap((specifier) => {
      const path = importedSourcePath(row.path, specifier, normalizedPaths);
      return path === null || path === normalizePath(row.path) ? [] : [path];
    }),
  )]));
  const remaining = new Set(lexical);
  const ordered: string[] = [];
  const emitted = new Set<string>();
  while (remaining.size > 0) {
    const next = lexical.find((path) => remaining.has(path)
      && [...dependencies.get(path)!].every((dependency) => emitted.has(dependency)));
    // A cycle cannot supply a truthful dependency order; retain the stable
    // lexical band rather than let provider arrival order break the tie.
    if (next === undefined) return lexical;
    remaining.delete(next);
    emitted.add(normalizePath(next));
    ordered.push(next);
  }
  return ordered;
}

/**
 * Finds the changed source path a changed test is recognizably paired with.
 *
 * Recognizable means the test's own base name names it. The nearest match wins —
 * same directory first, then the closest enclosing directory — and ties are
 * broken by path order, so the pairing is a function of the changed set and not
 * of the order GitHub happened to return it in. A test whose counterpart is not
 * in this pull request pairs with nothing.
 */
function findPairedSourcePath(
  testPath: string,
  sourcePaths: readonly string[],
): string | null {
  const stem = sourceStemOfTest(testPath);
  if (stem === null || stem === '') return null;
  const loweredStem = stem.toLowerCase();
  const testDirectory = directoryOf(testPath);

  let best: Readonly<{ path: string; distance: number }> | null = null;
  for (const candidate of sourcePaths) {
    if (withoutExtension(baseNameOf(candidate)).toLowerCase() !== loweredStem) continue;
    const candidateDirectory = directoryOf(candidate);
    const distance = candidateDirectory === testDirectory
      ? 0
      : testDirectory.startsWith(`${candidateDirectory}/`) || candidateDirectory === ''
        ? 1
        : 2;
    if (
      best === null
      || distance < best.distance
      || (distance === best.distance && comparePaths(candidate, best.path) < 0)
    ) {
      best = Object.freeze({ path: candidate, distance });
    }
  }
  return best?.path ?? null;
}

/**
 * Orders one changed-file set into its deterministic reading order.
 *
 * Sources and their paired tests run first, then unpaired tests, then generated output. Source dependencies
 * precede their importers when the patch proves the relationship; otherwise
 * normalized path order breaks ties. Generated paths stay lexical. A paired test immediately follows its source; an unpaired test stays in the test band.
 */
export function orderGithubChangedFiles<TRow extends GithubProjectedChangedFileRowV1>(
  rows: readonly TRow[],
): readonly GithubOrderedChangedFileV1<TRow>[] {
  const banded = rows.map((row) => Object.freeze({
    row,
    band: classifyGithubChangedFile(row.path),
  }));

  const sourcePaths = orderSourcePaths(banded
    .filter((entry) => entry.band === 'source')
    .map((entry) => entry.row));
  const sourceRank = new Map<string, number>(
    sourcePaths.map((path, index) => [path, index] as const),
  );

  const source: GithubOrderedChangedFileV1<TRow>[] = [];
  const tests: Array<GithubOrderedChangedFileV1<TRow> & Readonly<{ rank: number }>> = [];
  const generated: GithubOrderedChangedFileV1<TRow>[] = [];

  for (const entry of banded) {
    if (entry.band === 'source') {
      source.push(Object.freeze({ row: entry.row, band: 'source' as const, pairedSourcePath: null }));
      continue;
    }
    if (entry.band === 'generated') {
      generated.push(Object.freeze({
        row: entry.row,
        band: 'generated' as const,
        pairedSourcePath: null,
      }));
      continue;
    }
    const pairedSourcePath = findPairedSourcePath(entry.row.path, sourcePaths);
    tests.push(Object.freeze({
      row: entry.row,
      band: 'test' as const,
      pairedSourcePath,
      // An unpaired test sorts after every paired one, in path order.
      rank: pairedSourcePath === null
        ? Number.MAX_SAFE_INTEGER
        : sourceRank.get(pairedSourcePath) ?? Number.MAX_SAFE_INTEGER,
    }));
  }

  source.sort((left, right) => sourceRank.get(left.row.path)! - sourceRank.get(right.row.path)!);
  generated.sort((left, right) => comparePaths(left.row.path, right.row.path));
  tests.sort((left, right) => (
    left.rank - right.rank || comparePaths(left.row.path, right.row.path)
  ));

  const paired = new Map<string, GithubOrderedChangedFileV1<TRow>[]>();
  for (const entry of tests) {
    if (entry.pairedSourcePath === null) continue;
    const group = paired.get(entry.pairedSourcePath) ?? [];
    group.push(entry);
    paired.set(entry.pairedSourcePath, group);
  }
  return Object.freeze([
    ...source.flatMap((entry) => [entry, ...(paired.get(entry.row.path) ?? [])]),
    ...tests.filter(entry => entry.pairedSourcePath === null).map((entry) => Object.freeze({
      row: entry.row,
      band: entry.band,
      pairedSourcePath: entry.pairedSourcePath,
    })),
    ...generated,
  ]);
}

/**
 * The ordered set as the labelled groups the public `List` sectioned arm
 * consumes. An empty band is absent rather than a titled empty group.
 */
export function groupGithubChangedFiles<TRow extends GithubProjectedChangedFileRowV1>(
  ordered: readonly GithubOrderedChangedFileV1<TRow>[],
): readonly GithubChangedFileSectionV1<TRow>[] {
  const bands: readonly GithubChangedFileBandV1[] = Object.freeze(['source', 'test', 'generated']);
  return Object.freeze(bands.flatMap((band) => {
    const rows = ordered.filter((entry) => (entry.pairedSourcePath === null ? entry.band : 'source') === band).map((entry) => entry.row);
    return rows.length === 0
      ? []
      : [Object.freeze({ band, title: BAND_TITLES[band], rows: Object.freeze(rows) })];
  }));
}
