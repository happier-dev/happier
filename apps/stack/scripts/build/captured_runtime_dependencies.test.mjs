// @happier-test-preparation source
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { captureRuntimeDependencies } from './captured_runtime_dependencies.mjs';

test('captures dynamically resolved optional runtimes and their native dependency without an emitted import', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-voice-runtime-capture-' });
  const repo = fixture.path('repo');
  const cli = join(repo, 'apps/cli');
  const modules = join(cli, 'node_modules');
  const sherpa = join(modules, 'sherpa-onnx-node');
  const native = join(modules, 'voice-native-fixture');
  const embeddings = join(modules, '@huggingface/transformers');
  const emitted = join(modules, 'emitted-runtime-fixture');
  await mkdir(sherpa, { recursive: true });
  await mkdir(native);
  await mkdir(join(embeddings, 'dist'), { recursive: true });
  await mkdir(emitted);
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', dependencies: { 'sherpa-onnx-node': '1.12.38', '@huggingface/transformers': '3.0.0' } }));
  await writeFile(join(sherpa, 'package.json'), JSON.stringify({ name: 'sherpa-onnx-node', main: 'sherpa-onnx.js', dependencies: { 'voice-native-fixture': '1.0.0' } }));
  await writeFile(join(sherpa, 'sherpa-onnx.js'), 'module.exports = require("voice-native-fixture");');
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: 'voice-native-fixture', main: 'index.cjs' }));
  await writeFile(join(native, 'index.cjs'), 'exports.runtime = "native voice ready";');
  await writeFile(join(embeddings, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', type: 'module', dependencies: { 'voice-native-fixture': '1.0.0' } }));
  await writeFile(join(embeddings, 'dist/transformers.node.mjs'), 'import native from "voice-native-fixture"; export const runtime = native.runtime;');
  await writeFile(join(emitted, 'package.json'), JSON.stringify({ name: 'emitted-runtime-fixture', main: 'index.cjs' }));
  await writeFile(join(emitted, 'index.cjs'), 'exports.runtime = "emitted ready";');
  const outputDir = fixture.path('capture');
  const captured = captureRuntimeDependencies({
    imports: [{ path: 'emitted-runtime-fixture', resolveFrom: join(cli, 'package.json') }],
    outputDir, sourceRepoDir: repo,
  });
  await rm(repo, { recursive: true });
  const require = createRequire(join(outputDir, 'apps/cli/package.json'));
  assert.deepEqual(require('sherpa-onnx-node/sherpa-onnx.js'), { runtime: 'native voice ready' });
  const memoryRuntime = await import(pathToFileURL(require.resolve('@huggingface/transformers/dist/transformers.node.mjs')).href);
  assert.equal(memoryRuntime.runtime, 'native voice ready');
  assert.deepEqual(require('emitted-runtime-fixture'), { runtime: 'emitted ready' });
  assert.equal(captured.captured, true);
});
