import { describe, expect, it } from 'vitest';

import type { GithubProjectedChangedFileRowV1 } from '../projection.js';

import {
  classifyGithubChangedFile,
  groupGithubChangedFiles,
  orderGithubChangedFiles,
} from './orderChangedFiles.js';

function row(path: string): GithubProjectedChangedFileRowV1 {
  return Object.freeze({
    path,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    diffAvailable: true,
  });
}

function orderedPaths(paths: readonly string[]): readonly string[] {
  return orderGithubChangedFiles(paths.map(row)).map((entry) => entry.row.path);
}

describe('GitHub changed-file reading order', () => {
  it('reads source first, then tests, then generated output', () => {
    // The provider order is deliberately hostile: lockfile churn first, the
    // code last. Raw provider order and plain alphabetical order both fail here.
    expect(orderedPaths([
      'yarn.lock',
      'src/session/__tests__/pump.test.ts',
      'dist/bundle.js',
      'src/session/pump.ts',
      'src/session/frame.ts',
    ])).toEqual([
      'src/session/frame.ts',
      'src/session/pump.ts',
      'src/session/__tests__/pump.test.ts',
      'dist/bundle.js',
      'yarn.lock',
    ]);
  });

  it('orders paired tests by the position of the source they cover', () => {
    const ordered = orderGithubChangedFiles([
      row('src/z.test.ts'),
      row('src/a.test.ts'),
      row('src/z.ts'),
      row('src/a.ts'),
    ]);

    expect(ordered.map((entry) => entry.row.path)).toEqual([
      'src/a.ts',
      'src/z.ts',
      'src/a.test.ts',
      'src/z.test.ts',
    ]);
    expect(ordered.map((entry) => entry.pairedSourcePath)).toEqual([
      null,
      null,
      'src/a.ts',
      'src/z.ts',
    ]);
  });

  it('leaves an unpaired test in the test band rather than guessing a source relationship', () => {
    const ordered = orderGithubChangedFiles([
      row('src/orphan.test.ts'),
      row('src/pump.test.ts'),
      row('src/pump.ts'),
    ]);

    expect(ordered.map((entry) => entry.row.path)).toEqual([
      'src/pump.ts',
      'src/pump.test.ts',
      'src/orphan.test.ts',
    ]);
    // A test whose counterpart is not in this pull request pairs with nothing;
    // an invented pairing changes what a reviewer believes they are reading.
    expect(ordered[2]?.pairedSourcePath).toBeNull();
    expect(ordered[2]?.band).toBe('test');
  });

  it('prefers the nearest source when several changed files share a base name', () => {
    const ordered = orderGithubChangedFiles([
      row('packages/b/src/pump.test.ts'),
      row('packages/a/src/pump.ts'),
      row('packages/b/src/pump.ts'),
    ]);
    const test = ordered.find((entry) => entry.band === 'test');
    expect(test?.pairedSourcePath).toBe('packages/b/src/pump.ts');
  });

  it('classifies machine output as generated even inside a test tree', () => {
    // A snapshot inside `__tests__` is churn, not a test a reviewer reads.
    expect(classifyGithubChangedFile('src/__tests__/__snapshots__/pump.test.ts.snap'))
      .toBe('generated');
    expect(classifyGithubChangedFile('src/__generated__/schema.ts')).toBe('generated');
    expect(classifyGithubChangedFile('pnpm-lock.yaml')).toBe('generated');
    expect(classifyGithubChangedFile('web/app.min.js')).toBe('generated');
    expect(classifyGithubChangedFile('api/client.generated.ts')).toBe('generated');
    expect(classifyGithubChangedFile('src/session/pump_test.go')).toBe('test');
    expect(classifyGithubChangedFile('e2e/login.ts')).toBe('test');
    expect(classifyGithubChangedFile('src/session/pump.ts')).toBe('source');
    // `testing.ts` is not a test: the marker must end the stem.
    expect(classifyGithubChangedFile('src/testing.ts')).toBe('source');
  });

  it('produces the same order regardless of the order GitHub returned', () => {
    const paths = [
      'src/a.ts',
      'src/a.test.ts',
      'src/b.ts',
      'src/b.spec.ts',
      'go.sum',
      'src/nested/c.ts',
    ];
    const forward = orderedPaths(paths);
    const reversed = orderedPaths([...paths].reverse());
    expect(reversed).toEqual(forward);
  });

  it('groups only the bands that have rows', () => {
    const sections = groupGithubChangedFiles(orderGithubChangedFiles([
      row('src/a.ts'),
      row('src/a.test.ts'),
    ]));
    expect(sections.map((section) => section.band)).toEqual(['source', 'test']);
    expect(sections.map((section) => section.rows.length)).toEqual([1, 1]);
  });
});
