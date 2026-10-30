import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { collectTestFiles } from './collect_test_files.mjs';
import { isUnitTestFile, resolveStackTestDirs } from './test_paths.mjs';

export const STACK_UNIT_INCLUDE_SUFFIXES = ['.test.mjs'];
export const STACK_UNIT_EXCLUDE_SUFFIXES = ['.integration.test.mjs', '.real.integration.test.mjs'];
export const STACK_INTEGRATION_INCLUDE_SUFFIXES = ['.integration.test.mjs', '.real.integration.test.mjs'];

export async function collectStackUnitTestFilesFromDirs({ scriptsDir, testsDir, collect = collectTestFiles }) {
  const testFiles = [];
  testFiles.push(...(await collect({
    dir: scriptsDir,
    includeSuffixes: STACK_UNIT_INCLUDE_SUFFIXES,
    excludeSuffixes: STACK_UNIT_EXCLUDE_SUFFIXES,
  })));
  testFiles.push(...(await collect({
    dir: testsDir,
    includeSuffixes: STACK_UNIT_INCLUDE_SUFFIXES,
    excludeSuffixes: STACK_UNIT_EXCLUDE_SUFFIXES,
  })));
  return testFiles;
}

export async function collectStackIntegrationTestFilesFromDirs({ scriptsDir, testsDir, collect = collectTestFiles }) {
  const testFiles = [];
  testFiles.push(...(await collect({
    dir: scriptsDir,
    includeSuffixes: STACK_INTEGRATION_INCLUDE_SUFFIXES,
  })));
  testFiles.push(...(await collect({
    dir: testsDir,
    includeSuffixes: STACK_INTEGRATION_INCLUDE_SUFFIXES,
  })));
  return testFiles;
}

export async function collectStackUnitTestFiles(importMetaUrl, { collect = collectTestFiles, files = [], cwd = process.cwd() } = {}) {
  const { packageRoot, scriptsDir, testsDir } = resolveStackTestDirs(importMetaUrl);
  const selection = files[0] === '--' ? files.slice(1) : files;
  let testFiles;
  if (selection.length > 0) {
    testFiles = [];
    for (const file of selection) {
      const path = resolve(cwd, file);
      if (!isUnitTestFile(path) || ![scriptsDir, testsDir].some(dir => path.startsWith(`${resolve(dir)}${sep}`))
        || !(await stat(path)).isFile()) {
        throw new Error(`Not a Stack unit test file: ${file}`);
      }
      if (!testFiles.includes(path)) testFiles.push(path);
    }
  } else {
    testFiles = await collectStackUnitTestFilesFromDirs({ scriptsDir, testsDir, collect });
  }
  return {
    packageRoot,
    scriptsDir,
    testsDir,
    testFiles,
  };
}

export async function collectStackIntegrationTestFiles(importMetaUrl, { collect = collectTestFiles } = {}) {
  const { packageRoot, scriptsDir, testsDir } = resolveStackTestDirs(importMetaUrl);
  return {
    packageRoot,
    scriptsDir,
    testsDir,
    testFiles: await collectStackIntegrationTestFilesFromDirs({ scriptsDir, testsDir, collect }),
  };
}
