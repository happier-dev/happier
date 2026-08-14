import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReleaseNotesBundle,
  parseReleaseNoteSection,
  renderReleaseNotesBundle,
} from '../pipeline/release/release-notes/project-release-notes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const projectionScript = resolve(repoRoot, 'scripts/pipeline/release/release-notes/project-release-notes.mjs');

function writeChangelog(contents) {
  const root = mkdtempSync(join(tmpdir(), 'happier-release-notes-projection-'));
  const changelogPath = join(root, 'CHANGELOG.md');
  writeFileSync(changelogPath, contents, 'utf8');
  return { root, changelogPath };
}

const projectReleaseId = '2026-09-03.1';

function changelogWithSection(sectionMarkdown, releaseId = projectReleaseId) {
  return [
    '# Changelog',
    '',
    '## Release 2026-09-30.1 - 2026-09-30',
    '',
    'This differently identified project release must not match 2026-09-03.1.',
    '',
    `## Release ${releaseId} - 2026-09-03`,
    '',
    sectionMarkdown,
    '',
    '## Version 1.2.4 - 2026-09-04',
    '',
    'This next-version prose must not leak into 1.2.3.',
    '',
  ].join('\n');
}

function approvedProjections(overrides = {}) {
  return [
    '<!-- happier-release-note-projections:v1',
    JSON.stringify({
      expo: { message: 'Exact Expo text.' },
      appStore: { whatsNew: 'Exact App Store text.' },
      playStore: { whatsNew: 'Exact Play Store text.' },
      storyDeck: { summary: 'Exact StoryDeck text.' },
      ...overrides,
    }, null, 2),
    '-->',
  ].join('\n');
}

function releaseInput(overrides = {}) {
  return {
    releaseId: projectReleaseId,
    sourceSha: 'a'.repeat(40),
    componentVersions: { cli: '4.5.6', server: '7.8.9' },
    ...overrides,
  };
}

test('release-note projection selects the exact project release independent of component versions', () => {
  const changelog = changelogWithSection([
    approvedProjections(),
    '',
    '### New capability',
    '',
    '**Happier now ships this.** Read the [guide](https://example.test/guide).',
    '',
    '- First public outcome',
    '- `Code` details stay in the Markdown projection',
  ].join('\n'));

  const section = parseReleaseNoteSection(changelog, projectReleaseId);
  assert.equal(section.date, '2026-09-03');
  assert.equal(section.markdown, [
    approvedProjections(),
    '',
    '### New capability',
    '',
    '**Happier now ships this.** Read the [guide](https://example.test/guide).',
    '',
    '- First public outcome',
    '- `Code` details stay in the Markdown projection',
  ].join('\n'));
  assert.doesNotMatch(section.markdown, /next-version prose/i);

  const bundle = buildReleaseNotesBundle(changelog, releaseInput());
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.kind, 'happier.release-notes.projection.v2');
  assert.deepEqual(bundle.release, {
    id: projectReleaseId,
    sourceSha: 'a'.repeat(40),
    components: { cli: '4.5.6', server: '7.8.9' },
  });
  assert.deepEqual(bundle.changelog, { date: '2026-09-03' });
  const publicMarkdown = [
    '### New capability',
    '',
    '**Happier now ships this.** Read the [guide](https://example.test/guide).',
    '',
    '- First public outcome',
    '- `Code` details stay in the Markdown projection',
  ].join('\n');
  assert.equal(bundle.projections.github.markdown, publicMarkdown);
  assert.equal(bundle.projections.rollingRelease.markdown, publicMarkdown);
});

test('release-note projection fails on missing or duplicate exact project release sections', () => {
  assert.throws(
    () => parseReleaseNoteSection('# Changelog\n', projectReleaseId),
    /No exact changelog section found for release 2026-09-03\.1/,
  );

  assert.throws(
    () => parseReleaseNoteSection([
      `## Release ${projectReleaseId} - 2026-09-03`,
      '',
      'First approved prose.',
      '',
      `## Release ${projectReleaseId} - 2026-09-04`,
      '',
      'Duplicate approved prose.',
    ].join('\n'), projectReleaseId),
    /must appear exactly once/,
  );
});

test('release-note projection is byte deterministic and emits no approval or timestamp metadata', () => {
  const changelog = changelogWithSection(`${approvedProjections()}\n\nA deterministic public release note.`);
  const first = renderReleaseNotesBundle(buildReleaseNotesBundle(changelog, releaseInput()));
  const second = renderReleaseNotesBundle(buildReleaseNotesBundle(changelog, releaseInput()));

  assert.equal(first, second);
  const bundle = JSON.parse(first);
  assert.deepEqual(Object.keys(bundle), ['schemaVersion', 'kind', 'release', 'changelog', 'projections']);
  assert.doesNotMatch(first, /approval|approvedBy|generatedAt|timestamp|private/i);
});

