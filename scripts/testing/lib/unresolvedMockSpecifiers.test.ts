import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectMockSpecifierIssues,
  collectMockSpecifiers,
  collectUnresolvedMockSpecifiers,
  isCheckedMockSpecifier,
} from './unresolvedMockSpecifiers.ts';

const ROOT = '/repo';

function existingModules(paths: readonly string[]) {
  const known = new Set(paths);
  return (absolutePath: string) => known.has(absolutePath);
}

test('reports a relative mock specifier whose module no longer exists', () => {
  const issues = collectUnresolvedMockSpecifiers(
    [{ filePath: 'apps/cli/src/api/api.test.ts', content: "vi.mock('./libsodiumEncryption', () => ({}));\n" }],
    { rootDir: ROOT, moduleExists: existingModules(['/repo/apps/cli/src/api/api.ts']) },
  );

  assert.deepEqual(issues, [{ filePath: 'apps/cli/src/api/api.test.ts', line: 1, specifier: './libsodiumEncryption' }]);
});

test('accepts a relative specifier that resolves through the .js -> .ts authoring convention', () => {
  const issues = collectUnresolvedMockSpecifiers(
    [{ filePath: 'packages/plugin-sdk/src/host.test.ts', content: "vi.mock('./scope.js', () => ({}));\n" }],
    { rootDir: ROOT, moduleExists: existingModules(['/repo/packages/plugin-sdk/src/scope.ts']) },
  );

  assert.deepEqual(issues, []);
});

test('resolves the @/ alias against the owning workspace source root', () => {
  const files = [{
    filePath: 'apps/ui/sources/components/SessionView.test.tsx',
    content: "vi.mock('@/sync/acp/sessionModeControl', () => ({}));\nvi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({}));\n",
  }];
  const issues = collectUnresolvedMockSpecifiers(files, {
    rootDir: ROOT,
    moduleExists: existingModules(['/repo/apps/ui/sources/sync/domains/sessionControl/sessionModeControl.ts']),
  });

  assert.deepEqual(issues.map((issue) => issue.specifier), ['@/sync/acp/sessionModeControl']);
});

test('resolves a directory specifier through its index module', () => {
  const issues = collectUnresolvedMockSpecifiers(
    [{ filePath: 'apps/cli/src/a.test.ts', content: "vi.doMock('@/sync/ops', () => ({}));\n" }],
    { rootDir: ROOT, moduleExists: existingModules(['/repo/apps/cli/src/sync/ops/index.ts']) },
  );

  assert.deepEqual(issues, []);
});

test('ignores bare package specifiers this checker does not own', () => {
  assert.equal(isCheckedMockSpecifier('axios'), false);
  assert.equal(isCheckedMockSpecifier('@happier-dev/protocol'), false);
  assert.equal(isCheckedMockSpecifier('@/sync/ops'), true);
  assert.equal(isCheckedMockSpecifier('../x'), true);
});

test('does not read a vi.mock quoted inside a codemod fixture string as a real call', () => {
  const found = collectMockSpecifiers({
    filePath: 'apps/ui/tools/migrations/rewriter.test.ts',
    content: "    vi.mock('./real', () => ({}));\n    \"vi.mock('@/other/module', async () => {\",\n",
  });

  assert.deepEqual(found.map((entry) => entry.specifier), ['./real']);
});

test('a declared backlog entry suppresses its own issue but nothing else in the file', () => {
  const files = [{
    filePath: 'apps/ui/sources/a.test.ts',
    content: "vi.mock('@/gone/one', () => ({}));\nvi.mock('@/gone/two', () => ({}));\n",
  }];
  const issues = collectMockSpecifierIssues(files, {
    rootDir: ROOT,
    moduleExists: existingModules([]),
    declared: { 'apps/ui/sources/a.test.ts': ['@/gone/one'] },
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /@\/gone\/two/);
});

test('a declared entry that starts resolving is reported as stale', () => {
  const files = [{ filePath: 'apps/ui/sources/a.test.ts', content: "vi.mock('@/back/again', () => ({}));\n" }];
  const issues = collectMockSpecifierIssues(files, {
    rootDir: ROOT,
    moduleExists: existingModules(['/repo/apps/ui/sources/back/again.ts']),
    declared: { 'apps/ui/sources/a.test.ts': ['@/back/again'] },
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /drop the declaration/);
});

test('a declared entry for a deleted test file is reported as stale', () => {
  const issues = collectMockSpecifierIssues([], {
    rootDir: ROOT,
    moduleExists: existingModules([]),
    declared: { 'apps/ui/sources/gone.test.ts': ['@/whatever'] },
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /no longer exists/);
});
