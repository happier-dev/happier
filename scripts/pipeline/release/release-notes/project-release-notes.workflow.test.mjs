import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { main } from './project-release-notes.mjs';

test('projects repository component versions and bounded texts to GitHub outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-notes-'));
  const manifests = {
    ui: ['apps', 'ui'],
    cli: ['apps', 'cli'],
    stack: ['apps', 'stack'],
    server: ['apps', 'server'],
    plugin_sdk: ['packages', 'plugin-sdk'],
    plugin_ui: ['packages', 'plugin-ui'],
    sdk: ['packages', 'sdk'],
  };
  for (const [id, segments] of Object.entries(manifests)) {
    await mkdir(join(root, ...segments), { recursive: true });
    const version = id === 'plugin_sdk' || id === 'plugin_ui' ? '1.2.10' : `1.2.${id.length}`;
    await writeFile(join(root, ...segments, 'package.json'), JSON.stringify({ version }));
  }
  const changelog = join(root, 'CHANGELOG.md');
  await writeFile(changelog, [
    '## Release preview.1 - 2026-08-11',
    '<!-- happier-release-note-projections:v1',
    '{"expo":{"message":"A concise update"}}',
    '-->',
    '- Improved release ownership.',
    '',
  ].join('\n'));
  const output = join(root, 'github-output');

  const bundle = await main([
    '--release-id', 'preview.1',
    '--source-sha', 'a'.repeat(40),
    '--repo-root', root,
    '--changelog', changelog,
    '--github-output', output,
  ]);

  const rendered = await readFile(output, 'utf8');
  assert.match(rendered, /github_markdown<<HAPPIER_RELEASE_NOTES_/);
  assert.match(rendered, /Improved release ownership/);
  assert.match(rendered, /expo_message<<HAPPIER_RELEASE_NOTES_/);
  assert.match(rendered, /A concise update/);
  assert.deepEqual(bundle.release.components, {
    cli: '1.2.3',
    plugin_sdk: '1.2.10',
    sdk: '1.2.3',
    server: '1.2.6',
    stack: '1.2.5',
    ui: '1.2.2',
  });
});

test('repository release-note projection refuses a plugin SDK pair version mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-notes-pair-'));
  for (const [segments, version] of [
    [['apps', 'ui'], '1.0.0'],
    [['apps', 'cli'], '1.0.0'],
    [['apps', 'stack'], '1.0.0'],
    [['apps', 'server'], '1.0.0'],
    [['packages', 'plugin-sdk'], '1.0.0'],
    [['packages', 'plugin-ui'], '1.0.1'],
    [['packages', 'sdk'], '1.0.0'],
  ]) {
    await mkdir(join(root, ...segments), { recursive: true });
    await writeFile(join(root, ...segments, 'package.json'), JSON.stringify({ version }));
  }
  const changelog = join(root, 'CHANGELOG.md');
  await writeFile(changelog, [
    '## Release preview.1 - 2026-08-11',
    '<!-- happier-release-note-projections:v1',
    '{"expo":{"message":"A concise update"}}',
    '-->',
    '- Improved release ownership.',
    '',
  ].join('\n'));

  await assert.rejects(
    main([
      '--release-id', 'preview.1',
      '--source-sha', 'a'.repeat(40),
      '--repo-root', root,
      '--changelog', changelog,
    ]),
    /plugin-sdk and plugin-ui must be version-equal/,
  );
});
