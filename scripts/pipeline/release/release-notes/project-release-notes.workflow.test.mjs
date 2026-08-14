import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { main } from './project-release-notes.mjs';

test('projects repository component versions and bounded texts to GitHub outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-notes-'));
  for (const id of ['ui', 'cli', 'stack', 'server']) {
    await mkdir(join(root, 'apps', id), { recursive: true });
    await writeFile(join(root, 'apps', id, 'package.json'), JSON.stringify({ version: `1.2.${id.length}` }));
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

  await main([
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
});
