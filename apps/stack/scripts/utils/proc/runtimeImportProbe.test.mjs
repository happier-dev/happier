import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { probeRuntimeImport } from './runtimeImportProbe.mjs';

test('entry health is measured in a fresh child for each invocation', async t => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-entry-import-' });
  const entrypoint = fixture.path('entry.mjs');
  const env = { ...process.env, ENTRY_ONCE: 'present' };
  await writeFile(entrypoint, 'if (globalThis.loaded) throw new Error("warm module map"); globalThis.loaded = true;\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await probeRuntimeImport({ entrypoint, env });
    assert.equal(result.status, 'passed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.loadError, null);
  }
  await writeFile(entrypoint, "import { missing } from './leaf.mjs'; console.log(missing);\n");
  await writeFile(fixture.path('leaf.mjs'), 'export const present = true;\n');
  const result = await probeRuntimeImport({ entrypoint, env });
  assert.equal(result.status, 'failed');
  assert.equal(result.firstFailingModule, entrypoint);
  assert.equal(result.loadError.name, 'SyntaxError');
  assert.match(result.loadError.message, /does not provide an export/);
});

test('entry loads preserve cancellation and distinguish spawn failure', async t => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-entry-cancel-' });
  const entrypoint = fixture.path('entry.mjs');
  await writeFile(entrypoint, 'setInterval(() => {}, 1000);\n');
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  const pending = probeRuntimeImport({ entrypoint, signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  const missing = await probeRuntimeImport({ entrypoint, nodeExecutable: fixture.path('absent-runtime') });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.loadError.code, 'ENOENT');
});

test('browser VM failures identify the evaluated module rather than a caller frame', async t => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-entry-browser-' });
  const entrypoint = fixture.path('entry.mjs');
  const source = 'throw new ReferenceError("missing browser global")';
  await writeFile(entrypoint, `import { runInNewContext } from "node:vm"; runInNewContext(${JSON.stringify(source)});\n`);
  const result = await probeRuntimeImport({ entrypoint });
  assert.equal(result.status, 'failed');
  assert.equal(result.loadError.name, 'ReferenceError');
  assert.equal(result.firstFailingModule, 'evalmachine.<anonymous>');
});

test('loader diagnostics identify an inline parse failure before the loader stack', async t => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-entry-inline-location-' });
  const entrypoint = fixture.path('entry.mjs');
  const failingModule = fixture.path('failing-source.ts');
  const diagnostic = `${fixture.path('loader.mjs')}:3\nthrow error;\n\nError: Parse error ${failingModule}:2:17\n`;
  await writeFile(entrypoint, `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(1);`);
  const result = await probeRuntimeImport({ entrypoint });
  assert.equal(result.firstFailingModule, failingModule);
});

test('a missing import identifies its importing module through the entry graph', async t => {
  const fixture = await createTempFixture(t, { prefix: 'runtime-entry-missing-import-' });
  const entrypoint = fixture.path('entry.mjs');
  const importer = fixture.path('importer.mjs');
  await writeFile(entrypoint, 'import "./importer.mjs";');
  await writeFile(importer, 'import "./absent-module.mjs";');
  const result = await probeRuntimeImport({ entrypoint });
  assert.equal(result.status, 'failed');
  assert.equal(result.firstFailingModule, importer);
});
