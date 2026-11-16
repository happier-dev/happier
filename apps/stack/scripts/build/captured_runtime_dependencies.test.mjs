// @happier-test-preparation source
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { captureRuntimeDependencies } from './captured_runtime_dependencies.mjs';

test('retains the dynamically required recording encoder without an emitted import', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-recording-runtime-capture-' });
  const repo = fixture.path('repo');
  const cli = join(repo, 'apps/cli');
  const encoder = join(cli, 'node_modules/ffmpeg-static');
  await mkdir(encoder, { recursive: true });
  await writeFile(join(cli, 'package.json'), JSON.stringify({ dependencies: { 'ffmpeg-static': '1.0.0' } }));
  await writeFile(join(encoder, 'package.json'), JSON.stringify({ name: 'ffmpeg-static', main: 'index.cjs' }));
  await writeFile(join(encoder, 'index.cjs'), 'module.exports = require("node:path").join(__dirname, "encoder.cjs");');
  // A portable executable fixture exercises the retained package asset at the OS boundary.
  await writeFile(join(encoder, 'encoder.cjs'), 'process.stdout.write("ffmpeg version captured-fixture\\n");');
  const outputDir = fixture.path('capture');
  captureRuntimeDependencies({ imports: [], outputDir, sourceRepoDir: repo });
  const chunk = join(outputDir, 'apps/cli/src/chunks/recording.mjs');
  await mkdir(join(outputDir, 'apps/cli/src/chunks'), { recursive: true });
  await writeFile(chunk, 'import { createRequire } from "node:module"; export const encoder = createRequire(import.meta.url)("ffmpeg-static");');
  await rm(repo, { recursive: true });
  const captured = await import(pathToFileURL(chunk).href);
  assert.equal(execFileSync(process.execPath, [captured.encoder], { encoding: 'utf8' }), 'ffmpeg version captured-fixture\n');
});

test('retains Sharp native-library lookup after capturing its package dependencies', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-sharp-runtime-capture-' });
  const repo = fixture.path('repo');
  const cli = join(repo, 'apps/cli');
  const sharp = join(cli, 'node_modules/sharp');
  const native = join(sharp, 'node_modules/@img/sharp-linux-x64');
  const libvips = join(sharp, 'node_modules/@img/sharp-libvips-linux-x64');
  await mkdir(join(native, 'lib'), { recursive: true });
  await mkdir(join(libvips, 'lib'), { recursive: true });
  await writeFile(join(cli, 'package.json'), JSON.stringify({ dependencies: { sharp: '0.35.5' } }));
  await writeFile(join(sharp, 'package.json'), JSON.stringify({ name: 'sharp', main: 'index.cjs', optionalDependencies: {
    '@img/sharp-linux-x64': '0.35.5', '@img/sharp-libvips-linux-x64': '1.3.4',
  } }));
  await writeFile(join(sharp, 'index.cjs'), 'module.exports = require("@img/sharp-linux-x64");');
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: '@img/sharp-linux-x64', main: 'index.cjs', optionalDependencies: {
    '@img/sharp-libvips-linux-x64': '1.3.4',
  } }));
  await writeFile(join(native, 'index.cjs'), 'require.resolve("@img/sharp-libvips-linux-x64/binary"); module.exports = require("./lib/sharp.cjs");');
  // Replace only the native loader boundary. These generic RPATHs come from the
  // loaded 0.35.5 addon: Node package links alone cannot satisfy its library lookup.
  await writeFile(join(native, 'lib/sharp.cjs'), `
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
for (const relative of [
  '../../sharp-libvips-linux-x64/lib',
  '../../../sharp-libvips-linux-x64/1.3.4/lib',
  '../../node_modules/@img/sharp-libvips-linux-x64/lib',
  '../../../node_modules/@img/sharp-libvips-linux-x64/lib',
]) {
  try {
    module.exports = readFileSync(join(__dirname, relative, 'libvips-cpp.so.8.18.7'), 'utf8');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
throw Object.assign(new Error('libvips-cpp.so.8.18.7 cannot be loaded'), { code: 'ERR_DLOPEN_FAILED' });
`);
  await writeFile(join(libvips, 'package.json'), JSON.stringify({ name: '@img/sharp-libvips-linux-x64', exports: {
    './binary': './lib/libvips-cpp.so.8.18.7',
  } }));
  await writeFile(join(libvips, 'lib/libvips-cpp.so.8.18.7'), 'captured Sharp image');
  assert.equal(createRequire(join(cli, 'package.json'))('sharp'), 'captured Sharp image');
  const outputDir = fixture.path('capture');
  captureRuntimeDependencies({ imports: [{ path: 'sharp', resolveFrom: join(cli, 'package.json') }], outputDir, sourceRepoDir: repo });
  await rm(repo, { recursive: true });
  assert.equal(createRequire(join(outputDir, 'apps/cli/package.json'))('sharp'), 'captured Sharp image');
});

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
