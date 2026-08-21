import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkCliCommandCoverage,
  checkFeatureEnvCoverage,
  checkInternalLinks,
  checkNavCoverage,
  checkUiLabels,
  routeForFile,
  slugifyHeading,
} from './checkContent.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'docs-check-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
}

test('a section index maps to its bare route, which is why relative links break there', () => {
  const root = '/content/docs';
  assert.equal(routeForFile(root, '/content/docs/index.mdx'), '/');
  assert.equal(routeForFile(root, '/content/docs/features/index.mdx'), '/features');
  assert.equal(routeForFile(root, '/content/docs/features/git.mdx'), '/features/git');
});

test('heading slugs do not collapse whitespace runs', () => {
  // `+` is stripped but the spaces around it are not merged, so this really is
  // a double hyphen. A collapsing slugger reports false failures here.
  assert.equal(
    slugifyHeading('WebSockets (required for realtime + “machine online”)'),
    'websockets-required-for-realtime--machine-online',
  );
});

test('rejects every non-canonical link form and resolves the canonical one', () => {
  const root = fixture({
    'features/index.mdx': [
      '[relative](./git)',
      '[parent](../server/auth)',
      '[legacy](/docs/features/git)',
      '[canonical](/features/git)',
      '[external](https://happier.dev)',
    ].join('\n'),
    'features/git.mdx': '# Git\n',
    'server/auth.mdx': '# Auth\n',
  });

  const problems = checkInternalLinks({ contentRoot: root });
  assert.deepEqual(
    problems.map((p) => p.target),
    ['./git', '../server/auth', '/docs/features/git'],
  );
  assert.match(problems[0].reason, /relative link/);
  assert.match(problems[2].reason, /legacy \/docs prefix/);
});

test('reports links to pages and headings that do not exist', () => {
  const root = fixture({
    'a.mdx': '[gone](/nowhere)\n[bad anchor](/b#not-a-heading)\n[good](/b#real-heading)\n',
    'b.mdx': '## Real heading\n',
  });

  const problems = checkInternalLinks({ contentRoot: root });
  assert.equal(problems.length, 2);
  assert.match(problems[0].reason, /no page at this route/);
  assert.match(problems[1].reason, /no heading "#not-a-heading"/);
});

test('flags a navigation path naming a label the app does not render', () => {
  const root = fixture({
    'p.mdx': 'Open **Settings → Features → Git operations** to enable it.\n',
  });
  const translations = join(fixture({ 'en.ts': "  sourceControl: 'Source control operations',\n" }), 'en.ts');

  const problems = checkUiLabels({ contentRoot: root, translationsFile: translations });
  assert.deepEqual(problems.map((p) => p.label), ['Git operations']);
});

test('accepts a navigation path whose segments all ship', () => {
  const root = fixture({
    'p.mdx': 'Open **Settings → AI backends → Claude**.\n',
  });
  const translations = join(
    fixture({ 'en.ts': "  title: 'AI backends',\n  claude: 'Claude',\n" }),
    'en.ts',
  );

  assert.deepEqual(checkUiLabels({ contentRoot: root, translationsFile: translations }), []);
});

test('finds a label declared in an inline multi-property object', () => {
  // The end-anchored extractor this replaced only saw a value at the end of a
  // line, so a label written alongside a sibling property was invisible and the
  // check called correct documentation wrong. Five real pages were accused this
  // way before it was noticed.
  const root = fixture({
    'p.mdx': 'Open **Settings → Session → Mobile session layout**.\n',
  });
  const translations = join(
    fixture({
      'en.ts': "  session: 'Session',\n  mobileLayout: { title: 'Mobile session layout', footer: 'Choose the layout.' },\n",
    }),
    'en.ts',
  );

  assert.deepEqual(checkUiLabels({ contentRoot: root, translationsFile: translations }), []);
});

test('an apostrophe inside a translation does not de-sync the rest of the file', () => {
  // The whole-file tokenizer this replaced lost every string after the first
  // `don't`, so thousands of real labels read as missing.
  const root = fixture({ 'p.mdx': 'Open **Settings → Relays**.\n' });
  const translations = join(
    fixture({ 'en.ts': "  warn: 'This machine isn't online',\n  relays: 'Relays',\n" }),
    'en.ts',
  );

  assert.deepEqual(checkUiLabels({ contentRoot: root, translationsFile: translations }), []);
});

test("another product's settings menu is not a claim about Happier's UI", () => {
  const root = fixture({
    'p.mdx': 'In GitHub, go to **Settings → Developer settings → OAuth Apps**.\n',
  });
  const translations = join(fixture({ 'en.ts': "  a: 'unrelated',\n" }), 'en.ts');

  assert.deepEqual(checkUiLabels({ contentRoot: root, translationsFile: translations }), []);
});

