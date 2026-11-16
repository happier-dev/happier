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

test('retains dynamically selected native PTY providers without emitted imports', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-pty-runtime-capture-' });
  const repo = fixture.path('repo');
  const cli = join(repo, 'apps/cli');
  const ids = ['node-pty', '@homebridge/node-pty-prebuilt-multiarch'];
  await mkdir(cli, { recursive: true });
  await writeFile(join(cli, 'package.json'), JSON.stringify({ optionalDependencies: Object.fromEntries(ids.map(id => [id, '1.0.0'])) }));
  for (const id of ids) {
    const dir = join(cli, 'node_modules', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: id, main: 'index.cjs' }));
    await writeFile(join(dir, 'index.cjs'), 'exports.backend = ' + JSON.stringify(id) + ';');
  }
  const outputDir = fixture.path('capture');
  captureRuntimeDependencies({ imports: [], outputDir, sourceRepoDir: repo });
  await rm(repo, { recursive: true });
  const require = createRequire(join(outputDir, 'apps/cli/package.json'));
  for (const id of ids) assert.equal(require(id).backend, id);
});

test('retains Transformers Node Common separately from its Web Common after capture', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-transformers-common-capture-' });
  const repo = fixture.path('repo');
  const cli = join(repo, 'apps/cli');
  const transformers = join(cli, 'node_modules/@huggingface/transformers');
  const node = join(transformers, 'node_modules/onnxruntime-node');
  const web = join(transformers, 'node_modules/onnxruntime-web');
  const packageAt = async (directory, manifest, code) => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ main: 'index.cjs', ...manifest }));
    await writeFile(join(directory, 'index.cjs'), code);
  };
  await packageAt(join(node, 'node_modules/onnxruntime-common'), { name: 'onnxruntime-common', version: '1.21.0' }, 'exports.runtime = "node common";');
  await packageAt(join(web, 'node_modules/onnxruntime-common'), { name: 'onnxruntime-common', version: '1.22.0' }, 'exports.runtime = "web common";');
  await packageAt(node, { name: 'onnxruntime-node', version: '1.21.0', dependencies: { 'onnxruntime-common': '1.21.0' } }, 'module.exports = require("onnxruntime-common");');
  await packageAt(web, { name: 'onnxruntime-web', version: '1.22.0', dependencies: { 'onnxruntime-common': '1.22.0' } }, 'module.exports = require("onnxruntime-common");');
  await mkdir(join(transformers, 'dist'));
  await writeFile(join(transformers, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', version: '3.8.1', type: 'module', dependencies: {
    'onnxruntime-node': '1.21.0', 'onnxruntime-web': '1.22.0',
  } }));
  // The real 3.8.1 Node entry imports Common without declaring it; the existing
  // vendoring rule chooses Node's declared Common rather than Web's version.
  await writeFile(join(transformers, 'dist/transformers.node.mjs'), 'import common from "onnxruntime-common"; import web from "onnxruntime-web"; export const runtimes = [common.runtime, web.runtime];');
  await writeFile(join(cli, 'package.json'), JSON.stringify({ dependencies: { '@huggingface/transformers': '3.8.1' } }));
  const outputDir = fixture.path('capture');
  captureRuntimeDependencies({ imports: [], outputDir, sourceRepoDir: repo });
  await rm(repo, { recursive: true });
  const require = createRequire(join(outputDir, 'apps/cli/package.json'));
  const captured = await import(pathToFileURL(require.resolve('@huggingface/transformers/dist/transformers.node.mjs')).href);
  assert.deepEqual(captured.runtimes, ['node common', 'web common']);
});
