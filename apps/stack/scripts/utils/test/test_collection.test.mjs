import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

import {
  collectStackIntegrationTestFilesFromDirs,
  collectStackUnitTestFiles,
  STACK_INTEGRATION_INCLUDE_SUFFIXES,
} from './test_collection.mjs';

test('explicit unit files select only existing unit files and never fall back to discovery', async (t) => {
  const fixture = await createTempFixture(t);
  await mkdir(fixture.path('scripts'));
  await mkdir(fixture.path('tests'));
  for (const file of ['scripts/first.test.mjs', 'tests/second.test.mjs', 'tests/unselected.test.mjs', 'tests/flow.integration.test.mjs', 'tests/flow.real.integration.test.mjs', 'outside.test.mjs']) {
    await writeFile(fixture.path(file), '');
  }
  const entry = pathToFileURL(fixture.path('scripts/test_ci.mjs')).href;
  const selected = await collectStackUnitTestFiles(entry, {
    files: ['--', 'tests/second.test.mjs', fixture.path('scripts/first.test.mjs'), 'tests/second.test.mjs'],
    cwd: fixture.root,
  });
  assert.deepEqual(selected.testFiles, [fixture.path('tests/second.test.mjs'), fixture.path('scripts/first.test.mjs')]);
  for (const file of ['tests/missing.test.mjs', 'tests/flow.integration.test.mjs', 'outside.test.mjs', 'tests', '--unknown']) {
    await assert.rejects(collectStackUnitTestFiles(entry, { files: [file], cwd: fixture.root }), undefined, file);
  }
  const full = await collectStackUnitTestFiles(entry);
  assert.deepEqual(full.testFiles, [fixture.path('scripts/first.test.mjs'), fixture.path('tests/second.test.mjs'), fixture.path('tests/unselected.test.mjs')]);
});

test('collectStackIntegrationTestFilesFromDirs collects scripts and tests using integration suffix rules', async () => {
  const calls = [];
  const collect = async (options) => {
    calls.push(options);
    return [`${options.dir}/file.integration.test.mjs`];
  };

  const files = await collectStackIntegrationTestFilesFromDirs({
    scriptsDir: '/tmp/scripts',
    testsDir: '/tmp/tests',
    collect,
  });

  assert.deepEqual(files, ['/tmp/scripts/file.integration.test.mjs', '/tmp/tests/file.integration.test.mjs']);
  assert.deepEqual(calls, [
    {
      dir: '/tmp/scripts',
      includeSuffixes: STACK_INTEGRATION_INCLUDE_SUFFIXES,
    },
    {
      dir: '/tmp/tests',
      includeSuffixes: STACK_INTEGRATION_INCLUDE_SUFFIXES,
    },
  ]);
});