test('release-note projection publishes exact approved bounded text instead of truncating the changelog', () => {
  const exact = {
    expo: { message: 'Approved Expo copy, exactly.' },
    appStore: { whatsNew: 'Approved App Store copy, exactly.' },
    playStore: { whatsNew: 'Approved Play Store copy, exactly.' },
    storyDeck: { summary: 'Approved StoryDeck copy, exactly.' },
  };
  const changelog = changelogWithSection([
    approvedProjections(exact),
    '',
    ...Array.from({ length: 800 }, () => '- A long public release narrative that must not be sliced into store copy.'),
  ].join('\n'));
  const bundle = buildReleaseNotesBundle(changelog, releaseInput());

  assert.deepEqual(bundle.projections.expo, exact.expo);
  assert.deepEqual(bundle.projections.appStore, exact.appStore);
  assert.deepEqual(bundle.projections.playStore, exact.playStore);
  assert.deepEqual(bundle.projections.storyDeck, exact.storyDeck);
  assert.ok(bundle.projections.github.markdown.length > 4_000);
});

test('release-note projection requires only consumed bounded destinations and omits dormant projections', () => {
  const changelog = changelogWithSection([
    approvedProjections({
      appStore: undefined,
      playStore: undefined,
      storyDeck: undefined,
    }),
    '',
    'A release with no selected store or StoryDeck publication surface.',
  ].join('\n').replace(/,?\n\s*"(?:appStore|playStore|storyDeck)": undefined/g, ''));

  const bundle = buildReleaseNotesBundle(changelog, releaseInput());
  assert.deepEqual(bundle.projections.expo, { message: 'Exact Expo text.' });
  assert.equal(Object.hasOwn(bundle.projections, 'appStore'), false);
  assert.equal(Object.hasOwn(bundle.projections, 'playStore'), false);
  assert.equal(Object.hasOwn(bundle.projections, 'storyDeck'), false);
});

test('release-note projection keeps the stable GitHub and preview rolling narratives identical', () => {
  const bundle = buildReleaseNotesBundle(
    changelogWithSection(`${approvedProjections()}\n\nOne approved public narrative.`),
    releaseInput(),
  );

  assert.equal(bundle.projections.github.markdown, bundle.projections.rollingRelease.markdown);
});

test('release-note projection command emits JSON only to stdout or writes the same JSON to --out', () => {
  const fixture = writeChangelog(changelogWithSection(`${approvedProjections()}\n\nA concise public release note.`));
  const stdoutResult = spawnSync(
    process.execPath,
    [
      projectionScript,
      '--release-id', projectReleaseId,
      '--source-sha', 'a'.repeat(40),
      '--component-version', 'cli=4.5.6',
      '--component-version', 'server=7.8.9',
      '--changelog', fixture.changelogPath,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.equal(stdoutResult.status, 0, stdoutResult.stderr);
  assert.equal(stdoutResult.stderr, '');
  assert.deepEqual(JSON.parse(stdoutResult.stdout).release, {
    id: projectReleaseId,
    sourceSha: 'a'.repeat(40),
    components: { cli: '4.5.6', server: '7.8.9' },
  });

  const outPath = join(fixture.root, 'release-notes.json');
  const outResult = spawnSync(
    process.execPath,
    [
      projectionScript,
      '--release-id', projectReleaseId,
      '--source-sha', 'a'.repeat(40),
      '--component-version=cli=4.5.6',
      '--component-version=server=7.8.9',
      '--changelog', fixture.changelogPath,
      '--out', outPath,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.equal(outResult.status, 0, outResult.stderr);
  assert.equal(outResult.stdout, '');
  assert.equal(readFileSync(outPath, 'utf8'), stdoutResult.stdout);
});

test('release-note projection rejects exact sections with no meaningful public Markdown', () => {
  const changelog = changelogWithSection(`${approvedProjections()}\n\n---`);

  assert.throws(
    () => buildReleaseNotesBundle(changelog, releaseInput()),
    /must contain meaningful public Markdown/,
  );
});

test('release-note projection requires the consumed Expo destination and validates authored projection lengths', () => {
  assert.throws(
    () => buildReleaseNotesBundle(changelogWithSection('A public release note without bounded projections.'), releaseInput()),
    /Missing approved bounded projections/,
  );

  const changelog = changelogWithSection([
    approvedProjections({ expo: { message: 'x'.repeat(1_025) } }),
    '',
    'A public release note with an over-limit Expo projection.',
  ].join('\n'));

  assert.throws(
    () => buildReleaseNotesBundle(changelog, releaseInput()),
    /expo\.message must be at most 1024 characters/,
  );
});