test('a missing translations file skips the label check rather than failing the build', () => {
  const root = fixture({ 'p.mdx': 'Open **Settings → Whatever**.\n' });
  assert.deepEqual(
    checkUiLabels({ contentRoot: root, translationsFile: '/does/not/exist/en.ts' }),
    [],
  );
});

test('ignores arrow notation that is not a Happier settings path', () => {
  // All real, all written with the same arrow: an ElevenLabs API-key
  // permission, a form field and its option, and a SwiftBar menu.
  const root = fixture({
    'p.mdx': [
      'The key needs **Voices → Read** permission.',
      'Set **Applies to → One machine**.',
      'Open **Components → Git cache**.',
    ].join('\n'),
  });
  const translations = join(fixture({ 'en.ts': "  a: 'unrelated',\n" }), 'en.ts');

  assert.deepEqual(checkUiLabels({ contentRoot: root, translationsFile: translations }), []);
});

test('reports the line the problem is on, counting lines inside code fences', () => {
  const root = fixture({
    'p.mdx': ['intro', '```bash', 'echo one', 'echo two', '```', 'Open **Settings → Gone**.'].join('\n'),
  });
  const translations = join(fixture({ 'en.ts': "  a: 'unrelated',\n" }), 'en.ts');

  const [problem] = checkUiLabels({ contentRoot: root, translationsFile: translations });
  assert.equal(problem.at, 'p.mdx:6');
});

test('an undocumented server feature variable fails the check', () => {
  const schemaDir = fixture({
    'featureEnvSchema.ts': [
      "export const FEATURE_ENV_KEYS = {",
      "  documented: 'HAPPIER_FEATURE_DOCUMENTED__ENABLED',",
      "  forgotten: 'HAPPIER_FEATURE_FORGOTTEN__ENABLED',",
      "};",
    ].join('\n'),
  });
  const contentRoot = fixture({
    'env.mdx': '- `HAPPIER_FEATURE_DOCUMENTED__ENABLED` (default `1`)\n',
  });

  const problems = checkFeatureEnvCoverage({
    contentRoot,
    featureEnvSchemaPath: join(schemaDir, 'featureEnvSchema.ts'),
  });
  assert.deepEqual(problems.map((p) => p.label), ['HAPPIER_FEATURE_FORGOTTEN__ENABLED']);
});

test('a missing server workspace skips the coverage check', () => {
  const contentRoot = fixture({ 'env.mdx': 'nothing here\n' });
  assert.deepEqual(
    checkFeatureEnvCoverage({ contentRoot, featureEnvSchemaPath: '/does/not/exist.ts' }),
    [],
  );
});

test('an undocumented CLI command fails the check, and aliases are exempt', () => {
  const registryDir = fixture({
    'commandRegistry.ts': [
      'const commandRegistry = {',
      '  doctor: handleDoctorCliCommand,',
      '  ghost: handleGhostCliCommand,',
      '  sessions: handleSessionCliCommand,',
      '};',
    ].join('\n'),
  });
  const contentRoot = fixture({ 'cli.mdx': 'Run `happier doctor` to check things.\n' });

  const problems = checkCliCommandCoverage({
    contentRoot,
    registryPath: join(registryDir, 'commandRegistry.ts'),
  });
  // `sessions` is a documented plural alias; `ghost` is genuinely missing.
  assert.deepEqual(problems.map((p) => p.label), ['happier ghost']);
});

test('an ASCII-arrow settings path is checked like a real one', () => {
  // The site mostly writes `→`, but two dozen pages used `->` and were
  // invisible to this check — including one naming a row by the wrong label.
  const root = fixture({ 'p.mdx': 'Open **Settings -> Features -> Gone** to enable it.\n' });
  const translations = join(fixture({ 'en.ts': "  a: 'Features',\n" }), 'en.ts');

  const problems = checkUiLabels({ contentRoot: root, translationsFile: translations });
  assert.deepEqual(problems.map((p) => p.label), ['Gone']);
});

test('a page missing from meta.json is reported as unreachable', () => {
  // The exact bug this guards: a generator wrote to a stale path after a move,
  // leaving valid MDX that no sidebar referenced.
  const root = fixture({
    'sessions/meta.json': JSON.stringify({ title: 'Sessions', pages: ['permissions'] }),
    'sessions/permissions.mdx': '# Permissions\n',
    'sessions/orphan.mdx': '# Left behind by a stale OUTPUT_PATH\n',
  });
  const problems = checkNavCoverage({ contentRoot: root });
  assert.deepEqual(problems.map((p) => p.label), ['orphan']);
});

test('a meta.json entry with no file is reported too', () => {
  const root = fixture({
    'code/meta.json': JSON.stringify({ title: 'Code', pages: ['git', 'deleted-page'] }),
    'code/git.mdx': '# Git\n',
  });
  const problems = checkNavCoverage({ contentRoot: root });
  assert.deepEqual(problems.map((p) => p.label), ['deleted-page']);
});
