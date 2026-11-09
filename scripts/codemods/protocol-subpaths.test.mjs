import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { applyMigration, buildExportMap, inputFiles, transformImports } from './protocol-subpaths.mjs';

const mapping = new Map([
  ['Value', { specifier: '@happier-dev/protocol/value', name: 'Value' }],
  ['Shape', { specifier: '@happier-dev/protocol/shape', name: 'Shape' }],
]);
const ts = createRequire(import.meta.url)('typescript');

test('write mode requires explicit selected input files', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-protocol-selection-' });
  await mkdir(fixture.path('apps/ui/sources'), { recursive: true });
  const source = "import { Value } from '@happier-dev/protocol';\nexport const selected = Value;\n";
  await writeFile(fixture.path('apps/ui/sources/selected.ts'), source);
  await writeFile(fixture.path('apps/ui/sources/other.ts'), source);
  assert.throws(() => inputFiles(fixture.root, ['--write']), /explicit.*--file/);
  const selected = inputFiles(fixture.root, ['--write', '--file=apps/ui/sources/selected.ts']);
  assert.deepEqual(selected, [fixture.path('apps/ui/sources/selected.ts')]);
  assert.equal(applyMigration(selected[0], source, mapping).written, true);
  assert.equal(readFileSync(selected[0], 'utf8'), source.replace("'@happier-dev/protocol'", "'@happier-dev/protocol/value'"));
  assert.equal(readFileSync(fixture.path('apps/ui/sources/other.ts'), 'utf8'), source);
  assert.equal(applyMigration(selected[0], readFileSync(selected[0], 'utf8'), mapping).written, false);
});

test('invalid proposed syntax preserves original file bytes', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-protocol-syntax-' });
  const file = fixture.path('source.ts');
  const source = "import { Value } from '@happier-dev/protocol';\n";
  await writeFile(file, source);
  const invalidMapping = new Map([['Value', { specifier: '@happier-dev/protocol/value', name: '}' }]]);
  const result = applyMigration(file, source, invalidMapping);
  assert.equal(readFileSync(file, 'utf8'), source);
  assert.ok(result.unresolved.some(issue => issue.kind === 'invalid-output-syntax'));
});

test('changed input is skipped rather than overwritten from an earlier read', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-protocol-concurrent-' });
  const file = fixture.path('source.ts');
  const source = "import { Value } from '@happier-dev/protocol';\n";
  const concurrent = `${source}export const anotherLanesWork = true;\n`;
  await writeFile(file, concurrent);
  const result = applyMigration(file, source, mapping);
  assert.equal(readFileSync(file, 'utf8'), concurrent);
  assert.ok(result.unresolved.some(issue => issue.kind === 'input-changed'));
  assert.deepEqual(readdirSync(fixture.root), ['source.ts']);
});

test('input changed during transform is preserved at the atomic rename boundary', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-protocol-rename-' });
  const file = fixture.path('source.ts');
  const source = "import { Value } from '@happier-dev/protocol';\n";
  const concurrent = `${source}export const anotherLanesWork = true;\n`;
  await writeFile(file, source);
  // A real competing filesystem write while an export-map entry is consumed.
  const target = { get specifier() { writeFileSync(file, concurrent); return '@happier-dev/protocol/value'; }, name: 'Value' };
  const result = applyMigration(file, source, new Map([['Value', target]]));
  assert.equal(readFileSync(file, 'utf8'), concurrent);
  assert.ok(result.unresolved.some(issue => issue.kind === 'input-changed'));
  assert.deepEqual(readdirSync(fixture.root), ['source.ts']);
});

test('places a renamed bare binding alias before its trailing comma and comments', () => {
  const renamed = new Map([['StrictJsonValue', { specifier: '@happier-dev/protocol/json/strictJsonValue', name: 'JsonValue' }]]);
  for (const keyword of ['import', 'export']) {
    const source = `${keyword} type {\n  StrictJsonValue, /* retained */\n} from '@happier-dev/protocol';\n`;
    const result = transformImports(source, 'sample.ts', renamed);
    const ast = ts.createSourceFile('sample.ts', result.source, ts.ScriptTarget.Latest, true);
    assert.deepEqual(ast.parseDiagnostics.map(diagnostic => diagnostic.messageText), []);
    assert.deepEqual(result.unresolved, []);
    const statement = ast.statements[0];
    const bindings = keyword === 'import' ? statement.importClause.namedBindings : statement.exportClause;
    assert.equal(bindings.elements[0].propertyName.text, 'JsonValue');
    assert.equal(bindings.elements[0].name.text, 'StrictJsonValue');
    assert.ok(result.source.includes('/* retained */'));
  }
});

