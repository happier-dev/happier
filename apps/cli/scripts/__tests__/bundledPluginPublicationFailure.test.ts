import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it as test } from 'vitest';

import { assertHostCanExcludeBundledPlugin, createBundledPluginPublicationFailure, readBundledPluginPublicationFailures, writeBundledPluginPublicationFailures } from '../../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';
import { BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES, REQUIRED_BUNDLED_PLUGIN_PACKAGES, classifyBundledPluginPublicationFailures, parseBundledPluginPublicationFailures, readBundledPluginUiArtifactsDigest } from '../../../../packages/cli-common/bundledPluginPublicationPolicy.mjs';

test.each([
  ['cliproxyapi', 'happier.provider.cliproxyapi'],
  ['claude', 'happier.agent.claude'],
])('isolates %s publication failures after migrating its host imports', (packageId, pluginId) => {
  const packageName = `@happier-dev/plugins-${packageId}`;
  const failure = createBundledPluginPublicationFailure({
    repoRoot: '', packageName, pluginId,
    error: new Error('plugin publication failed'),
  });
  assert.deepEqual(failure, {
    packageName, pluginId,
    diagnostic: { code: 'plugin_package_build_failed', message: 'plugin publication failed' },
  });
});

test.each(['codex', 'elevenlabs', 'openai', 'xai'])(
  'keeps %s publication fatal while consumed generated imports remain', (packageId) => {
    assert.throws(() => createBundledPluginPublicationFailure({
      repoRoot: '', packageName: `@happier-dev/plugins-${packageId}`, pluginId: `happier.${packageId}`,
      error: new Error('plugin publication failed'),
    }), /required by host code/);
  },
);

