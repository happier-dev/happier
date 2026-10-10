import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTempFixture } from '../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../apps/stack/scripts/testkit/core/run_node_capture.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function setup(t) {
  const fixture = await createTempFixture(t, {
    prefix: 'happier-format-edits-',
  });
  await mkdir(fixture.path('scripts'));
  await mkdir(fixture.path('src'));
  await mkdir(fixture.path('src/build'));
  await mkdir(fixture.path('vendor'));
  await copyFile(
    join(repoRoot, 'scripts/formatEditedFiles.mjs'),
    fixture.path('scripts/formatEditedFiles.mjs'),
  );
  await copyFile(
    join(repoRoot, '.oxfmtrc.json'),
    fixture.path('.oxfmtrc.json'),
  );
  await symlink(
    join(repoRoot, 'node_modules'),
    fixture.path('node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const dirty = 'export const value={x:1,y:2}\n';
  for (const file of [
    'src/edited file.ts',
    'src/other.ts',
    'src/build/example.ts',
    'vendor/generated.ts',
  ]) {
    await writeFile(fixture.path(file), dirty);
  }
  return {
    ...fixture,
    dirty,
    async run(tool_name, tool_input) {
      return runNodeCapture([fixture.path('scripts/formatEditedFiles.mjs')], {
        cwd: fixture.path('src'),
        input: JSON.stringify({
          hook_event_name: 'PostToolUse',
          tool_name,
          tool_input,
          cwd: tool_name === 'apply_patch' ? fixture.root : fixture.path('src'),
        }),
      });
    },
  };
}

test('Claude edits format only the exact edited file, including paths with spaces', async (t) => {
  const fixture = await setup(t);
  const result = await fixture.run('Edit', {
    file_path: fixture.path('src/edited file.ts'),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await readFile(fixture.path('src/edited file.ts'), 'utf8'),
    'export const value = { x: 1, y: 2 };\n',
  );
  assert.equal(
    await readFile(fixture.path('src/other.ts'), 'utf8'),
    fixture.dirty,
  );
  const buildSourceResult = await fixture.run('Edit', {
    file_path: fixture.path('src/build/example.ts'),
  });
  assert.equal(buildSourceResult.code, 0, buildSourceResult.stderr);
  assert.equal(
    await readFile(fixture.path('src/build/example.ts'), 'utf8'),
    'export const value = { x: 1, y: 2 };\n',
  );
});

test('Codex patches format added/updated/moved destinations and respect the root ignore policy', async (t) => {
  const fixture = await setup(t);
  await writeFile(fixture.path('src/added.ts'), fixture.dirty);
  await writeFile(fixture.path('src/moved.ts'), fixture.dirty);
  const command = [
    '*** Begin Patch',
    '*** Add File: src/added.ts',
    '+export const value={x:1,y:2}',
    '*** Update File: src/edited file.ts',
    '@@',
    '-old',
    '+new',
    '*** Update File: src/old.ts',
    '*** Move to: src/moved.ts',
    '@@',
    '-old',
    '+new',
    '*** Update File: vendor/generated.ts',
    '@@',
    '-old',
    '+new',
    '*** Delete File: src/deleted.ts',
    '*** End Patch',
  ].join('\n');
  const result = await fixture.run('apply_patch', { command });
  assert.equal(result.code, 0, result.stderr);
  for (const file of ['src/added.ts', 'src/edited file.ts', 'src/moved.ts']) {
    assert.equal(
      await readFile(fixture.path(file), 'utf8'),
      'export const value = { x: 1, y: 2 };\n',
    );
  }
  assert.equal(
    await readFile(fixture.path('vendor/generated.ts'), 'utf8'),
    fixture.dirty,
  );
  assert.equal(
    await readFile(fixture.path('src/other.ts'), 'utf8'),
    fixture.dirty,
  );
});

test('unrelated tools, outside paths and directory payloads never broaden formatting', async (t) => {
  const fixture = await setup(t);
  const outside = await createTempFixture(t, {
    prefix: 'happier-format-outside-',
  });
  await writeFile(outside.path('outside.ts'), fixture.dirty);
  await symlink(outside.path('outside.ts'), fixture.path('src/link.ts'));
  for (const [name, input] of [
    ['Bash', { command: 'touch src/edited file.ts' }],
    [
      'Write',
      { file_path: resolve(fixture.root, '..', outside.path('outside.ts')) },
    ],
    ['Edit', { file_path: fixture.path('src') }],
    ['Edit', { file_path: fixture.path('src/link.ts') }],
  ]) {
    const result = await fixture.run(name, input);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(
    await readFile(outside.path('outside.ts'), 'utf8'),
    fixture.dirty,
  );
  assert.equal(
    await readFile(fixture.path('src/edited file.ts'), 'utf8'),
    fixture.dirty,
  );
});