test('splits protocol imports preserving aliases, type-only bindings and comments', () => {
  const source = `// owner comment
import { /* value comment */ Value as Local, type Shape } from '@happier-dev/protocol'; // trailing
import type { Shape as Alias } from "@happier-dev/protocol";
export const value: Shape = Local;
`;
  const result = transformImports(source, 'sample.ts', mapping);
  assert.deepEqual(result.unresolved, []);
  assert.match(result.source, /\/\* value comment \*\/ Value as Local.*from '@happier-dev\/protocol\/value'/);
  assert.match(result.source, /type Shape.*from '@happier-dev\/protocol\/shape'/);
  assert.match(result.source, /import type \{ Shape as Alias \} from "@happier-dev\/protocol\/shape"/);
  assert.ok(result.source.startsWith('// owner comment\n'));
  assert.ok(result.source.includes('// trailing'));
  assert.ok(result.source.endsWith('export const value: Shape = Local;\n'));
  assert.equal(transformImports(result.source, 'sample.ts', mapping).source, result.source);
});

test('unknown exports and non-named root imports are reported without guessing', () => {
  for (const source of [
    "import { Unknown } from '@happier-dev/protocol';",
    "import * as Protocol from '@happier-dev/protocol';",
    "const protocol = import('@happier-dev/protocol');",
  ]) {
    const result = transformImports(source, 'sample.ts', mapping);
    assert.ok(result.unresolved.length > 0);
    assert.equal(result.source, source);
  }
});

test('preserves comments between bindings and before the closing brace', () => {
  const source = "import { Value /* retained before comma */, type Shape, /* retained at end */ } from '@happier-dev/protocol';";
  const result = transformImports(source, 'sample.ts', mapping);
  assert.ok(result.source.includes('/* retained before comma */'));
  assert.ok(result.source.includes('/* retained at end */'));
});

test('narrows type queries and awaited destructuring at their original demand point', () => {
  const source = `type Alias = import('@happier-dev/protocol').Shape;
async function load() {
  const { Value: local, Shape } = await import('@happier-dev/protocol');
  return [local, Shape];
}`;
  const result = transformImports(source, 'sample.ts', mapping);
  assert.deepEqual(result.unresolved, []);
  assert.ok(result.source.includes("import('@happier-dev/protocol/shape').Shape"));
  assert.ok(result.source.includes("await Promise.all([import('@happier-dev/protocol/value'), import('@happier-dev/protocol/shape')])"));
  assert.match(result.source, /\{\s*Value: local\s*\}/);
});

test('resolves renamed exports to the same declaration and prefers the published leaf', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'happier-protocol-subpaths-' });
  await mkdir(fixture.path('packages/protocol/src'), { recursive: true });
  await writeFile(fixture.path('packages/protocol/package.json'), JSON.stringify({ exports: {
    '.': { 'happier-source': './src/index.ts' },
    './domain': { 'happier-source': './src/domain.ts' },
    './leaf': { 'happier-source': './src/leaf.ts' },
  } }));
  await writeFile(fixture.path('packages/protocol/src/index.ts'), "export { Original as Value } from './leaf.js';");
  await writeFile(fixture.path('packages/protocol/src/domain.ts'), "export * from './leaf.js';");
  await writeFile(fixture.path('packages/protocol/src/leaf.ts'), 'export const Original = {};');
  const result = buildExportMap(fixture.root);
  assert.equal(result.mapping.get('Value').specifier, '@happier-dev/protocol/leaf');
  assert.equal(result.mapping.get('Value').name, 'Original');
  assert.ok(result.mapping.get('Value').identity.endsWith('/src/leaf.ts#Original'));
  assert.equal(transformImports("import { Value as Local } from '@happier-dev/protocol';", 'sample.ts', result.mapping).source,
    "import { Original as Local } from '@happier-dev/protocol/leaf';");
});

test('keeps Vitest importActual semantics when narrowing its typed destructuring', () => {
  const source = "const { Value: local } = await vi.importActual<typeof import('@happier-dev/protocol')>('@happier-dev/protocol');";
  const result = transformImports(source, 'sample.ts', mapping);
  assert.deepEqual(result.unresolved, []);
  assert.ok(result.source.includes("vi.importActual<typeof import('@happier-dev/protocol/value')>('@happier-dev/protocol/value')"));
  assert.ok(result.source.includes('Value: local'));
});

test('retains comments in dynamically imported bindings', () => {
  const source = "const { /* before */ Value, Shape /* after */, } = await import('@happier-dev/protocol');";
  const result = transformImports(source, 'sample.ts', mapping);
  assert.deepEqual(result.unresolved, []);
  assert.ok(result.source.includes('/* before */'));
  assert.ok(result.source.includes('/* after */'));
  assert.ok(!result.source.includes("'@happier-dev/protocol'"));
});