test('a UI record carries the graph it evaluated and a later publication supersedes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-ui-record-scope-'));
  try {
    const pluginRoot = join(root, 'packages', 'plugins', 'codex');
    const created = createBundledPluginPublicationFailure({
      repoRoot: root, packageName: '@happier-dev/plugins-codex', pluginId: 'happier.agent.codex',
      code: 'plugin_ui_artifact_invalid', error: new Error('Bundled Plugin UI artifact manifest is missing'),
    });
    const [record] = parseBundledPluginPublicationFailures(JSON.stringify([created]));
    assert.equal(record!.uiArtifactsDigest, null);
    const classifyNow = () => classifyBundledPluginPublicationFailures([record!],
      () => readBundledPluginUiArtifactsDigest(pluginRoot));
    // Same graph: the required package is retained (reported), never withdrawn or fatal.
    assert.deepEqual(classifyNow(), { withdrawn: [], superseded: [], retained: [record] });
    mkdirSync(join(pluginRoot, 'dist', 'happier-plugin-ui'), { recursive: true });
    writeFileSync(join(pluginRoot, 'dist', 'happier-plugin-ui', 'ui-artifacts.json'), '{"version":2,"entries":[]}');
    assert.deepEqual(classifyNow(), { withdrawn: [], superseded: [record], retained: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one publication diagnostic code set validates persisted failures', () => {
  assert.deepEqual(BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES, [
    'plugin_package_build_failed', 'plugin_manifest_invalid', 'plugin_ui_artifact_invalid',
  ]);
  for (const code of BUNDLED_PLUGIN_PUBLICATION_DIAGNOSTIC_CODES) {
    assert.equal(parseBundledPluginPublicationFailures(JSON.stringify([{
      packageName: '@happier-dev/plugins-inspector', pluginId: 'happier.inspector',
      diagnostic: { code, message: 'failure' },
    }]))[0]!.diagnostic.code, code);
  }
});

test('required plugin admission follows the reviewed host dependency set, not comments or testkits', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-required-plugin-'));
  try {
    mkdirSync(join(root, 'apps', 'cli', 'src', 'dev', 'testkit'), { recursive: true });
    writeFileSync(join(root, 'apps', 'cli', 'src', 'dev', 'testkit', 'fixture.ts'),
      "import '@happier-dev/plugins-inspector';\n");
    writeFileSync(join(root, 'apps', 'cli', 'src', 'comment.ts'),
      "// import '@happier-dev/plugins-inspector';\n");
    assert.doesNotThrow(() => assertHostCanExcludeBundledPlugin(root, '@happier-dev/plugins-inspector'));
    assert.doesNotThrow(() => assertHostCanExcludeBundledPlugin(root, '@happier-dev/plugins-channels'));
    assert.doesNotThrow(() => assertHostCanExcludeBundledPlugin(root, '@happier-dev/plugins-triage'));
    assert.throws(() => assertHostCanExcludeBundledPlugin(root, '@happier-dev/plugins-openai'), /required by host code/);
    assert.throws(() => assertHostCanExcludeBundledPlugin(root, '@happier-dev/plugins-xai'), /required by host code/);
    const original = new Error('the package export is missing');
    assert.throws(
      () => assertHostCanExcludeBundledPlugin(root, '@happier-dev/plugins-codex', original),
      (error: unknown) => error instanceof Error && error.cause === original && /the package export is missing/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoped publication replaces only evaluated packages and preserves unrelated failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-scoped-failures-'));
  const failure = (id: string) => ({
    packageName: `@happier-dev/plugins-${id}`, pluginId: `happier.${id}`,
    diagnostic: { code: 'plugin_manifest_invalid' as const, message: `${id} cannot publish` },
  });
  try {
    writeBundledPluginPublicationFailures(root, [failure('a'), failure('b')]);
    writeBundledPluginPublicationFailures(root, [], ['@happier-dev/plugins-b']);
    assert.deepEqual(readBundledPluginPublicationFailures(root), [failure('a')]);
    writeBundledPluginPublicationFailures(root, [failure('b')], ['@happier-dev/plugins-b']);
    assert.deepEqual(readBundledPluginPublicationFailures(root), [failure('a'), failure('b')]);
    writeBundledPluginPublicationFailures(root, []);
    assert.deepEqual(readBundledPluginPublicationFailures(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('required-plugin policy equals host value imports including executable Voice projections', () => {
  // Compiler API parses real imports; comments, type-only imports and test fixtures
  // cannot turn an optional package into a host runtime requirement.
  const ts: typeof import('typescript') = createRequire(import.meta.url)('typescript');
  const repoRoot = new URL('../../../../', import.meta.url);
  const imports = new Map<string, string>();
  function visitDirectory(directory: URL): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
      if (entry.isDirectory()) {
        if (!['testkit', '__tests__', '__mocks__'].includes(entry.name)) visitDirectory(path);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /(?:\.test\.|\.spec\.|\.d\.[cm]?ts$)/.test(entry.name)) continue;
      const source = readFileSync(path, 'utf8');
      if (!source.includes('@happier-dev/plugins-')) continue;
      const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
      for (const statement of ast.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
            && statement.exportClause.elements.every((element) => element.isTypeOnly)) continue;
        const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
        if (clause?.isTypeOnly) continue;
        if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
            && clause.namedBindings.elements.every((element) => element.isTypeOnly)) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const packageName = specifier.text.match(/^@happier-dev\/plugins-[^/]+/)?.[0];
        if (packageName) imports.set(packageName, path.pathname);
      }
    }
  }
  for (const root of ['apps/cli/src/', 'apps/ui/sources/', 'packages/cli-common/src/']) {
    visitDirectory(new URL(root, repoRoot));
  }
  assert.ok(imports.size > 0);
  for (const [packageName, path] of imports) {
    assert.throws(() => assertHostCanExcludeBundledPlugin('', packageName), /required by host code/, path);
  }
  assert.deepEqual([...REQUIRED_BUNDLED_PLUGIN_PACKAGES].sort(), [...imports.keys()].sort());
});
