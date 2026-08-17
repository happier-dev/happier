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
 * The rich diff body remains held under B6; nothing here reads or needs a patch,
 * and the ordering is computed entirely from the provider path facts the
 * boundary projector already published.
 *
 * Every rule below is a recognition rule, never a guess. A test file whose
 * source counterpart is not in this pull request stays in the test band rather
 * than being attached to a source file it merely resembles, because an invented
 * pairing changes what a reviewer believes they are reading.
 */

export type GithubChangedFileBandV1 = 'source' | 'test' | 'generated';

export type GithubOrderedChangedFileV1 = Readonly<{
  row: GithubProjectedChangedFileRowV1;
  band: GithubChangedFileBandV1;
  /** The source path this test is recognizably paired with, when there is one. */
  pairedSourcePath: string | null;
}>;

export type GithubChangedFileSectionV1 = Readonly<{
  band: GithubChangedFileBandV1;
  title: string;
  rows: readonly GithubProjectedChangedFileRowV1[];
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
 * Bands run source, then tests, then generated output. Inside the source and
 * generated bands the order is normalized path order. Inside the test band a
 * paired test follows its source file's position, so the tests read in the same
 * order as the code they cover, and an unpaired test sorts after every paired
 * one in path order rather than being interleaved on a guess.
 */
export function orderGithubChangedFiles(
  rows: readonly GithubProjectedChangedFileRowV1[],
): readonly GithubOrderedChangedFileV1[] {
  const banded = rows.map((row) => Object.freeze({
    row,
    band: classifyGithubChangedFile(row.path),
  }));

  const sourcePaths = banded
    .filter((entry) => entry.band === 'source')
    .map((entry) => entry.row.path)
    .sort(comparePaths);
  const sourceRank = new Map<string, number>(
    sourcePaths.map((path, index) => [path, index] as const),
  );

  const source: GithubOrderedChangedFileV1[] = [];
  const tests: Array<GithubOrderedChangedFileV1 & Readonly<{ rank: number }>> = [];
  const generated: GithubOrderedChangedFileV1[] = [];

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

  source.sort((left, right) => comparePaths(left.row.path, right.row.path));
  generated.sort((left, right) => comparePaths(left.row.path, right.row.path));
  tests.sort((left, right) => (
    left.rank - right.rank || comparePaths(left.row.path, right.row.path)
  ));

  return Object.freeze([
    ...source,
    ...tests.map((entry) => Object.freeze({
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
export function groupGithubChangedFiles(
  ordered: readonly GithubOrderedChangedFileV1[],
): readonly GithubChangedFileSectionV1[] {
  const bands: readonly GithubChangedFileBandV1[] = Object.freeze(['source', 'test', 'generated']);
  return Object.freeze(bands.flatMap((band) => {
    const rows = ordered.filter((entry) => entry.band === band).map((entry) => entry.row);
    return rows.length === 0
      ? []
      : [Object.freeze({ band, title: BAND_TITLES[band], rows: Object.freeze(rows) })];
  }));
}
