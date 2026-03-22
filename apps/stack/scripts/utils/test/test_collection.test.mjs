import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectStackIntegrationTestFilesFromDirs,
  collectStackUnitTestFilesFromDirs,
  STACK_INTEGRATION_INCLUDE_SUFFIXES,
  STACK_UNIT_EXCLUDE_SUFFIXES,
  STACK_UNIT_INCLUDE_SUFFIXES,
} from './test_collection.mjs';

test('collectStackUnitTestFilesFromDirs collects scripts and tests using unit suffix rules', async () => {
  const calls = [];
  const collect = async (options) => {
    calls.push(options);
    return [`${options.dir}/file.test.mjs`];
  };

  const files = await collectStackUnitTestFilesFromDirs({
    scriptsDir: '/tmp/scripts',
    testsDir: '/tmp/tests',
    collect,
  });

  assert.deepEqual(files, ['/tmp/scripts/file.test.mjs', '/tmp/tests/file.test.mjs']);
  assert.deepEqual(calls, [
    {
      dir: '/tmp/scripts',
      includeSuffixes: STACK_UNIT_INCLUDE_SUFFIXES,
      excludeSuffixes: STACK_UNIT_EXCLUDE_SUFFIXES,
    },
    {
      dir: '/tmp/tests',
      includeSuffixes: STACK_UNIT_INCLUDE_SUFFIXES,
      excludeSuffixes: STACK_UNIT_EXCLUDE_SUFFIXES,
    },
  ]);
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
