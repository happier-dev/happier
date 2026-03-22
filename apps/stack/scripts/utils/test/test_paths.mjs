import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IGNORED_TEST_SEARCH_DIR_NAMES = new Set([
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'vendor',
]);

export function isIgnoredTestSearchEntryName(name) {
  const value = String(name ?? '').trim();
  if (!value) return false;
  if (value.startsWith('.')) return true;
  if (IGNORED_TEST_SEARCH_DIR_NAMES.has(value)) return true;
  if (value.startsWith('dist.__sync_tmp__')) return true;
  return false;
}

export function isRealIntegrationTestFile(file) {
  return String(file ?? '').endsWith('.real.integration.test.mjs');
}

export function isIntegrationTestFile(file) {
  const value = String(file ?? '');
  return isRealIntegrationTestFile(value) || value.endsWith('.integration.test.mjs');
}

export function isUnitTestFile(file) {
  const value = String(file ?? '');
  return value.endsWith('.test.mjs') && !isIntegrationTestFile(value);
}

export function resolveStackTestDirs(importMetaUrl) {
  const packageRoot = fileURLToPath(new URL('..', importMetaUrl));
  return {
    packageRoot,
    scriptsDir: join(packageRoot, 'scripts'),
    testsDir: join(packageRoot, 'tests'),
  };
}
